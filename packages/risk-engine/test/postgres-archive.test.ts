import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import {
  createObservation,
  PostgresLiveSnapshotArchive,
  loadDatabaseMigrations,
  parseArchivedSnapshot,
} from "../src/index.js";

const SNAPSHOT_FIXTURE = new URL(
  "../../../.data/live-archive/snapshots/0x5e021de28d509b6bde9fb4649324e4e7be4f11fe75c8f7ee48d6ac96d140d4ed.json",
  import.meta.url,
);

describe("PostgreSQL live archive", () => {
  it("keeps canonical rows immutable while retaining duplicate observations", async () => {
    const migrations = await loadDatabaseMigrations();
    const snapshots = new Map<string, unknown>();
    const observations = new Map<string, {
      observationId: string;
      snapshotHash: string;
      chainId: unknown;
      account: unknown;
      observedBlock: unknown;
      archiveStatus: unknown;
      observedAt: string;
    }>();
    const sql = Object.assign(
      async (strings: TemplateStringsArray, ...values: unknown[]) => {
        const query = strings.join("?").replace(/\s+/g, " ").trim();
        if (query.startsWith("INSERT INTO egress_live_snapshots")) {
          const hash = String(values[0]);
          if (snapshots.has(hash)) return [];
          snapshots.set(hash, JSON.parse(String(values[9])));
          return [{ snapshot_hash: hash }];
        }
        if (query.startsWith("INSERT INTO egress_live_snapshot_observations")) {
          const observationId = String(values[0]);
          if (observations.has(observationId)) return [];
          observations.set(observationId, {
            observationId,
            snapshotHash: String(values[1]),
            chainId: values[2],
            account: values[3],
            observedBlock: values[4],
            archiveStatus: values[5],
            observedAt: String(values[6]),
          });
          return [{ observation_id: observationId }];
        }
        if (query.startsWith("SELECT payload FROM egress_live_snapshots")) {
          const payload = snapshots.get(String(values[0]));
          return payload ? [{ payload }] : [];
        }
        if (query.includes("FROM egress_live_snapshot_observations o")) {
          return [...observations.values()]
            .sort((left, right) => right.observedAt.localeCompare(left.observedAt))
            .slice(0, Number(values[1]))
            .map((observation) => ({
              observation_id: observation.observationId,
              snapshot_hash: observation.snapshotHash,
              observed_at: observation.observedAt,
              payload: snapshots.get(observation.snapshotHash),
            }));
        }
        throw new Error(`Unexpected PostgreSQL archive query: ${query}`);
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
    const archive = new PostgresLiveSnapshotArchive(
      "postgresql://test:test@example.invalid/egress",
      sql as never,
    );
    const snapshot = parseArchivedSnapshot(JSON.parse(await readFile(SNAPSHOT_FIXTURE, "utf8")));

    const first = await archive.archive(snapshot, "2026-08-16T10:00:00.000Z");
    const second = await archive.archive(snapshot, "2026-08-16T10:01:00.000Z");

    expect(first.inserted).toBe(true);
    expect(second.inserted).toBe(false);
    expect(first.observationInserted).toBe(true);
    expect(second.observationInserted).toBe(true);
    expect(await archive.history()).toHaveLength(2);
    expect((await archive.get(snapshot.snapshotHash))?.integrityHash).toBe(snapshot.integrityHash);
    expect(first.entry.observation.observationId).toBe(
      createObservation(snapshot.snapshotHash as `0x${string}`, "2026-08-16T10:00:00.000Z").observationId,
    );
    expect(observations.get(first.entry.observation.observationId)).toMatchObject({
      snapshotHash: snapshot.snapshotHash,
      chainId: snapshot.chainId,
      account: snapshot.account,
      observedBlock: snapshot.observedBlock,
      archiveStatus: snapshot.archiveStatus,
    });
  }, 15_000);
});
