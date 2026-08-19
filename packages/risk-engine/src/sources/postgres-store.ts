import { neon } from "@neondatabase/serverless";
import {
  sourceDiffSchema,
  sourceSnapshotSchema,
  type SourceDiff,
  type SourceSnapshot,
} from "../domain/schemas.js";
import { validateDatabaseMigrations } from "../live/database-migrations.js";
import type { RevisionStore, RevisionWriteResult } from "./store.js";

type DatabaseRow = Record<string, unknown>;
type PostgresClient = ReturnType<typeof neon>;

/**
 * Durable source revision storage for the live OKX evidence pipeline.
 *
 * The source payload is retained as JSONB so a later verifier can reconstruct
 * the exact normalized/raw evidence that produced a risk decision. Writes are
 * append-only for revisions and diffs; extraction status is the only mutable
 * lifecycle field.
 */
export class PostgresRevisionStore implements RevisionStore {
  private readonly sql: PostgresClient;
  private initialization: Promise<void> | null = null;

  constructor(databaseUrl: string, sqlClient?: PostgresClient) {
    if (!databaseUrl.trim()) throw new Error("EGRESS_DATABASE_URL is required for PostgreSQL source storage.");
    this.sql = sqlClient ?? neon(databaseUrl);
  }

  async latest(sourceId: string): Promise<SourceSnapshot | null> {
    await this.initialize();
    const rows = await (this.sql`
      SELECT payload
      FROM egress_rwa_source_revisions
      WHERE source_id = ${sourceId}
      ORDER BY source_version DESC, retrieved_at DESC, revision_id DESC
      LIMIT 1
    ` as unknown as Promise<DatabaseRow[]>);
    return rows[0] ? parseSnapshot(rows[0].payload) : null;
  }

  async getRevision(revisionId: string): Promise<SourceSnapshot | null> {
    await this.initialize();
    const rows = await (this.sql`
      SELECT payload
      FROM egress_rwa_source_revisions
      WHERE revision_id = ${revisionId}
      LIMIT 1
    ` as unknown as Promise<DatabaseRow[]>);
    return rows[0] ? parseSnapshot(rows[0].payload) : null;
  }

  async getDiff(diffId: string): Promise<SourceDiff | null> {
    await this.initialize();
    const rows = await (this.sql`
      SELECT payload
      FROM egress_rwa_source_diffs
      WHERE diff_id = ${diffId}
      LIMIT 1
    ` as unknown as Promise<DatabaseRow[]>);
    return rows[0] ? parseDiff(rows[0].payload) : null;
  }

  async saveRevision(snapshot: SourceSnapshot, diff: SourceDiff): Promise<RevisionWriteResult> {
    const parsedSnapshot = sourceSnapshotSchema.parse(snapshot);
    const parsedDiff = sourceDiffSchema.parse(diff);
    assertRevisionRelationship(parsedSnapshot, parsedDiff);
    await this.initialize();

    const resultRows = await (this.sql`
      WITH inserted_revision AS (
        INSERT INTO egress_rwa_source_revisions (
          revision_id, source_id, source_url, source_version, retrieved_at,
          content_hash, raw_content_hash, previous_revision_id, diff_id,
          extraction_status, payload, created_at
        ) VALUES (
          ${parsedSnapshot.revisionId}, ${parsedSnapshot.sourceId}, ${parsedSnapshot.sourceUrl},
          ${parsedSnapshot.sourceVersion}, ${parsedSnapshot.retrievedAt}, ${parsedSnapshot.contentHash},
          ${parsedSnapshot.rawContentHash}, ${parsedSnapshot.previousRevisionId}, ${parsedSnapshot.diffId},
          ${parsedSnapshot.extractionStatus}, ${JSON.stringify(parsedSnapshot)}::jsonb,
          ${parsedSnapshot.retrievedAt}
        )
        ON CONFLICT (revision_id) DO NOTHING
        RETURNING revision_id
      ), inserted_diff AS (
        INSERT INTO egress_rwa_source_diffs (
          diff_id, source_id, from_revision_id, to_revision_id, generated_at,
          diff_kind, cosmetic_only, payload, created_at
        )
        SELECT
          ${parsedDiff.diffId}, ${parsedDiff.sourceId}, ${parsedDiff.fromRevisionId},
          ${parsedDiff.toRevisionId}, ${parsedDiff.generatedAt}, ${parsedDiff.kind},
          ${parsedDiff.cosmeticOnly}, ${JSON.stringify(parsedDiff)}::jsonb,
          ${parsedDiff.generatedAt}
        FROM inserted_revision
        RETURNING diff_id
      )
      SELECT
        EXISTS (SELECT 1 FROM inserted_revision) AS revision_inserted,
        EXISTS (SELECT 1 FROM inserted_diff) AS diff_inserted
    ` as unknown as Promise<DatabaseRow[]>);

    const canonicalSnapshot = await this.getRevision(parsedSnapshot.revisionId);
    if (!canonicalSnapshot) {
      throw new Error(`PostgreSQL source store did not return ${parsedSnapshot.revisionId}.`);
    }
    assertSameRevisionIdentity(canonicalSnapshot, parsedSnapshot);
    if (!canonicalSnapshot.diffId) {
      throw new Error(`Source revision ${canonicalSnapshot.revisionId} has no diff reference.`);
    }
    const canonicalDiff = await this.getDiff(canonicalSnapshot.diffId);
    if (!canonicalDiff) {
      throw new Error(`PostgreSQL source store did not return diff ${canonicalSnapshot.diffId}.`);
    }
    assertRevisionRelationship(canonicalSnapshot, canonicalDiff);

    return {
      snapshot: canonicalSnapshot,
      diff: canonicalDiff,
      inserted: databaseBoolean(resultRows[0]?.revision_inserted),
    };
  }

  async updateExtractionStatus(
    revisionId: string,
    status: SourceSnapshot["extractionStatus"],
  ): Promise<void> {
    await this.initialize();
    const rows = await (this.sql`
      UPDATE egress_rwa_source_revisions
      SET extraction_status = ${status},
          payload = jsonb_set(payload, '{extractionStatus}', to_jsonb(${status}::text), false)
      WHERE revision_id = ${revisionId}
      RETURNING revision_id
    ` as unknown as Promise<DatabaseRow[]>);
    if (rows.length === 0) throw new Error(`Unknown source revision ${revisionId}`);
  }

  private async initialize(): Promise<void> {
    if (!this.initialization) {
      this.initialization = this.validateSchema().catch((error) => {
        this.initialization = null;
        throw error;
      });
    }
    return this.initialization;
  }

  private async validateSchema(): Promise<void> {
    await validateDatabaseMigrations({
      query: (queryText, params) => this.sql.query(queryText, params) as Promise<DatabaseRow[]>,
    });
  }
}

function parseSnapshot(value: unknown): SourceSnapshot {
  return sourceSnapshotSchema.parse(jsonValue(value));
}

function parseDiff(value: unknown): SourceDiff {
  return sourceDiffSchema.parse(jsonValue(value));
}

function assertRevisionRelationship(snapshot: SourceSnapshot, diff: SourceDiff): void {
  if (
    snapshot.sourceId !== diff.sourceId ||
    snapshot.revisionId !== diff.toRevisionId ||
    snapshot.diffId !== diff.diffId ||
    snapshot.previousRevisionId !== diff.fromRevisionId
  ) {
    throw new Error("Source revision and semantic diff relationship is inconsistent.");
  }
}

function assertSameRevisionIdentity(existing: SourceSnapshot, incoming: SourceSnapshot): void {
  if (
    existing.revisionId !== incoming.revisionId ||
    existing.sourceId !== incoming.sourceId ||
    existing.sourceVersion !== incoming.sourceVersion ||
    existing.contentHash !== incoming.contentHash ||
    existing.previousRevisionId !== incoming.previousRevisionId
  ) {
    throw new Error(`Conflicting content for source revision ${incoming.revisionId}.`);
  }
}

function databaseBoolean(value: unknown): boolean {
  return value === true || value === "true" || value === "t";
}

function jsonValue(value: unknown): unknown {
  return typeof value === "string" ? JSON.parse(value) : value;
}
