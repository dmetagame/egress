import { neon } from "@neondatabase/serverless";
import {
  liveAlertSchema,
  liveArchiveHistoryEntrySchema,
  liveSnapshotObservationSchema,
  type ArchivedLiveSnapshot,
  type LiveAlert,
  type LiveArchiveHistoryEntry,
} from "./archive-schemas.js";
import {
  createObservation,
  parseArchivedSnapshot,
  type AlertWriteResult,
  type ArchiveWriteResult,
  type LiveSnapshotArchive,
} from "./archive.js";
import { validateDatabaseMigrations } from "./database-migrations.js";
import {
  liveAlertDeliverySchema,
  liveOperationalEventSchema,
  type AlertDeliveryStatus,
  type LiveAlertDelivery,
  type LiveOperationalEvent,
  type LiveOperationalStore,
  type OperationalHealthState,
} from "./operations.js";
import { operationalErrorMessage } from "./redaction.js";

export class PostgresLiveSnapshotArchive implements LiveSnapshotArchive, LiveOperationalStore {
  private readonly sql: ReturnType<typeof neon>;
  private initialization: Promise<void> | null = null;

  constructor(databaseUrl: string, sqlClient?: ReturnType<typeof neon>) {
    if (!databaseUrl.trim()) throw new Error("EGRESS_DATABASE_URL is required for PostgreSQL archiving.");
    this.sql = sqlClient ?? neon(databaseUrl);
  }

  async archive(
    record: ArchivedLiveSnapshot,
    observedAt = record.createdAt,
  ): Promise<ArchiveWriteResult> {
    await this.initialize();
    const parsed = parseArchivedSnapshot(record);
    const observation = createObservation(parsed.snapshotHash as `0x${string}`, observedAt);
    const snapshotRows = await (this.sql`
      INSERT INTO egress_live_snapshots (
        snapshot_hash, archive_status, chain_id, account, observed_block,
        block_hash, state_timestamp, risk_classification, configuration_hash,
        payload, integrity_hash, created_at
      ) VALUES (
        ${parsed.snapshotHash}, ${parsed.archiveStatus}, ${parsed.chainId}, ${parsed.account},
        ${parsed.observedBlock}, ${parsed.blockHash}, ${parsed.timestamp},
        ${parsed.riskClassification}, ${parsed.configurationHash},
        ${JSON.stringify(parsed)}::jsonb, ${parsed.integrityHash}, ${parsed.createdAt}
      )
      ON CONFLICT (snapshot_hash) DO NOTHING
      RETURNING snapshot_hash
    ` as unknown as Promise<DatabaseRow[]>);
    const observationRows = await (this.sql`
      INSERT INTO egress_live_snapshot_observations (
        observation_id, snapshot_hash, chain_id, account, observed_block,
        archive_status, observed_at
      ) VALUES (
        ${observation.observationId}, ${observation.snapshotHash}, ${parsed.chainId},
        ${parsed.account}, ${parsed.observedBlock}, ${parsed.archiveStatus}, ${observation.observedAt}
      )
      ON CONFLICT (observation_id) DO NOTHING
      RETURNING observation_id
    ` as unknown as Promise<DatabaseRow[]>);
    const stored = await this.get(parsed.snapshotHash);
    if (!stored) throw new Error(`PostgreSQL archive did not return ${parsed.snapshotHash}.`);
    return {
      inserted: snapshotRows.length > 0,
      observationInserted: observationRows.length > 0,
      entry: liveArchiveHistoryEntrySchema.parse({ observation, snapshot: stored }),
    };
  }

  async current(): Promise<LiveArchiveHistoryEntry | null> {
    return (await this.history({ limit: 1 }))[0] ?? null;
  }

  async history(
    options: { limit?: number; before?: string } = {},
  ): Promise<LiveArchiveHistoryEntry[]> {
    await this.initialize();
    const limit = boundedLimit(options.limit);
    const before = options.before ?? "9999-12-31T23:59:59.999Z";
    const rows = await (this.sql`
      SELECT o.observation_id, o.snapshot_hash, o.observed_at, s.payload
      FROM egress_live_snapshot_observations o
      JOIN egress_live_snapshots s ON s.snapshot_hash = o.snapshot_hash
      WHERE o.observed_at < ${before}
      ORDER BY o.observed_at DESC, o.observation_id DESC
      LIMIT ${limit}
    ` as unknown as Promise<DatabaseRow[]>);
    return rows.map((row) => liveArchiveHistoryEntrySchema.parse({
      observation: liveSnapshotObservationSchema.parse({
        observationId: row.observation_id,
        snapshotHash: row.snapshot_hash,
        observedAt: timestampString(row.observed_at),
      }),
      snapshot: parseArchivedSnapshot(jsonValue(row.payload)),
    }));
  }

  async get(snapshotHash: string): Promise<ArchivedLiveSnapshot | null> {
    await this.initialize();
    const rows = await (this.sql`
      SELECT payload FROM egress_live_snapshots WHERE snapshot_hash = ${snapshotHash} LIMIT 1
    ` as unknown as Promise<DatabaseRow[]>);
    const row = rows[0];
    return row ? parseArchivedSnapshot(jsonValue(row.payload)) : null;
  }

  async saveAlerts(alerts: readonly LiveAlert[]): Promise<AlertWriteResult> {
    await this.initialize();
    const inserted: LiveAlert[] = [];
    const duplicates: LiveAlert[] = [];
    for (const value of alerts) {
      const alert = liveAlertSchema.parse(value);
      const rows = await (this.sql`
        INSERT INTO egress_live_alerts (
          alert_id, deduplication_key, alert_type, severity, snapshot_hash,
          previous_snapshot_hash, block_number, alert_timestamp, payload, created_at
        ) VALUES (
          ${alert.alertId}, ${alert.deduplicationKey}, ${alert.alertType}, ${alert.severity},
          ${alert.snapshotHash}, ${alert.previousSnapshotHash}, ${alert.block},
          ${alert.timestamp}, ${JSON.stringify(alert)}::jsonb, ${alert.createdAt}
        )
        ON CONFLICT (deduplication_key) DO NOTHING
        RETURNING alert_id
      ` as unknown as Promise<DatabaseRow[]>);
      (rows.length > 0 ? inserted : duplicates).push(alert);
    }
    return { inserted, duplicates };
  }

  async alerts(options: { limit?: number; before?: string } = {}): Promise<LiveAlert[]> {
    await this.initialize();
    const limit = boundedLimit(options.limit);
    const before = options.before ?? "9999-12-31T23:59:59.999Z";
    const rows = await (this.sql`
      SELECT payload FROM egress_live_alerts
      WHERE created_at < ${before}
      ORDER BY created_at DESC, alert_id DESC
      LIMIT ${limit}
    ` as unknown as Promise<DatabaseRow[]>);
    return rows.map((row) => liveAlertSchema.parse(jsonValue(row.payload)));
  }

  async saveOperationalEvent(event: LiveOperationalEvent): Promise<{ inserted: boolean }> {
    await this.initialize();
    const parsed = liveOperationalEventSchema.parse(event);
    const rows = await (this.sql`
      INSERT INTO egress_live_operational_events (
        event_id, event_type, health_state, snapshot_hash, observed_block,
        started_at, completed_at, duration_ms, payload, created_at
      ) VALUES (
        ${parsed.eventId}, ${parsed.eventType}, ${parsed.healthState}, ${parsed.snapshotHash},
        ${parsed.block}, ${parsed.startedAt}, ${parsed.completedAt}, ${parsed.durationMs},
        ${JSON.stringify(parsed)}::jsonb, ${parsed.createdAt}
      )
      ON CONFLICT (event_id) DO NOTHING
      RETURNING event_id
    ` as unknown as Promise<DatabaseRow[]>);
    return { inserted: rows.length > 0 };
  }

  async operationalEvents(
    options: { limit?: number; before?: string } = {},
  ): Promise<LiveOperationalEvent[]> {
    await this.initialize();
    const limit = boundedLimit(options.limit);
    const before = options.before ?? "9999-12-31T23:59:59.999Z";
    const rows = await (this.sql`
      SELECT payload FROM egress_live_operational_events
      WHERE created_at < ${before}
      ORDER BY created_at DESC, event_id DESC
      LIMIT ${limit}
    ` as unknown as Promise<DatabaseRow[]>);
    return rows.map((row) => liveOperationalEventSchema.parse(jsonValue(row.payload)));
  }

  async saveAlertDelivery(delivery: LiveAlertDelivery): Promise<{ inserted: boolean }> {
    await this.initialize();
    const parsed = liveAlertDeliverySchema.parse(delivery);
    const existing = await (this.sql`
      SELECT 1 FROM egress_live_alert_deliveries
      WHERE alert_id = ${parsed.alertId} AND sink_id = ${parsed.sinkId}
      LIMIT 1
    ` as unknown as Promise<DatabaseRow[]>);
    await this.sql`
      INSERT INTO egress_live_alert_deliveries (
        alert_id, sink_id, idempotency_key, delivery_status, attempts,
        response_status, last_error, last_attempt_at, next_attempt_at,
        delivered_at, created_at, updated_at
      ) VALUES (
        ${parsed.alertId}, ${parsed.sinkId}, ${parsed.idempotencyKey}, ${parsed.status},
        ${parsed.attempts}, ${parsed.responseStatus}, ${parsed.lastError},
        ${parsed.lastAttemptAt}, ${parsed.nextAttemptAt}, ${parsed.deliveredAt},
        ${parsed.createdAt}, ${parsed.updatedAt}
      )
      ON CONFLICT (alert_id, sink_id) DO UPDATE SET
        delivery_status = EXCLUDED.delivery_status,
        attempts = EXCLUDED.attempts,
        response_status = EXCLUDED.response_status,
        last_error = EXCLUDED.last_error,
        last_attempt_at = EXCLUDED.last_attempt_at,
        next_attempt_at = EXCLUDED.next_attempt_at,
        delivered_at = EXCLUDED.delivered_at,
        lease_id = NULL,
        lease_expires_at = NULL,
        updated_at = EXCLUDED.updated_at
      WHERE egress_live_alert_deliveries.delivery_status <> 'DELIVERED'
    `;
    return { inserted: existing.length === 0 };
  }

  async claimAlertDelivery(
    delivery: LiveAlertDelivery,
    lease: { leaseId: string; claimedAt: string; leaseExpiresAt: string },
  ): Promise<boolean> {
    await this.initialize();
    const parsed = liveAlertDeliverySchema.parse(delivery);
    await this.sql`
      INSERT INTO egress_live_alert_deliveries (
        alert_id, sink_id, idempotency_key, delivery_status, attempts,
        response_status, last_error, last_attempt_at, next_attempt_at,
        delivered_at, lease_id, lease_expires_at, created_at, updated_at
      ) VALUES (
        ${parsed.alertId}, ${parsed.sinkId}, ${parsed.idempotencyKey}, ${parsed.status},
        ${parsed.attempts}, ${parsed.responseStatus}, ${parsed.lastError},
        ${parsed.lastAttemptAt}, ${parsed.nextAttemptAt}, ${parsed.deliveredAt},
        NULL, NULL, ${parsed.createdAt}, ${parsed.updatedAt}
      )
      ON CONFLICT (alert_id, sink_id) DO NOTHING
    `;
    const rows = await (this.sql`
      UPDATE egress_live_alert_deliveries
      SET lease_id = ${lease.leaseId}, lease_expires_at = ${lease.leaseExpiresAt},
        updated_at = ${parsed.updatedAt}
      WHERE alert_id = ${parsed.alertId}
        AND sink_id = ${parsed.sinkId}
        AND delivery_status <> 'DELIVERED'
        AND (next_attempt_at IS NULL OR next_attempt_at <= ${lease.claimedAt})
        AND (
          lease_id = ${lease.leaseId} OR
          lease_expires_at IS NULL OR
          lease_expires_at <= ${lease.claimedAt}
        )
      RETURNING alert_id
    ` as unknown as Promise<DatabaseRow[]>);
    return rows.length > 0;
  }

  async completeAlertDelivery(delivery: LiveAlertDelivery, leaseId: string): Promise<boolean> {
    await this.initialize();
    const parsed = liveAlertDeliverySchema.parse(delivery);
    const rows = await (this.sql`
      UPDATE egress_live_alert_deliveries
      SET delivery_status = ${parsed.status}, attempts = ${parsed.attempts},
        response_status = ${parsed.responseStatus}, last_error = ${parsed.lastError},
        last_attempt_at = ${parsed.lastAttemptAt}, next_attempt_at = ${parsed.nextAttemptAt},
        delivered_at = ${parsed.deliveredAt}, lease_id = NULL, lease_expires_at = NULL,
        updated_at = ${parsed.updatedAt}
      WHERE alert_id = ${parsed.alertId}
        AND sink_id = ${parsed.sinkId}
        AND lease_id = ${leaseId}
        AND delivery_status <> 'DELIVERED'
      RETURNING alert_id
    ` as unknown as Promise<DatabaseRow[]>);
    return rows.length > 0;
  }

  async alertDelivery(alertId: string, sinkId: string): Promise<LiveAlertDelivery | null> {
    await this.initialize();
    const rows = await (this.sql`
      SELECT alert_id, sink_id, idempotency_key, delivery_status, attempts,
        response_status, last_error, last_attempt_at, next_attempt_at,
        delivered_at, created_at, updated_at
      FROM egress_live_alert_deliveries
      WHERE alert_id = ${alertId} AND sink_id = ${sinkId}
      LIMIT 1
    ` as unknown as Promise<DatabaseRow[]>);
    return rows[0] ? deliveryFromRow(rows[0]) : null;
  }

  async alertDeliveries(
    options: { limit?: number; status?: AlertDeliveryStatus } = {},
  ): Promise<LiveAlertDelivery[]> {
    await this.initialize();
    const limit = boundedLimit(options.limit);
    const rows = options.status
      ? await (this.sql`
          SELECT alert_id, sink_id, idempotency_key, delivery_status, attempts,
            response_status, last_error, last_attempt_at, next_attempt_at,
            delivered_at, created_at, updated_at
          FROM egress_live_alert_deliveries
          WHERE delivery_status = ${options.status}
          ORDER BY updated_at DESC
          LIMIT ${limit}
        ` as unknown as Promise<DatabaseRow[]>)
      : await (this.sql`
          SELECT alert_id, sink_id, idempotency_key, delivery_status, attempts,
            response_status, last_error, last_attempt_at, next_attempt_at,
            delivered_at, created_at, updated_at
          FROM egress_live_alert_deliveries
          ORDER BY updated_at DESC
          LIMIT ${limit}
        ` as unknown as Promise<DatabaseRow[]>);
    return rows.map(deliveryFromRow);
  }

  async databaseHealth(): Promise<{
    state: OperationalHealthState;
    latencyMs: number | null;
    reason: string | null;
  }> {
    const startedAt = Date.now();
    try {
      await this.initialize();
      await this.sql`SELECT 1 AS healthy`;
      return { state: "HEALTHY", latencyMs: Date.now() - startedAt, reason: null };
    } catch (error) {
      return {
        state: "UNAVAILABLE",
        latencyMs: null,
        reason: operationalErrorMessage(error),
      };
    }
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

function jsonValue(value: unknown): unknown {
  return typeof value === "string" ? JSON.parse(value) : value;
}

type DatabaseRow = Record<string, unknown>;

function timestampString(value: unknown): string {
  if (value instanceof Date) return value.toISOString();
  return new Date(String(value)).toISOString();
}

function boundedLimit(limit = 50): number {
  return Math.max(1, Math.min(250, Math.floor(limit)));
}

function deliveryFromRow(row: DatabaseRow): LiveAlertDelivery {
  return liveAlertDeliverySchema.parse({
    schemaVersion: 1,
    alertId: row.alert_id,
    sinkId: row.sink_id,
    idempotencyKey: row.idempotency_key,
    status: row.delivery_status,
    attempts: Number(row.attempts),
    responseStatus: row.response_status === null ? null : Number(row.response_status),
    lastError: row.last_error,
    lastAttemptAt: nullableTimestamp(row.last_attempt_at),
    nextAttemptAt: nullableTimestamp(row.next_attempt_at),
    deliveredAt: nullableTimestamp(row.delivered_at),
    createdAt: timestampString(row.created_at),
    updatedAt: timestampString(row.updated_at),
  });
}

function nullableTimestamp(value: unknown): string | null {
  return value === null || value === undefined ? null : timestampString(value);
}
