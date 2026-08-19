import {
  liveAlertSchema,
  liveArchiveHistoryEntrySchema,
  type ArchivedLiveSnapshot,
  type LiveAlert,
  type LiveArchiveHistoryEntry,
  type LiveSnapshotObservation,
} from "./archive-schemas.js";
import {
  createObservation,
  parseArchivedSnapshot,
  type AlertWriteResult,
  type ArchiveWriteResult,
  type LiveSnapshotArchive,
} from "./archive.js";
import {
  liveAlertDeliverySchema,
  liveOperationalEventSchema,
  type AlertDeliveryStatus,
  type LiveAlertDelivery,
  type LiveOperationalEvent,
  type LiveOperationalStore,
} from "./operations.js";

export class InMemoryLiveSnapshotArchive implements LiveSnapshotArchive, LiveOperationalStore {
  readonly snapshots = new Map<string, ArchivedLiveSnapshot>();
  readonly observations = new Map<string, LiveSnapshotObservation>();
  readonly alertRecords = new Map<string, LiveAlert>();
  readonly operationalEventRecords = new Map<string, LiveOperationalEvent>();
  readonly deliveryRecords = new Map<string, LiveAlertDelivery>();
  readonly deliveryLeases = new Map<string, { leaseId: string; leaseExpiresAt: string }>();

  async archive(
    record: ArchivedLiveSnapshot,
    observedAt = record.createdAt,
  ): Promise<ArchiveWriteResult> {
    const parsed = parseArchivedSnapshot(record);
    const key = parsed.snapshotHash.toLowerCase();
    const inserted = !this.snapshots.has(key);
    if (inserted) this.snapshots.set(key, structuredClone(parsed));
    const observation = createObservation(parsed.snapshotHash as `0x${string}`, observedAt);
    const observationInserted = !this.observations.has(observation.observationId);
    if (observationInserted) {
      this.observations.set(observation.observationId, structuredClone(observation));
    }
    return {
      inserted,
      observationInserted,
      entry: liveArchiveHistoryEntrySchema.parse({
        observation,
        snapshot: this.snapshots.get(key),
      }),
    };
  }

  async current(): Promise<LiveArchiveHistoryEntry | null> {
    return (await this.history({ limit: 1 }))[0] ?? null;
  }

  async history(
    options: { limit?: number; before?: string } = {},
  ): Promise<LiveArchiveHistoryEntry[]> {
    const observations = [...this.observations.values()]
      .filter((observation) => !options.before || observation.observedAt < options.before)
      .sort((left, right) =>
        right.observedAt.localeCompare(left.observedAt) ||
        right.observationId.localeCompare(left.observationId),
      )
      .slice(0, boundedLimit(options.limit));
    return observations.map((observation) => liveArchiveHistoryEntrySchema.parse({
      observation,
      snapshot: this.snapshots.get(observation.snapshotHash.toLowerCase()),
    }));
  }

  async get(snapshotHash: string): Promise<ArchivedLiveSnapshot | null> {
    const snapshot = this.snapshots.get(snapshotHash.toLowerCase());
    return snapshot ? structuredClone(snapshot) : null;
  }

  async saveAlerts(alerts: readonly LiveAlert[]): Promise<AlertWriteResult> {
    const inserted: LiveAlert[] = [];
    const duplicates: LiveAlert[] = [];
    for (const value of alerts) {
      const alert = liveAlertSchema.parse(value);
      if (this.alertRecords.has(alert.deduplicationKey.toLowerCase())) duplicates.push(alert);
      else {
        this.alertRecords.set(alert.deduplicationKey.toLowerCase(), structuredClone(alert));
        inserted.push(alert);
      }
    }
    return { inserted, duplicates };
  }

  async alerts(options: { limit?: number; before?: string } = {}): Promise<LiveAlert[]> {
    return [...this.alertRecords.values()]
      .filter((alert) => !options.before || alert.createdAt < options.before)
      .sort((left, right) =>
        right.createdAt.localeCompare(left.createdAt) || right.alertId.localeCompare(left.alertId),
      )
      .slice(0, boundedLimit(options.limit))
      .map((alert) => structuredClone(alert));
  }

  async saveOperationalEvent(event: LiveOperationalEvent): Promise<{ inserted: boolean }> {
    const parsed = liveOperationalEventSchema.parse(event);
    const key = parsed.eventId.toLowerCase();
    if (this.operationalEventRecords.has(key)) return { inserted: false };
    this.operationalEventRecords.set(key, structuredClone(parsed));
    return { inserted: true };
  }

  async operationalEvents(options: { limit?: number; before?: string } = {}): Promise<LiveOperationalEvent[]> {
    return [...this.operationalEventRecords.values()]
      .filter((event) => !options.before || event.createdAt < options.before)
      .sort((left, right) => right.createdAt.localeCompare(left.createdAt) || right.eventId.localeCompare(left.eventId))
      .slice(0, boundedLimit(options.limit))
      .map((event) => structuredClone(event));
  }

  async saveAlertDelivery(delivery: LiveAlertDelivery): Promise<{ inserted: boolean }> {
    const parsed = liveAlertDeliverySchema.parse(delivery);
    const key = `${parsed.sinkId}:${parsed.alertId}`.toLowerCase();
    const inserted = !this.deliveryRecords.has(key);
    if (this.deliveryRecords.get(key)?.status === "DELIVERED" && parsed.status !== "DELIVERED") {
      return { inserted: false };
    }
    this.deliveryRecords.set(key, structuredClone(parsed));
    this.deliveryLeases.delete(key);
    return { inserted };
  }

  async claimAlertDelivery(
    delivery: LiveAlertDelivery,
    lease: { leaseId: string; claimedAt: string; leaseExpiresAt: string },
  ): Promise<boolean> {
    const parsed = liveAlertDeliverySchema.parse(delivery);
    const key = `${parsed.sinkId}:${parsed.alertId}`.toLowerCase();
    const existing = this.deliveryRecords.get(key);
    if (existing?.status === "DELIVERED") return false;
    if (!existing) this.deliveryRecords.set(key, structuredClone(parsed));
    const currentLease = this.deliveryLeases.get(key);
    if (existing?.nextAttemptAt && existing.nextAttemptAt > lease.claimedAt) return false;
    if (currentLease && currentLease.leaseId !== lease.leaseId && currentLease.leaseExpiresAt > lease.claimedAt) {
      return false;
    }
    this.deliveryLeases.set(key, { ...lease });
    return true;
  }

  async completeAlertDelivery(delivery: LiveAlertDelivery, leaseId: string): Promise<boolean> {
    const parsed = liveAlertDeliverySchema.parse(delivery);
    const key = `${parsed.sinkId}:${parsed.alertId}`.toLowerCase();
    const currentLease = this.deliveryLeases.get(key);
    if (!currentLease || currentLease.leaseId !== leaseId) return false;
    if (this.deliveryRecords.get(key)?.status === "DELIVERED") return false;
    this.deliveryRecords.set(key, structuredClone(parsed));
    this.deliveryLeases.delete(key);
    return true;
  }

  async alertDelivery(alertId: string, sinkId: string): Promise<LiveAlertDelivery | null> {
    const delivery = this.deliveryRecords.get(`${sinkId}:${alertId}`.toLowerCase());
    return delivery ? structuredClone(delivery) : null;
  }

  async alertDeliveries(options: { limit?: number; status?: AlertDeliveryStatus } = {}): Promise<LiveAlertDelivery[]> {
    return [...this.deliveryRecords.values()]
      .filter((delivery) => !options.status || delivery.status === options.status)
      .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt))
      .slice(0, boundedLimit(options.limit))
      .map((delivery) => structuredClone(delivery));
  }

  async databaseHealth(): Promise<{ state: "HEALTHY"; latencyMs: number; reason: null }> {
    return { state: "HEALTHY", latencyMs: 0, reason: null };
  }
}

function boundedLimit(limit = 50): number {
  return Math.max(1, Math.min(250, Math.floor(limit)));
}
