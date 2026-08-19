import { neon } from "@neondatabase/serverless";
import { parseArchivedSnapshot } from "../live/archive.js";
import { validateDatabaseMigrations } from "../live/database-migrations.js";
import { operationalErrorMessage } from "../live/redaction.js";
import {
  executionSimulationSchema,
  executionStagingIntentSchema,
  executionSubmissionReservationSchema,
  executionSubmissionSchema,
  executionWorkerEventSchema,
  verifyExecutionSimulation,
  verifyExecutionStagingIntent,
  verifyExecutionSubmission,
  verifyExecutionSubmissionReservation,
  verifyExecutionWorkerEvent,
  type ExecutionSimulation,
  type ExecutionStagingIntent,
  type ExecutionSubmission,
  type ExecutionSubmissionReservation,
  type ExecutionWorkerEvent,
  type LatestIntentSummary,
  type LatestReservationSummary,
  type LatestSimulationSummary,
  type LatestSubmissionSummary,
} from "./schemas.js";
import type { ExecutionStagingStore, StagingSnapshotReader } from "./store.js";

type SqlClient = ReturnType<typeof neon>;
type DatabaseRow = Record<string, unknown>;

export class PostgresStagingSnapshotReader implements StagingSnapshotReader {
  private readonly sql: SqlClient;
  private initialization: Promise<void> | null = null;

  constructor(databaseUrl: string, sqlClient?: SqlClient) {
    if (!databaseUrl.trim()) throw new Error("EGRESS_DATABASE_URL is required for execution staging.");
    this.sql = sqlClient ?? neon(databaseUrl);
  }

  async get(snapshotHash: string) {
    await this.initialize();
    const rows = await (this.sql`
      SELECT payload FROM egress_live_snapshots WHERE snapshot_hash = ${snapshotHash} LIMIT 1
    ` as unknown as Promise<DatabaseRow[]>);
    return rows[0] ? parseArchivedSnapshot(jsonValue(rows[0].payload)) : null;
  }

  private async initialize(): Promise<void> {
    if (!this.initialization) {
      this.initialization = validateDatabaseMigrations({
        query: (queryText, params) => this.sql.query(queryText, params) as Promise<DatabaseRow[]>,
      }).then(() => undefined).catch((error) => {
        this.initialization = null;
        throw error;
      });
    }
    return this.initialization;
  }
}

export class PostgresExecutionStagingStore implements ExecutionStagingStore {
  private readonly sql: SqlClient;
  private initialization: Promise<void> | null = null;

  constructor(databaseUrl: string, sqlClient?: SqlClient) {
    if (!databaseUrl.trim()) throw new Error("EGRESS_DATABASE_URL is required for execution staging.");
    this.sql = sqlClient ?? neon(databaseUrl);
  }

  async saveIntent(intent: ExecutionStagingIntent): Promise<{ inserted: boolean; intent: ExecutionStagingIntent }> {
    await this.initialize();
    const parsed = parseIntent(intent);
    const rows = await (this.sql`
      INSERT INTO egress_execution_staging_intents (
        intent_hash, request_hash, snapshot_hash, environment, chain_id,
        observed_block, payload, integrity_hash, created_at
      ) VALUES (
        ${parsed.intentHash}, ${parsed.requestHash}, ${parsed.snapshotHash}, ${parsed.environment},
        ${parsed.chainId}, ${parsed.observedBlock}, ${JSON.stringify(parsed)}::jsonb,
        ${parsed.integrityHash}, ${parsed.createdAt}
      )
      ON CONFLICT (intent_hash) DO NOTHING
      RETURNING intent_hash
    ` as unknown as Promise<DatabaseRow[]>);
    const stored = await this.getIntent(parsed.intentHash);
    if (!stored) throw new Error(`PostgreSQL staging store did not return intent ${parsed.intentHash}.`);
    if (stored.integrityHash.toLowerCase() !== parsed.integrityHash.toLowerCase()) {
      throw new Error("Immutable execution intent payload mismatch.");
    }
    return { inserted: rows.length > 0, intent: stored };
  }

  async getIntent(intentHash: string): Promise<ExecutionStagingIntent | null> {
    await this.initialize();
    const rows = await (this.sql`
      SELECT payload FROM egress_execution_staging_intents WHERE intent_hash = ${intentHash} LIMIT 1
    ` as unknown as Promise<DatabaseRow[]>);
    return rows[0] ? parseIntent(jsonValue(rows[0].payload)) : null;
  }

  async saveSimulation(simulation: ExecutionSimulation): Promise<{ inserted: boolean; simulation: ExecutionSimulation }> {
    await this.initialize();
    const parsed = parseSimulation(simulation);
    const rows = await (this.sql`
      INSERT INTO egress_execution_staging_simulations (
        simulation_hash, intent_hash, snapshot_hash, environment,
        simulation_status, payload, integrity_hash, created_at
      ) VALUES (
        ${parsed.simulationHash}, ${parsed.intentHash}, ${parsed.snapshotHash}, ${parsed.environment},
        ${parsed.status}, ${JSON.stringify(parsed)}::jsonb, ${parsed.integrityHash}, ${parsed.createdAt}
      )
      ON CONFLICT (intent_hash) DO NOTHING
      RETURNING simulation_hash
    ` as unknown as Promise<DatabaseRow[]>);
    const stored = await this.getSimulation(parsed.intentHash);
    if (!stored) throw new Error(`PostgreSQL staging store did not return simulation ${parsed.simulationHash}.`);
    if (stored.integrityHash.toLowerCase() !== parsed.integrityHash.toLowerCase()) {
      throw new Error("Immutable execution simulation payload mismatch.");
    }
    return { inserted: rows.length > 0, simulation: stored };
  }

  async getSimulation(intentHash: string): Promise<ExecutionSimulation | null> {
    await this.initialize();
    const rows = await (this.sql`
      SELECT payload FROM egress_execution_staging_simulations WHERE intent_hash = ${intentHash} LIMIT 1
    ` as unknown as Promise<DatabaseRow[]>);
    return rows[0] ? parseSimulation(jsonValue(rows[0].payload)) : null;
  }

  async reserveSubmission(reservation: ExecutionSubmissionReservation): Promise<{ inserted: boolean; reservation: ExecutionSubmissionReservation }> {
    await this.initialize();
    const parsed = executionSubmissionReservationSchema.parse(reservation);
    if (!verifyExecutionSubmissionReservation(parsed)) {
      throw new Error("Execution submission reservation integrity verification failed.");
    }
    const rows = await (this.sql`
      INSERT INTO egress_execution_staging_submission_reservations (
        reservation_id, intent_hash, environment, simulation_hash, execution_fingerprint,
        transaction_binding, payload, integrity_hash, created_at
      ) VALUES (
        ${parsed.reservationId}, ${parsed.intentHash}, ${parsed.environment},
        ${parsed.schemaVersion === 2 ? parsed.simulationHash : null},
        ${parsed.schemaVersion === 2 ? parsed.executionFingerprint : null},
        ${parsed.schemaVersion === 2 ? JSON.stringify(parsed.transactionBinding) : null}::jsonb,
        ${JSON.stringify(parsed)}::jsonb, ${parsed.integrityHash}, ${parsed.createdAt}
      )
      ON CONFLICT (intent_hash) DO NOTHING
      RETURNING reservation_id
    ` as unknown as Promise<DatabaseRow[]>);
    const storedRows = await (this.sql`
      SELECT payload FROM egress_execution_staging_submission_reservations
      WHERE intent_hash = ${parsed.intentHash} LIMIT 1
    ` as unknown as Promise<DatabaseRow[]>);
    const stored = storedRows[0]
      ? executionSubmissionReservationSchema.parse(jsonValue(storedRows[0].payload))
      : null;
    if (!stored) throw new Error("PostgreSQL staging store did not return the submission reservation.");
    if (!verifyExecutionSubmissionReservation(stored)) {
      throw new Error("Stored execution submission reservation integrity verification failed.");
    }
    return { inserted: rows.length > 0, reservation: stored };
  }

  async saveSubmission(submission: ExecutionSubmission): Promise<{ inserted: boolean; submission: ExecutionSubmission }> {
    await this.initialize();
    const parsed = parseSubmission(submission);
    const rows = await (this.sql`
      INSERT INTO egress_execution_staging_submissions (
        submission_hash, intent_hash, environment, submission_status,
        transaction_hash, block_number, gas_used, simulation_hash, execution_fingerprint,
        transaction_binding, payload, integrity_hash, created_at
      ) VALUES (
        ${parsed.submissionHash}, ${parsed.intentHash}, ${parsed.environment}, ${parsed.status},
        ${parsed.transactionHash}, ${parsed.blockNumber}, ${parsed.gasUsed},
        ${parsed.schemaVersion === 2 ? parsed.simulationHash : null},
        ${parsed.schemaVersion === 2 ? parsed.executionFingerprint : null},
        ${parsed.schemaVersion === 2 ? JSON.stringify(parsed.transactionBinding) : null}::jsonb,
        ${JSON.stringify(parsed)}::jsonb, ${parsed.integrityHash}, ${parsed.createdAt}
      )
      ON CONFLICT (intent_hash) DO NOTHING
      RETURNING submission_hash
    ` as unknown as Promise<DatabaseRow[]>);
    const stored = await this.getSubmission(parsed.intentHash);
    if (!stored) throw new Error(`PostgreSQL staging store did not return submission ${parsed.submissionHash}.`);
    if (stored.integrityHash.toLowerCase() !== parsed.integrityHash.toLowerCase()) {
      throw new Error("Immutable execution submission payload mismatch.");
    }
    return { inserted: rows.length > 0, submission: stored };
  }

  async getSubmission(intentHash: string): Promise<ExecutionSubmission | null> {
    await this.initialize();
    const rows = await (this.sql`
      SELECT payload FROM egress_execution_staging_submissions WHERE intent_hash = ${intentHash} LIMIT 1
    ` as unknown as Promise<DatabaseRow[]>);
    return rows[0] ? parseSubmission(jsonValue(rows[0].payload)) : null;
  }

  async saveWorkerEvent(event: ExecutionWorkerEvent): Promise<{ inserted: boolean }> {
    await this.initialize();
    const parsed = executionWorkerEventSchema.parse(event);
    if (!verifyExecutionWorkerEvent(parsed)) throw new Error("Execution worker event integrity verification failed.");
    const rows = await (this.sql`
      INSERT INTO egress_execution_worker_events (
        event_hash, event_type, environment, health_state, intent_hash,
        snapshot_hash, event_code, payload, created_at
      ) VALUES (
        ${parsed.eventHash}, ${parsed.eventType}, ${parsed.environment}, ${parsed.state},
        ${parsed.intentHash}, ${parsed.snapshotHash}, ${parsed.code},
        ${JSON.stringify(parsed)}::jsonb, ${parsed.createdAt}
      )
      ON CONFLICT (event_hash) DO NOTHING
      RETURNING event_hash
    ` as unknown as Promise<DatabaseRow[]>);
    return { inserted: rows.length > 0 };
  }

  async latestIntent(): Promise<LatestIntentSummary | null> {
    await this.initialize();
    const rows = await (this.sql`
      SELECT payload FROM egress_execution_staging_intents ORDER BY created_at DESC LIMIT 1
    ` as unknown as Promise<DatabaseRow[]>);
    const value = rows[0] ? jsonValue(rows[0].payload) : null;
    const parsed = value ? parseIntent(value) : null;
    return parsed ? {
      intentHash: parsed.intentHash,
      snapshotHash: parsed.snapshotHash,
      environment: parsed.environment,
      chainId: parsed.chainId,
      observedBlock: parsed.observedBlock,
      createdAt: parsed.createdAt,
    } : null;
  }

  async latestSimulation(): Promise<LatestSimulationSummary | null> {
    await this.initialize();
    const rows = await (this.sql`
      SELECT payload FROM egress_execution_staging_simulations ORDER BY created_at DESC LIMIT 1
    ` as unknown as Promise<DatabaseRow[]>);
    const value = rows[0] ? jsonValue(rows[0].payload) : null;
    const parsed = value ? parseSimulation(value) : null;
    return parsed ? {
      simulationHash: parsed.simulationHash,
      intentHash: parsed.intentHash,
      status: parsed.status,
      createdAt: parsed.createdAt,
    } : null;
  }

  async latestReservation(): Promise<LatestReservationSummary | null> {
    await this.initialize();
    const rows = await (this.sql`
      SELECT payload FROM egress_execution_staging_submission_reservations ORDER BY created_at DESC LIMIT 1
    ` as unknown as Promise<DatabaseRow[]>);
    const value = rows[0] ? jsonValue(rows[0].payload) : null;
    const parsed = value ? executionSubmissionReservationSchema.parse(value) : null;
    return parsed ? {
      reservationId: parsed.reservationId,
      intentHash: parsed.intentHash,
      environment: parsed.environment,
      simulationHash: parsed.schemaVersion === 2 ? parsed.simulationHash : null,
      executionFingerprint: parsed.schemaVersion === 2 ? parsed.executionFingerprint : null,
      createdAt: parsed.createdAt,
    } : null;
  }

  async latestSubmission(): Promise<LatestSubmissionSummary | null> {
    await this.initialize();
    const rows = await (this.sql`
      SELECT payload FROM egress_execution_staging_submissions ORDER BY created_at DESC LIMIT 1
    ` as unknown as Promise<DatabaseRow[]>);
    const value = rows[0] ? jsonValue(rows[0].payload) : null;
    const parsed = value ? parseSubmission(value) : null;
    return parsed ? {
      submissionHash: parsed.submissionHash,
      intentHash: parsed.intentHash,
      environment: parsed.environment,
      status: parsed.status,
      transactionHash: parsed.transactionHash,
      createdAt: parsed.createdAt,
    } : null;
  }

  async latestWorkerEvent(): Promise<ExecutionWorkerEvent | null> {
    await this.initialize();
    const rows = await (this.sql`
      SELECT payload FROM egress_execution_worker_events ORDER BY created_at DESC LIMIT 1
    ` as unknown as Promise<DatabaseRow[]>);
    const value = rows[0] ? jsonValue(rows[0].payload) : null;
    if (!value) return null;
    const parsed = executionWorkerEventSchema.parse(value);
    if (!verifyExecutionWorkerEvent(parsed)) throw new Error(`Execution worker event integrity failed for ${parsed.eventHash}.`);
    return parsed;
  }

  async databaseHealth(): Promise<{ state: "HEALTHY" | "UNAVAILABLE"; latencyMs: number | null; reason: string | null }> {
    const startedAt = Date.now();
    try {
      await this.initialize();
      await this.sql`SELECT 1 AS healthy`;
      return { state: "HEALTHY", latencyMs: Date.now() - startedAt, reason: null };
    } catch (error) {
      return { state: "UNAVAILABLE", latencyMs: null, reason: operationalErrorMessage(error) };
    }
  }

  private async initialize(): Promise<void> {
    if (!this.initialization) {
      this.initialization = validateDatabaseMigrations({
        query: (queryText, params) => this.sql.query(queryText, params) as Promise<DatabaseRow[]>,
      }).then(() => undefined).catch((error) => {
        this.initialization = null;
        throw error;
      });
    }
    return this.initialization;
  }
}

function parseIntent(value: unknown): ExecutionStagingIntent {
  const parsed = executionStagingIntentSchema.parse(value);
  if (!verifyExecutionStagingIntent(parsed)) throw new Error(`Execution intent integrity failed for ${parsed.intentHash}.`);
  return parsed;
}

function parseSimulation(value: unknown): ExecutionSimulation {
  const parsed = executionSimulationSchema.parse(value);
  if (!verifyExecutionSimulation(parsed)) throw new Error(`Execution simulation integrity failed for ${parsed.simulationHash}.`);
  return parsed;
}

function parseSubmission(value: unknown): ExecutionSubmission {
  const parsed = executionSubmissionSchema.parse(value);
  if (!verifyExecutionSubmission(parsed)) throw new Error(`Execution submission integrity failed for ${parsed.submissionHash}.`);
  return parsed;
}

function jsonValue(value: unknown): unknown {
  return typeof value === "string" ? JSON.parse(value) : value;
}
