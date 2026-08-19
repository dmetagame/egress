import { describe, expect, it } from "vitest";
import {
  InMemorySourceFetcher,
  InMemoryStore,
  PostgresRevisionStore,
  REPLAY_REVISIONS,
  REPLAY_SOURCE,
  SourceIngestionService,
  loadDatabaseMigrations,
  type SourceDiff,
  type SourceSnapshot,
} from "../src/index.js";

describe("PostgreSQL RWA revision store", () => {
  it("keeps revisions and diffs durable, idempotent, and lifecycle-addressable", async () => {
    const generated = await sourceRevisionFixture();
    const migrations = await loadDatabaseMigrations();
    const revisions = new Map<string, SourceSnapshot>();
    const diffs = new Map<string, SourceDiff>();

    const sql = Object.assign(
      async (strings: TemplateStringsArray, ...values: unknown[]) => {
        const query = strings.join("?").replace(/\s+/g, " ").trim();
        if (query.startsWith("WITH inserted_revision AS")) {
          const snapshot = JSON.parse(String(values[10])) as SourceSnapshot;
          const diff = JSON.parse(String(values[19])) as SourceDiff;
          const inserted = !revisions.has(snapshot.revisionId);
          if (inserted) {
            revisions.set(snapshot.revisionId, structuredClone(snapshot));
            diffs.set(diff.diffId, structuredClone(diff));
          }
          return [{ revision_inserted: inserted, diff_inserted: inserted }];
        }
        if (query.includes("FROM egress_rwa_source_revisions") && query.includes("source_id =")) {
          const sourceId = String(values[0]);
          const latest = [...revisions.values()]
            .filter((revision) => revision.sourceId === sourceId)
            .sort((left, right) => right.sourceVersion - left.sourceVersion)[0];
          return latest ? [{ payload: structuredClone(latest) }] : [];
        }
        if (query.includes("FROM egress_rwa_source_revisions") && query.includes("revision_id =")) {
          const revision = revisions.get(String(values[0]));
          return revision ? [{ payload: structuredClone(revision) }] : [];
        }
        if (query.includes("FROM egress_rwa_source_diffs")) {
          const diff = diffs.get(String(values[0]));
          return diff ? [{ payload: structuredClone(diff) }] : [];
        }
        if (query.startsWith("UPDATE egress_rwa_source_revisions")) {
          const status = values[0] as SourceSnapshot["extractionStatus"];
          const revision = revisions.get(String(values[2]));
          if (!revision) return [];
          revisions.set(revision.revisionId, { ...revision, extractionStatus: status });
          return [{ revision_id: revision.revisionId }];
        }
        throw new Error(`Unexpected PostgreSQL revision query: ${query}`);
      },
      {
        query: async (queryText: string) => {
          if (/SELECT version, name, checksum/i.test(queryText)) {
            return migrations.map((migration) => ({
              version: migration.version,
              name: migration.name,
              checksum: migration.checksum,
              applied_at: "2026-08-16T10:00:00.000Z",
            }));
          }
          throw new Error(`Unexpected migration query: ${queryText}`);
        },
      },
    );
    const store = new PostgresRevisionStore(
      "postgresql://test:test@example.invalid/egress",
      sql as never,
    );

    const first = await store.saveRevision(generated.snapshot, generated.diff);
    await store.updateExtractionStatus(generated.snapshot.revisionId, "ANALYZED");
    const duplicate = await store.saveRevision(generated.snapshot, generated.diff);

    expect(first.inserted).toBe(true);
    expect(duplicate.inserted).toBe(false);
    expect(revisions.size).toBe(1);
    expect(diffs.size).toBe(1);
    expect((await store.latest(REPLAY_SOURCE.id))?.extractionStatus).toBe("ANALYZED");
    expect((await store.getRevision(generated.snapshot.revisionId))?.contentHash)
      .toBe(generated.snapshot.contentHash);
    expect((await store.getDiff(generated.diff.diffId))?.toRevisionId)
      .toBe(generated.snapshot.revisionId);
  });
});

async function sourceRevisionFixture(): Promise<{ snapshot: SourceSnapshot; diff: SourceDiff }> {
  const store = new InMemoryStore();
  const result = await new SourceIngestionService(
    new InMemorySourceFetcher(new Map([[REPLAY_SOURCE.id, {
      rawContent: REPLAY_REVISIONS.A,
      retrievedAt: "2026-08-16T10:00:00.000Z",
    }]])),
    store,
  ).ingest(REPLAY_SOURCE);
  if (result.status !== "CREATED") throw new Error("Expected a generated source revision.");
  return { snapshot: result.snapshot, diff: result.diff };
}
