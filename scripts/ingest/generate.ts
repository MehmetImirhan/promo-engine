/**
 * Vendor CSV generator: N rows of realistic mess, streamed to a file.
 *
 *   npm run ingest:generate -- --rows 500000 --out data/vendor-500k.csv [--seed 42]
 *
 * Mess, all deterministic from the seed:
 *   - duplicate SKUs later in the file with different cost/stock (newest must win)
 *   - malformed rows: short rows, non-numeric cost, negative stock, empty sku
 *   - quoted fields with commas and embedded newlines, UTF-8 names and categories
 *   - occasional blank lines and a surplus column (must parse, not error)
 *
 * The library form (`generateCsv`) can also return the expected final state
 * per SKU after newest-wins, which the end-to-end test uses as its oracle.
 * Nothing here prices anything: cost stays a string; pricing is the
 * pipeline's job.
 */
import { createWriteStream } from 'node:fs';
import { parseArgs } from 'node:util';
import type { Writable } from 'node:stream';
import { z } from 'zod';

export interface GenerateOptions {
  rows: number;
  seed?: number;
  /** Fraction of rows that re-use an earlier SKU. */
  duplicateRate?: number;
  /** Fraction of rows that are malformed. */
  malformedRate?: number;
  skuPrefix?: string;
  /** Keep the expected final state per SKU in memory (tests only; O(rows)). */
  collectExpected?: boolean;
}

export interface ExpectedProduct {
  name: string;
  category: string;
  cost: string;
  stock_quantity: number;
  row_no: number;
}

export interface GenerateSummary {
  rows: number;
  malformed: number;
  duplicates: number;
  distinctSkus: number;
  expected?: Map<string, ExpectedProduct>;
}

const CATEGORIES = [
  'Ayakkabı', 'Giyim', 'Electronics', 'Accessories', 'Ev & Yaşam', 'Spor', 'Çanta', 'Kozmetik', 'Oyuncak', 'Kitap', 'Bahçe', 'Ofis',
];
const WORDS = ['Klasik', 'Şık', 'Günlük', 'Premium', 'Çocuk', 'Ünlü', 'Işıltılı', 'Büyük', 'Küçük', 'Mavi', 'Gri', 'Örgü'];
const NOUNS = ['Tişört', 'Ayakkabı', 'Çanta', 'Şapka', 'Gömlek', 'Kulaklık', 'Şarj Kablosu', 'Defter', 'Bardak', 'Halı'];

/** mulberry32: small, fast, seedable. Not for anything but test data. */
function prng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function csvField(value: string): string {
  return /[",\n\r]/.test(value) ? `"${value.replace(/"/g, '""')}"` : value;
}

async function write(out: Writable, line: string): Promise<void> {
  if (!out.write(line)) await new Promise<void>((resolve) => out.once('drain', resolve));
}

export async function generateCsv(out: Writable, opts: GenerateOptions): Promise<GenerateSummary> {
  const rand = prng(opts.seed ?? 1);
  const pick = <T>(arr: readonly T[]): T => arr[Math.floor(rand() * arr.length)]!;
  const int = (min: number, max: number): number => min + Math.floor(rand() * (max - min + 1));
  const duplicateRate = opts.duplicateRate ?? 0.03;
  const malformedRate = opts.malformedRate ?? 0.005;
  const prefix = opts.skuPrefix ?? 'SKU';
  const expected = opts.collectExpected ? new Map<string, ExpectedProduct>() : undefined;

  let nextSku = 0;
  let malformed = 0;
  let duplicates = 0;

  await write(out, 'sku,name,category,cost,stock_quantity\n');

  for (let rowNo = 1; rowNo <= opts.rows; rowNo++) {
    const isDuplicate = nextSku > 0 && rand() < duplicateRate;
    const skuIndex = isDuplicate ? int(0, nextSku - 1) : nextSku++;
    if (isDuplicate) duplicates++;
    const sku = `${prefix}-${String(skuIndex).padStart(7, '0')}`;

    const name =
      rowNo % 97 === 0
        ? `${pick(WORDS)} ${pick(NOUNS)}, "${pick(WORDS)}" edition`
        : rowNo % 89 === 0
          ? `${pick(WORDS)} ${pick(NOUNS)}\n(iki satır)`
          : `${pick(WORDS)} ${pick(NOUNS)} ${int(1, 999)}`;
    const category = pick(CATEGORIES);
    // Cost >= 4.00 keeps every row above cost after the pricing rules' rounding,
    // so malformed rows are the only expected errors.
    const cost = `${int(4, 999)}.${String(int(0, 99)).padStart(2, '0')}`;
    const stock = int(0, 500);

    let line: string;
    if (rand() < malformedRate) {
      malformed++;
      switch (malformed % 4) {
        case 0:
          line = `${sku},${csvField(name)}`; // short row
          break;
        case 1:
          line = `${sku},${csvField(name)},${category},not-a-price,${stock}`;
          break;
        case 2:
          line = `${sku},${csvField(name)},${category},${cost},-${stock + 1}`;
          break;
        default:
          line = `,${csvField(name)},${category},${cost},${stock}`; // empty sku
      }
    } else {
      line = `${sku},${csvField(name)},${csvField(category)},${cost},${stock}`;
      if (rowNo % 101 === 0) line += ',surplus-column'; // must parse, is ignored
      expected?.set(sku, { name, category, cost, stock_quantity: stock, row_no: rowNo });
    }
    await write(out, line + '\n');
    if (rowNo % 211 === 0) await write(out, '\n'); // blank line: skipped, not a record
  }

  const summary: GenerateSummary = { rows: opts.rows, malformed, duplicates, distinctSkus: nextSku };
  if (expected) summary.expected = expected;
  return summary;
}

const argsSchema = z.object({
  rows: z.coerce.number().int().min(1).max(50_000_000),
  out: z.string().min(1),
  seed: z.coerce.number().int().default(1),
});

async function main(): Promise<void> {
  const { values } = parseArgs({
    options: { rows: { type: 'string', default: '500000' }, out: { type: 'string' }, seed: { type: 'string', default: '1' } },
  });
  const args = argsSchema.parse(values);
  const out = createWriteStream(args.out);
  const summary = await generateCsv(out, { rows: args.rows, seed: args.seed });
  await new Promise<void>((resolve, reject) => out.end((err?: Error | null) => (err ? reject(err) : resolve())));
  process.stdout.write(JSON.stringify({ ...summary, out: args.out }) + '\n');
}

if (process.argv[1] && /generate\.(ts|js)$/.test(process.argv[1])) {
  main().catch((err: unknown) => {
    process.stderr.write(`${err instanceof Error ? err.message : String(err)}\n`);
    process.exit(1);
  });
}
