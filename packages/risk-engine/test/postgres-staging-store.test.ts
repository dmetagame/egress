import { describe, expect, it } from "vitest";
import {
  createExecutionFingerprint,
  createExecutionSubmission,
  createExecutionSubmissionReservation,
  createExecutionTransactionBinding,
  EgressExecutionStagingWorker,
  InMemoryExecutionStagingStore,
  loadDatabaseMigrations,
  PostgresExecutionStagingStore,
  PostgresStagingSnapshotReader,
  type ExecutionSimulation,
  type ExecutionStagingIntent,
  type ExecutionSubmission,
  type ExecutionSubmissionReservation,
  type ExecutionWorkerEvent,
} from "../src/index.js";
import { createStagingFixture, STAGING_TRANSACTION_HASH } from "./staging-fixture.js";

describe("PostgreSQL execution staging store", () => {
  it("validates migrations and keeps staging evidence immutable and idempotent", async () => {
    const fixture = await createStagingFixture();
    const generated = await new EgressExecutionStagingWorker({
      config: fixture.config,
      snapshotReader: fixture.archive,
      store: new InMemoryExecutionStagingStore(),
      keeper: fixture.keeper,
      identifyEnvironment: async () => ({
        environment: "FORK_WRITE",
        chainId: 196,
        anchorBlockHash: fixture.config.anchorBlockHash!,
        forkDetected: true,
        testnetConfigured: false,
      }),
      readBlockHash: async () => fixture.snapshot.blockHash as `0x${string}`,
      now: () => new Date("2026-08-14T10:00:00.000Z"),
    }).stage(fixture.request);
    if (!generated.intent || !generated.simulation) throw new Error("Expected staged evidence.");
    const prepared = await fixture.keeper.prepareExecution({
      event: fixture.request.riskEvent,
      policy: fixture.request.policy,
      attestation: fixture.request.riskAttestation,
    });
    if (!prepared.simulationRequest) throw new Error("Expected a typed simulated request.");
    const transactionBinding = createExecutionTransactionBinding({
      intent: generated.intent,
      simulationRequest: prepared.simulationRequest,
    });
    const executionFingerprint = createExecutionFingerprint({
      intent: generated.intent,
      simulation: generated.simulation,
      transactionBinding,
    });

    const database = await createFakeStagingDatabase(fixture.snapshot);
    const store = new PostgresExecutionStagingStore(database.url, database.sql as never);
    const reader = new PostgresStagingSnapshotReader(database.url, database.sql as never);
    const reservation = createExecutionSubmissionReservation({
      reservationId: "123e4567-e89b-42d3-a456-426614174000",
      intent: generated.intent,
      simulation: generated.simulation,
      transactionBinding,
      executionFingerprint,
      createdAt: "2026-08-14T10:00:01.000Z",
    });
    const submission = createExecutionSubmission({
      intent: generated.intent,
      simulation: generated.simulation,
      transactionBinding,
      executionFingerprint,
      status: "CONFIRMED",
      transactionHash: STAGING_TRANSACTION_HASH,
      blockNumber: "67881250",
      gasUsed: "900000",
      createdAt: "2026-08-14T10:00:02.000Z",
    });

    expect((await reader.get(fixture.snapshot.snapshotHash))?.integrityHash)
      .toBe(fixture.snapshot.integrityHash);
    expect((await store.saveIntent(generated.intent)).inserted).toBe(true);
    expect((await store.saveIntent(generated.intent)).inserted).toBe(false);
    expect((await store.saveSimulation(generated.simulation)).inserted).toBe(true);
    expect((await store.saveSimulation(generated.simulation)).inserted).toBe(false);
    expect((await store.reserveSubmission(reservation)).inserted).toBe(true);
    expect((await store.reserveSubmission(reservation)).inserted).toBe(false);
    expect((await store.saveSubmission(submission)).inserted).toBe(true);
    expect((await store.saveSubmission(submission)).inserted).toBe(false);
    expect(await store.latestIntent()).toMatchObject({ intentHash: generated.intent.intentHash });
    expect(await store.latestSimulation()).toMatchObject({ status: "PASSED" });
    expect(await store.latestReservation()).toMatchObject({ executionFingerprint });
    expect(await store.latestSubmission()).toMatchObject({ transactionHash: STAGING_TRANSACTION_HASH });
    expect(await store.databaseHealth()).toMatchObject({ state: "HEALTHY" });
  });

  it("fails closed when PostgreSQL or migration validation is unavailable", async () => {
    const unavailable = Object.assign(
      async () => {
        throw new Error("database unavailable");
      },
      {
        query: async () => {
          throw new Error("database unavailable");
        },
      },
    );
    const store = new PostgresExecutionStagingStore(
      "postgresql://test:test@example.invalid/egress",
      unavailable as never,
    );
    expect(await store.databaseHealth()).toMatchObject({ state: "UNAVAILABLE" });
  });
});

async function createFakeStagingDatabase(snapshot: Awaited<ReturnType<typeof createStagingFixture>>["snapshot"]) {
  const migrations = await loadDatabaseMigrations();
  const intents = new Map<string, ExecutionStagingIntent>();
  const simulations = new Map<string, ExecutionSimulation>();
  const reservations = new Map<string, ExecutionSubmissionReservation>();
  const submissions = new Map<string, ExecutionSubmission>();
  const events = new Map<string, ExecutionWorkerEvent>();
  const sql = Object.assign(
    async (strings: TemplateStringsArray, ...values: unknown[]) => {
      const query = strings.join("?").replace(/\s+/g, " ").trim();
      if (query.startsWith("SELECT payload FROM egress_live_snapshots")) {
        return String(values[0]).toLowerCase() === snapshot.snapshotHash.toLowerCase()
          ? [{ payload: structuredClone(snapshot) }]
          : [];
      }
      if (query.startsWith("INSERT INTO egress_execution_staging_intents")) {
        const value = JSON.parse(String(values[6])) as ExecutionStagingIntent;
        if (intents.has(value.intentHash)) return [];
        intents.set(value.intentHash, value);
        return [{ intent_hash: value.intentHash }];
      }
      if (query.startsWith("SELECT payload FROM egress_execution_staging_intents WHERE")) {
        const value = intents.get(String(values[0]));
        return value ? [{ payload: structuredClone(value) }] : [];
      }
      if (query.startsWith("SELECT payload FROM egress_execution_staging_intents ORDER BY")) {
        const value = latest(intents.values());
        return value ? [{ payload: structuredClone(value) }] : [];
      }
      if (query.startsWith("INSERT INTO egress_execution_staging_simulations")) {
        const value = JSON.parse(String(values[5])) as ExecutionSimulation;
        if ([...simulations.values()].some((candidate) => candidate.intentHash === value.intentHash)) return [];
        simulations.set(value.intentHash, value);
        return [{ simulation_hash: value.simulationHash }];
      }
      if (query.startsWith("SELECT payload FROM egress_execution_staging_simulations WHERE")) {
        const value = simulations.get(String(values[0]));
        return value ? [{ payload: structuredClone(value) }] : [];
      }
      if (query.startsWith("SELECT payload FROM egress_execution_staging_simulations ORDER BY")) {
        const value = latest(simulations.values());
        return value ? [{ payload: structuredClone(value) }] : [];
      }
      if (query.startsWith("INSERT INTO egress_execution_staging_submission_reservations")) {
        const value = JSON.parse(String(values[6])) as ExecutionSubmissionReservation;
        if (reservations.has(value.intentHash)) return [];
        reservations.set(value.intentHash, value);
        return [{ reservation_id: value.reservationId }];
      }
      if (query.startsWith("SELECT payload FROM egress_execution_staging_submission_reservations ORDER BY")) {
        const value = latest(reservations.values());
        return value ? [{ payload: structuredClone(value) }] : [];
      }
      if (query.startsWith("SELECT payload FROM egress_execution_staging_submission_reservations")) {
        const value = reservations.get(String(values[0]));
        return value ? [{ payload: structuredClone(value) }] : [];
      }
      if (query.startsWith("INSERT INTO egress_execution_staging_submissions")) {
        const value = JSON.parse(String(values[10])) as ExecutionSubmission;
        if (submissions.has(value.intentHash)) return [];
        submissions.set(value.intentHash, value);
        return [{ submission_hash: value.submissionHash }];
      }
      if (query.startsWith("SELECT payload FROM egress_execution_staging_submissions WHERE")) {
        const value = submissions.get(String(values[0]));
        return value ? [{ payload: structuredClone(value) }] : [];
      }
      if (query.startsWith("SELECT payload FROM egress_execution_staging_submissions ORDER BY")) {
        const value = latest(submissions.values());
        return value ? [{ payload: structuredClone(value) }] : [];
      }
      if (query.startsWith("INSERT INTO egress_execution_worker_events")) {
        const value = JSON.parse(String(values[7])) as ExecutionWorkerEvent;
        if (events.has(value.eventHash)) return [];
        events.set(value.eventHash, value);
        return [{ event_hash: value.eventHash }];
      }
      if (query.startsWith("SELECT payload FROM egress_execution_worker_events")) {
        const value = latest(events.values());
        return value ? [{ payload: structuredClone(value) }] : [];
      }
      if (query === "SELECT 1 AS healthy") return [{ healthy: 1 }];
      throw new Error(`Unexpected staging query: ${query}`);
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
  return {
    url: "postgresql://test:test@example.invalid/egress",
    sql,
  };
}

function latest<T extends { createdAt: string }>(values: Iterable<T>): T | undefined {
  return [...values].sort((left, right) => right.createdAt.localeCompare(left.createdAt))[0];
}
