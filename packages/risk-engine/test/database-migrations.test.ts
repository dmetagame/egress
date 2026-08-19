import { describe, expect, it } from "vitest";
import {
  loadDatabaseMigrations,
  migrateDatabaseWithClient,
  migrationChecksum,
  splitMigrationStatements,
  validateDatabaseMigrations,
} from "../src/index.js";

class FakeMigrationClient {
  applied: Array<Record<string, unknown>> = [];
  transactions: string[][] = [];

  async query(queryText: string): Promise<readonly Record<string, unknown>[]> {
    if (/SELECT version, name, checksum/i.test(queryText)) return this.applied;
    return [];
  }

  async runTransaction(statements: readonly { queryText: string; params?: unknown[] }[]): Promise<void> {
    this.transactions.push(statements.map((statement) => statement.queryText));
    const insert = statements.at(-1);
    if (insert?.params) {
      this.applied.push({
        version: insert.params[0],
        name: insert.params[1],
        checksum: insert.params[2],
        applied_at: insert.params[3],
      });
    }
  }
}

describe("PostgreSQL migration contract", () => {
  it("loads ordered checksummed migrations and splits only explicit statements", async () => {
    const migrations = await loadDatabaseMigrations();
    expect(migrations.map((migration) => migration.version)).toEqual([1, 2, 3, 4]);
    for (const migration of migrations) {
      expect(migration.checksum).toBe(migrationChecksum(migration.sql));
    }
    expect(splitMigrationStatements(migrations[0]?.sql ?? "").length).toBeGreaterThan(10);
    expect(splitMigrationStatements(migrations[1]?.sql ?? "").length).toBeGreaterThan(5);
    expect(migrations[1]?.sql).toContain("egress_rwa_source_revisions");
    expect(migrations[1]?.sql).toContain("egress_rwa_source_diffs");
    expect(splitMigrationStatements(migrations[2]?.sql ?? "").length).toBeGreaterThan(10);
    expect(migrations[2]?.sql).toContain("egress_execution_staging_intents");
    expect(migrations[2]?.sql).toContain("egress_execution_staging_simulations");
    expect(migrations[2]?.sql).toContain("egress_execution_staging_submissions");
    expect(migrations[2]?.sql).toContain("egress_execution_worker_events");
    expect(splitMigrationStatements(migrations[3]?.sql ?? "").length).toBeGreaterThan(3);
    expect(migrations[3]?.sql).toContain("execution_fingerprint");
    expect(migrations[3]?.sql).toContain("simulation_hash");
  });

  it("applies a missing migration once and validates the exact checksum", async () => {
    const client = new FakeMigrationClient();
    const first = await migrateDatabaseWithClient(client, () => new Date("2026-08-16T10:00:00.000Z"));
    const second = await migrateDatabaseWithClient(client, () => new Date("2026-08-16T10:01:00.000Z"));
    expect(first.applied).toHaveLength(4);
    expect(second.applied).toEqual([]);
    expect(client.transactions).toHaveLength(4);
    await expect(validateDatabaseMigrations(client)).resolves.toMatchObject({ appliedVersion: 4 });
  });

  it("fails closed for an unknown or mismatched applied migration", async () => {
    const client = new FakeMigrationClient();
    client.applied = [{ version: 99, name: "future", checksum: "sha256:future", applied_at: "2026-08-16T10:00:00.000Z" }];
    await expect(validateDatabaseMigrations(client)).rejects.toThrow(/newer than this Egress runtime/i);
    client.applied = [{ version: 1, name: "phase8c_observation_operations", checksum: "sha256:wrong", applied_at: "2026-08-16T10:00:00.000Z" }];
    await expect(validateDatabaseMigrations(client)).rejects.toThrow(/checksum\/name mismatch/i);
  });
});
