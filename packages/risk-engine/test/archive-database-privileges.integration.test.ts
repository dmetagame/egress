import { randomBytes, randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { neon } from "@neondatabase/serverless";
import { describe, expect, it } from "vitest";
import {
  buildArchivedLiveSnapshot,
  createObservation,
  liveSnapshotStateHash,
  parseArchivedSnapshot,
  PostgresLiveSnapshotArchive,
  validateArchiveDatabasePrivileges,
  validateDatabaseMigrations,
  type ArchivedLiveSnapshot,
  type DatabaseQueryClient,
} from "../src/index.js";
import {
  archivePrivilegeTestRequested,
  resolveArchivePrivilegeTestConfig,
} from "./archive-privilege-test-config.js";

const SNAPSHOT_FIXTURE = new URL(
  "../../../.data/live-archive/snapshots/0x5e021de28d509b6bde9fb4649324e4e7be4f11fe75c8f7ee48d6ac96d140d4ed.json",
  import.meta.url,
);

const STAGING_TABLES = [
  ["egress_execution_staging_intents", "intent_hash"],
  ["egress_execution_staging_simulations", "simulation_hash"],
  ["egress_execution_staging_submission_reservations", "reservation_id"],
  ["egress_execution_staging_submissions", "submission_hash"],
  ["egress_execution_worker_events", "event_hash"],
] as const;

const SOURCE_TABLES = [
  ["egress_rwa_source_revisions", "revision_id"],
  ["egress_rwa_source_diffs", "diff_id"],
] as const;

const integrationRequested = archivePrivilegeTestRequested(process.env);
const describeIntegration = integrationRequested ? describe : describe.skip;

describeIntegration("archive PostgreSQL runtime least-privilege audit", () => {
  it("proves the real archive workflow and rejects every protected operation", async () => {
    const config = resolveArchivePrivilegeTestConfig(process.env);
    if (!config) throw new Error("Archive privilege integration-test configuration is absent.");
    const sql = neon(config.databaseUrl);
    const client: DatabaseQueryClient = {
      query: (queryText, params) => sql.query(queryText, params) as Promise<Record<string, unknown>[]>,
    };

    await validateDatabaseMigrations(client);
    const report = await validateArchiveDatabasePrivileges(client);
    expect(report.missingRequired).toEqual([]);
    expect(report.forbiddenGranted).toEqual([]);
    await assertProtectedOperationsDenied(client);

    const archive = new PostgresLiveSnapshotArchive(config.databaseUrl, sql as never);
    const base = parseArchivedSnapshot(JSON.parse(await readFile(SNAPSHOT_FIXTURE, "utf8")));
    const first = uniqueSnapshot(base, randomUUID());
    const second = uniqueSnapshot(base, randomUUID());
    const firstObservedAt = new Date().toISOString();
    const secondObservedAt = new Date(Date.now() + 1).toISOString();
    const firstWrite = await archive.archive(first, firstObservedAt);
    const secondWrite = await archive.archive(second, secondObservedAt);
    expect(firstWrite.inserted).toBe(true);
    expect(firstWrite.observationInserted).toBe(true);
    expect(secondWrite.inserted).toBe(true);
    expect(secondWrite.observationInserted).toBe(true);
    expect((await archive.get(first.snapshotHash))?.integrityHash).toBe(first.integrityHash);

    await assertDatabaseIntegrityBoundaries(client, {
      first,
      second,
      firstObservedAt,
      firstObservationId: firstWrite.entry.observation.observationId,
    });
  }, 120_000);
});

async function assertProtectedOperationsDenied(client: DatabaseQueryClient): Promise<void> {
  for (const [table, key] of [...STAGING_TABLES, ...SOURCE_TABLES]) {
    await expectPermissionDenied(client, `SELECT ${table}`, `SELECT 1 FROM public.${table} LIMIT 0`);
    await expectPermissionDenied(client, `INSERT ${table}`, `INSERT INTO public.${table} DEFAULT VALUES`);
    await expectPermissionDenied(client, `UPDATE ${table}`, `UPDATE public.${table} SET ${key} = ${key} WHERE false`);
    await expectPermissionDenied(client, `DELETE ${table}`, `DELETE FROM public.${table} WHERE false`);
    await expectStatementDenied(client, `TRUNCATE ${table}`, `TRUNCATE TABLE public.${table}`);
  }

  await expectPermissionDenied(
    client,
    "UPDATE snapshots",
    "UPDATE public.egress_live_snapshots SET snapshot_hash = snapshot_hash WHERE false",
  );
  await expectPermissionDenied(
    client,
    "DELETE snapshots",
    "DELETE FROM public.egress_live_snapshots WHERE false",
  );
  await expectStatementDenied(
    client,
    "TRUNCATE snapshots",
    "TRUNCATE TABLE public.egress_live_snapshots CASCADE",
  );
  await expectPermissionDenied(
    client,
    "UPDATE snapshot observations",
    "UPDATE public.egress_live_snapshot_observations SET observation_id = observation_id WHERE false",
  );
  await expectPermissionDenied(
    client,
    "DELETE snapshot observations",
    "DELETE FROM public.egress_live_snapshot_observations WHERE false",
  );
  await expectStatementDenied(
    client,
    "TRUNCATE snapshot observations",
    "TRUNCATE TABLE public.egress_live_snapshot_observations",
  );

  await expectPermissionDenied(
    client,
    "modify migration metadata",
    "UPDATE public.egress_schema_migrations SET checksum = checksum WHERE false",
  );
  await expectPermissionDenied(
    client,
    "insert migration metadata",
    "INSERT INTO public.egress_schema_migrations DEFAULT VALUES",
  );
  await expectPermissionDenied(
    client,
    "delete migration metadata",
    "DELETE FROM public.egress_schema_migrations WHERE false",
  );
  await expectStatementDenied(
    client,
    "truncate migration metadata",
    "TRUNCATE TABLE public.egress_schema_migrations",
  );

  for (const table of [
    "egress_live_alerts",
    "egress_live_alert_deliveries",
    "egress_live_operational_events",
    "egress_live_retention_audit",
  ]) {
    await expectPermissionDenied(client, `access ${table}`, `SELECT 1 FROM public.${table} LIMIT 0`);
  }

  await expectStatementDenied(
    client,
    "create objects in public schema",
    "CREATE TABLE public.egress_archive_privilege_probe (id integer)",
  );
  await expectStatementDenied(
    client,
    "alter protected tables",
    "ALTER TABLE public.egress_live_snapshots SET (fillfactor = 99)",
  );
  await expectStatementDenied(
    client,
    "drop protected tables",
    "DROP TABLE public.egress_live_retention_audit",
  );
  await expectPermissionDenied(
    client,
    "read PostgreSQL credential catalog",
    "SELECT rolpassword FROM pg_catalog.pg_authid LIMIT 1",
  );
  await expectPermissionDenied(
    client,
    "read PostgreSQL shadow credentials",
    "SELECT passwd FROM pg_catalog.pg_shadow LIMIT 1",
  );
}

async function assertDatabaseIntegrityBoundaries(
  client: DatabaseQueryClient,
  input: {
    first: ArchivedLiveSnapshot;
    second: ArchivedLiveSnapshot;
    firstObservedAt: string;
    firstObservationId: string;
  },
): Promise<void> {
  await expectSqlState(client, "orphan observation", "23503", `
    INSERT INTO public.egress_live_snapshot_observations (
      observation_id, snapshot_hash, observed_at
    ) VALUES ($1, $2, $3)
  `, [
    `observation-orphan-${randomUUID()}`,
    `0x${randomBytes(32).toString("hex")}`,
    new Date(Date.now() + 2).toISOString(),
  ]);

  await expectSqlState(client, "duplicate observation ID", "23505", `
    INSERT INTO public.egress_live_snapshot_observations (
      observation_id, snapshot_hash, chain_id, account, observed_block, archive_status, observed_at
    ) VALUES ($1, $2, $3, $4, $5, $6, $7)
  `, [
    input.firstObservationId,
    input.first.snapshotHash,
    input.first.chainId,
    input.first.account,
    input.first.observedBlock,
    input.first.archiveStatus,
    new Date(Date.now() + 3).toISOString(),
  ]);

  const wrongSnapshotObservedAt = new Date(Date.now() + 4).toISOString();
  await expectSemanticInsertAllowedAndRolledBack(client, "wrong snapshot reference", [
    createObservation(input.first.snapshotHash as `0x${string}`, wrongSnapshotObservedAt).observationId,
    input.second.snapshotHash,
    input.second.chainId,
    input.second.account,
    input.second.observedBlock,
    input.second.archiveStatus,
    wrongSnapshotObservedAt,
  ]);

  const inconsistentObservedAt = new Date(Date.now() + 5).toISOString();
  await expectSemanticInsertAllowedAndRolledBack(client, "inconsistent observation metadata", [
    `observation-inconsistent-${randomUUID()}`,
    input.first.snapshotHash,
    input.first.chainId === null ? 1 : input.first.chainId + 1,
    "0x000000000000000000000000000000000000dEaD",
    input.first.observedBlock === null ? "1" : (BigInt(input.first.observedBlock) + 1n).toString(),
    "INCONSISTENT_TEST_PROBE",
    inconsistentObservedAt,
  ]);

  await expectSemanticInsertAllowedAndRolledBack(client, "duplicate canonical observation", [
    `observation-duplicate-${randomUUID()}`,
    input.first.snapshotHash,
    input.first.chainId,
    input.first.account,
    input.first.observedBlock,
    input.first.archiveStatus,
    input.firstObservedAt,
  ]);
}

async function expectSemanticInsertAllowedAndRolledBack(
  client: DatabaseQueryClient,
  label: string,
  params: unknown[],
): Promise<void> {
  await expectSqlState(client, label, "22012", `
    WITH inserted AS (
      INSERT INTO public.egress_live_snapshot_observations (
        observation_id, snapshot_hash, chain_id, account, observed_block, archive_status, observed_at
      ) VALUES ($1, $2, $3, $4, $5, $6, $7)
      RETURNING 1
    )
    SELECT 1 / CASE WHEN EXISTS (SELECT 1 FROM inserted) THEN 0 ELSE 1 END AS rollback_probe
  `, params);
}

async function expectPermissionDenied(
  client: DatabaseQueryClient,
  label: string,
  queryText: string,
  params: unknown[] = [],
): Promise<void> {
  await expectSqlState(client, label, "42501", queryText, params);
}

async function expectStatementDenied(
  client: DatabaseQueryClient,
  label: string,
  statement: string,
): Promise<void> {
  const escaped = statement.replaceAll("'", "''");
  try {
    await client.query(`DO $egress_archive_privilege$
      BEGIN
        BEGIN
          EXECUTE '${escaped}';
        EXCEPTION WHEN insufficient_privilege THEN
          RETURN;
        END;
        RAISE EXCEPTION 'EGRESS_FORBIDDEN_OPERATION_SUCCEEDED';
      END
      $egress_archive_privilege$`);
  } catch (error) {
    throw new Error(`${label} was not rejected with insufficient privilege (SQLSTATE ${sqlState(error)}).`);
  }
}

async function expectSqlState(
  client: DatabaseQueryClient,
  label: string,
  expectedCode: string,
  queryText: string,
  params: unknown[] = [],
): Promise<void> {
  let failure: unknown;
  try {
    await client.query(queryText, params);
  } catch (error) {
    failure = error;
  }
  if (!failure) throw new Error(`${label} unexpectedly succeeded.`);
  const code = sqlState(failure);
  if (code !== expectedCode) {
    throw new Error(`${label} failed with SQLSTATE ${code}; expected ${expectedCode}.`);
  }
}

function uniqueSnapshot(base: ArchivedLiveSnapshot, discriminator: string): ArchivedLiveSnapshot {
  const envelope = structuredClone(base.envelope);
  if (!envelope.snapshot) throw new Error("Archive privilege fixture must contain a complete snapshot.");
  envelope.snapshot.adapterVersions = {
    ...envelope.snapshot.adapterVersions,
    archivePrivilegeProbe: discriminator,
  };
  envelope.snapshot.snapshotHash = liveSnapshotStateHash(envelope.snapshot);
  return buildArchivedLiveSnapshot(envelope, new Date().toISOString());
}

function sqlState(error: unknown): string {
  if (typeof error === "object" && error !== null && "code" in error) {
    return String((error as { code?: unknown }).code ?? "unknown");
  }
  return "unknown";
}
