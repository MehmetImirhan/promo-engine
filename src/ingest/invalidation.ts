/**
 * The ingest → cache hook (ADR §6, §7). Runs once, when a job reaches a
 * terminal status: one version bump per distinct category recorded on the
 * job's chunk rows. Never per row, never per SKU, and never a key delete.
 *
 * A category is on a chunk row when at least one product in it had a real
 * base_price change, or a product entered or left it (RETURNING OLD/NEW in
 * the upsert). Running the hook again for the same job (a PARTIAL job
 * replayed to COMPLETED) re-bumps the same categories, which is harmless.
 */
import { sql } from 'kysely';
import type { CategoryVersions } from '../cache/index.js';
import type { Db } from '../db/index.js';

export class IngestInvalidation {
  constructor(
    private readonly db: Db,
    private readonly versions: CategoryVersions,
  ) {}

  async afterJobFinished(jobId: string): Promise<string[]> {
    const { rows } = await sql<{ category_id: string }>`
      SELECT DISTINCT unnest(changed_category_ids) AS category_id
      FROM ingest_chunks
      WHERE job_id = ${jobId}
    `.execute(this.db);
    const categoryIds = rows.map((r) => r.category_id);
    await this.versions.bump(categoryIds);
    return categoryIds;
  }
}
