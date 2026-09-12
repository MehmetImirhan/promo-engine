#!/usr/bin/env bash
# Ingest measurement for ADR §7 (Scenario A).
#
#   npm run ingest:measure                # 500k rows
#   ROWS=100000 npm run ingest:measure    # smaller
#
# What it does:
#   1. builds dist/ and generates a ROWS-row vendor CSV (data/measure/)
#   2. starts the API (node dist/src/server.js) and uploads the file with curl
#   3. starts a split-only worker and a process-chunk-only worker, each under
#      `node --max-old-space-size=128` and /usr/bin/time, the split worker with
#      a deliberately tiny invocation timeout so it must checkpoint and
#      continue several times
#   4. polls GET /ingest/jobs/:id until the job is COMPLETED or PARTIAL
#   5. prints wall time, peak RSS of API / splitter / worker, splitter
#      continuation count, duplicate-chunk count, rows per second
#
# Requires docker compose up (Postgres + Redis) and a migrated DATABASE_URL.
set -euo pipefail
cd "$(dirname "$0")/../.."
export LC_NUMERIC=C

ROWS="${ROWS:-500000}"
PORT="${MEASURE_PORT:-3901}"
SPLIT_TIMEOUT_MS="${SPLIT_TIMEOUT_MS:-1500}"    # forces continuations at 500k rows
SPLIT_RESERVE_MS="${SPLIT_RESERVE_MS:-300}"
CHUNK_SIZE="${INGEST_CHUNK_SIZE:-1000}"
CONCURRENCY="${INGEST_WORKER_CONCURRENCY:-4}"
HEAP_MB="${HEAP_MB:-128}"
OUT_DIR="data/measure"
CSV="$OUT_DIR/vendor-${ROWS}.csv"
BASE="http://127.0.0.1:${PORT}"

mkdir -p "$OUT_DIR"
# Each measured process is `time node ...`; we signal the node child (time
# does not forward signals) and time prints its stats once the child exits.
PIDS=()
stop() { # $1 = pid of the `time` wrapper
  local child
  child=$(pgrep -P "$1" || true)
  [ -n "$child" ] && kill -TERM "$child" 2>/dev/null || true
  wait "$1" 2>/dev/null || true
}
cleanup() { for pid in "${PIDS[@]:-}"; do [ -n "$pid" ] && stop "$pid"; done; }
trap cleanup EXIT

# /usr/bin/time: -l on macOS (bytes), -v on GNU (kbytes). Both print to stderr.
if /usr/bin/time -l true 2>/dev/null; then TIME=(/usr/bin/time -l); RSS_UNIT=bytes
else TIME=(/usr/bin/time -v); RSS_UNIT=kbytes; fi
peak_rss_mb() { # $1 = time output file
  if [ "$RSS_UNIT" = bytes ]; then awk '/maximum resident set size/ {printf "%.1f", $1/1048576}' "$1"
  else awk '/Maximum resident set size/ {printf "%.1f", $6/1024}' "$1"; fi
}
json() { node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{const o=JSON.parse(s);console.log(eval("o"+process.argv[1]))})' "$1"; }

echo "== build"
npm run -s build

echo "== generate ${ROWS} rows → ${CSV}"
GEN=$(node dist/scripts/ingest/generate.js --rows "$ROWS" --out "$CSV" --seed 42)
echo "$GEN"
ls -l "$CSV" | awk '{print "file bytes:", $5}'

echo "== start API on :$PORT"
PORT=$PORT LOG_LEVEL=warn NODE_ENV=production "${TIME[@]}" node --max-old-space-size="$HEAP_MB" dist/src/server.js \
  >"$OUT_DIR/api.log" 2>"$OUT_DIR/api.time" &
PIDS+=($!)
for _ in $(seq 1 50); do curl -sf "$BASE/health" >/dev/null && break; sleep 0.2; done

echo "== upload"
T_UPLOAD0=$(date +%s.%N)
# A fresh vendor id per run: the same file for the same vendor would return the existing job (200).
CREATE=$(curl -sf -F "vendor_id=measure-$(date +%s)" -F "file=@${CSV}" "$BASE/ingest/jobs")
T_UPLOAD1=$(date +%s.%N)
JOB_ID=$(echo "$CREATE" | json .id)
echo "$CREATE"
[ "$(echo "$CREATE" | json .created)" = true ] || { echo "expected a new job (created: true)"; exit 1; }
UPLOAD_S=$(printf "%.2f" "$(echo "$T_UPLOAD1 - $T_UPLOAD0" | bc)")

echo "== start workers (split timeout ${SPLIT_TIMEOUT_MS}ms, chunk ${CHUNK_SIZE}, concurrency ${CONCURRENCY}, heap ${HEAP_MB}MB)"
T0=$(date +%s.%N)
INGEST_INVOCATION_TIMEOUT_MS=$SPLIT_TIMEOUT_MS INGEST_SPLIT_RESERVE_MS=$SPLIT_RESERVE_MS INGEST_CHUNK_SIZE=$CHUNK_SIZE \
  LOG_LEVEL=info NODE_ENV=production "${TIME[@]}" node --max-old-space-size="$HEAP_MB" dist/src/worker.js --only split \
  >"$OUT_DIR/split.log" 2>"$OUT_DIR/split.time" &
SPLIT_PID=$!; PIDS+=($SPLIT_PID)
INGEST_CHUNK_SIZE=$CHUNK_SIZE INGEST_WORKER_CONCURRENCY=$CONCURRENCY \
  LOG_LEVEL=info NODE_ENV=production "${TIME[@]}" node --max-old-space-size="$HEAP_MB" dist/src/worker.js --only process-chunk \
  >"$OUT_DIR/process.log" 2>"$OUT_DIR/process.time" &
PROC_PID=$!; PIDS+=($PROC_PID)

echo "== wait for job $JOB_ID"
STATUS=PENDING
for _ in $(seq 1 1800); do
  BODY=$(curl -sf "$BASE/ingest/jobs/$JOB_ID")
  STATUS=$(echo "$BODY" | json .status)
  case "$STATUS" in COMPLETED|PARTIAL|FAILED) break;; esac
  sleep 1
done
T1=$(date +%s.%N)
echo "$BODY"

stop "$SPLIT_PID"; stop "$PROC_PID"; stop "${PIDS[0]}"
PIDS=()

PIPELINE_S=$(printf "%.2f" "$(echo "$T1 - $T0" | bc)")
TOTAL_S=$(printf "%.2f" "$(echo "$T1 - $T_UPLOAD0" | bc)")
SPLIT_INVOCATIONS=$(echo "$BODY" | json .split_invocations)
CHUNKS_TOTAL=$(echo "$BODY" | json .chunks.total)
CHUNKS_DONE=$(echo "$BODY" | json .chunks.DONE)
ROWS_TOTAL=$(echo "$BODY" | json .rows.total)
ROWS_INVALID=$(echo "$BODY" | json .rows.invalid)
ROWS_APPLIED=$(echo "$BODY" | json .rows.applied)
EXPECTED_CHUNKS=$(( (ROWS + CHUNK_SIZE - 1) / CHUNK_SIZE ))
CLAIM_REJECTED=$(grep -c 'not claimable' "$OUT_DIR/process.log" || true)
RETRIED=$(node -e '
  import("pg").then(async ({default: pg}) => {
    const c = new pg.Client({ connectionString: process.env.DATABASE_URL ?? "postgres://promo:promo@localhost:5432/promo" });
    await c.connect();
    const r = await c.query("SELECT count(*)::int AS n FROM ingest_chunks WHERE job_id = $1 AND attempts > 1", [process.argv[1]]);
    console.log(r.rows[0].n); await c.end();
  })' "$JOB_ID")

cat <<REPORT

================ ingest measurement (${ROWS} rows) ================
job                       $JOB_ID  → $STATUS
file                      $(ls -l "$CSV" | awk '{printf "%.1f MB", $5/1048576}')
upload (curl → 202)       ${UPLOAD_S}s
pipeline (202 → $STATUS)  ${PIPELINE_S}s
wall time (upload start → $STATUS)  ${TOTAL_S}s
rows/sec (pipeline)       $(echo "scale=0; $ROWS / $PIPELINE_S" | bc)
rows/sec (incl. upload)   $(echo "scale=0; $ROWS / $TOTAL_S" | bc)

peak RSS  api             $(peak_rss_mb "$OUT_DIR/api.time") MB   (node heap cap ${HEAP_MB} MB)
peak RSS  splitter        $(peak_rss_mb "$OUT_DIR/split.time") MB
peak RSS  chunk worker    $(peak_rss_mb "$OUT_DIR/process.time") MB   (concurrency ${CONCURRENCY})

splitter invocations      $SPLIT_INVOCATIONS   (continuations: $((SPLIT_INVOCATIONS - 1)), timeout ${SPLIT_TIMEOUT_MS}ms)
chunks                    $CHUNKS_TOTAL total / $CHUNKS_DONE done   (expected $EXPECTED_CHUNKS)
rows                      $ROWS_TOTAL split / $ROWS_INVALID invalid / $ROWS_APPLIED applied   (generated $ROWS)
duplicate chunks          $(( CHUNKS_TOTAL - EXPECTED_CHUNKS )) extra chunk rows, $CLAIM_REJECTED duplicate deliveries rejected by claim, $RETRIED chunks processed more than once
=====================================================================
logs: $OUT_DIR/{api,split,process}.log, time: $OUT_DIR/*.time
REPORT

[ "$STATUS" = COMPLETED ] && [ "$CHUNKS_TOTAL" -eq "$EXPECTED_CHUNKS" ] && [ "$ROWS_TOTAL" -eq "$ROWS" ] && [ "$RETRIED" -eq 0 ]
