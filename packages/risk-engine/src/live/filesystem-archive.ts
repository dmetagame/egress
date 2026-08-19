import { mkdir, readFile, readdir, rename, unlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
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
import {
  liveAlertDeliverySchema,
  liveOperationalEventSchema,
  type AlertDeliveryStatus,
  type LiveAlertDelivery,
  type LiveOperationalEvent,
  type LiveOperationalStore,
} from "./operations.js";

export class FilesystemLiveSnapshotArchive implements LiveSnapshotArchive, LiveOperationalStore {
  constructor(private readonly directory: string) {}

  async archive(
    record: ArchivedLiveSnapshot,
    observedAt = record.createdAt,
  ): Promise<ArchiveWriteResult> {
    const parsed = parseArchivedSnapshot(record);
    await this.ensureDirectories();
    const snapshotPath = join(this.directory, "snapshots", fileName(parsed.snapshotHash));
    const inserted = await writeImmutable(snapshotPath, parsed);
    const stored = parseArchivedSnapshot(JSON.parse(await readFile(snapshotPath, "utf8")));
    const observation = createObservation(parsed.snapshotHash as `0x${string}`, observedAt);
    const observationPath = join(
      this.directory,
      "observations",
      `${observation.observationId}.json`,
    );
    const observationInserted = await writeImmutable(observationPath, observation);
    return {
      inserted,
      observationInserted,
      entry: liveArchiveHistoryEntrySchema.parse({ observation, snapshot: stored }),
    };
  }

  async current(): Promise<LiveArchiveHistoryEntry | null> {
    return (await this.history({ limit: 1 }))[0] ?? null;
  }

  async history(
    options: { limit?: number; before?: string } = {},
  ): Promise<LiveArchiveHistoryEntry[]> {
    const limit = boundedLimit(options.limit);
    const observations = await this.readObservations();
    const filtered = observations
      .filter((observation) => !options.before || observation.observedAt < options.before)
      .sort((left, right) =>
        right.observedAt.localeCompare(left.observedAt) ||
        right.observationId.localeCompare(left.observationId),
      )
      .slice(0, limit);
    return Promise.all(filtered.map(async (observation) => {
      const snapshot = await this.get(observation.snapshotHash);
      if (!snapshot) {
        throw new Error(`Observation ${observation.observationId} references a missing snapshot.`);
      }
      return liveArchiveHistoryEntrySchema.parse({ observation, snapshot });
    }));
  }

  async get(snapshotHash: string): Promise<ArchivedLiveSnapshot | null> {
    try {
      const raw = await readFile(
        join(this.directory, "snapshots", fileName(snapshotHash)),
        "utf8",
      );
      return parseArchivedSnapshot(JSON.parse(raw));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw error;
    }
  }

  async saveAlerts(alerts: readonly LiveAlert[]): Promise<AlertWriteResult> {
    await this.ensureDirectories();
    const inserted: LiveAlert[] = [];
    const duplicates: LiveAlert[] = [];
    for (const alert of alerts) {
      const parsed = liveAlertSchema.parse(alert);
      const didInsert = await writeImmutable(
        join(this.directory, "alerts", `${parsed.alertId}.json`),
        parsed,
      );
      (didInsert ? inserted : duplicates).push(parsed);
    }
    return { inserted, duplicates };
  }

  async alerts(options: { limit?: number; before?: string } = {}): Promise<LiveAlert[]> {
    const files = await listJsonFiles(join(this.directory, "alerts"));
    const alerts = await Promise.all(files.map(async (file) =>
      liveAlertSchema.parse(JSON.parse(await readFile(join(this.directory, "alerts", file), "utf8"))),
    ));
    return alerts
      .filter((alert) => !options.before || alert.createdAt < options.before)
      .sort((left, right) =>
        right.createdAt.localeCompare(left.createdAt) || right.alertId.localeCompare(left.alertId),
      )
      .slice(0, boundedLimit(options.limit));
  }

  async saveOperationalEvent(event: LiveOperationalEvent): Promise<{ inserted: boolean }> {
    const parsed = liveOperationalEventSchema.parse(event);
    await this.ensureDirectories();
    const inserted = await writeImmutable(
      join(this.directory, "operations", `${parsed.eventId}.json`),
      parsed,
    );
    return { inserted };
  }

  async operationalEvents(options: { limit?: number; before?: string } = {}): Promise<LiveOperationalEvent[]> {
    const files = await listJsonFiles(join(this.directory, "operations"));
    const events = await Promise.all(files.map(async (file) =>
      liveOperationalEventSchema.parse(JSON.parse(await readFile(join(this.directory, "operations", file), "utf8"))),
    ));
    return events
      .filter((event) => !options.before || event.createdAt < options.before)
      .sort((left, right) => right.createdAt.localeCompare(left.createdAt) || right.eventId.localeCompare(left.eventId))
      .slice(0, boundedLimit(options.limit));
  }

  async saveAlertDelivery(delivery: LiveAlertDelivery): Promise<{ inserted: boolean }> {
    const parsed = liveAlertDeliverySchema.parse(delivery);
    await this.ensureDirectories();
    const path = join(this.directory, "deliveries", `${safeFilePart(parsed.sinkId)}-${safeFilePart(parsed.alertId)}.json`);
    let inserted = true;
    try {
      const existing = liveAlertDeliverySchema.parse(JSON.parse(await readFile(path, "utf8")));
      inserted = false;
      if (existing.status === "DELIVERED" && parsed.status !== "DELIVERED") return { inserted: false };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    await writeFile(path, `${JSON.stringify(parsed, null, 2)}\n`, "utf8");
    await unlink(`${path}.lock`).catch((error: NodeJS.ErrnoException) => {
      if (error.code !== "ENOENT") throw error;
    });
    return { inserted };
  }

  async claimAlertDelivery(
    delivery: LiveAlertDelivery,
    lease: { leaseId: string; claimedAt: string; leaseExpiresAt: string },
  ): Promise<boolean> {
    const parsed = liveAlertDeliverySchema.parse(delivery);
    await this.ensureDirectories();
    const path = join(this.directory, "deliveries", `${safeFilePart(parsed.sinkId)}-${safeFilePart(parsed.alertId)}.json`);
    try {
      const existing = liveAlertDeliverySchema.parse(JSON.parse(await readFile(path, "utf8")));
      if (existing.status === "DELIVERED") return false;
      if (existing.nextAttemptAt && existing.nextAttemptAt > lease.claimedAt) return false;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      try {
        await writeFile(path, `${JSON.stringify(parsed, null, 2)}\n`, { encoding: "utf8", flag: "wx" });
      } catch (writeError) {
        if ((writeError as NodeJS.ErrnoException).code !== "EEXIST") throw writeError;
        const raced = liveAlertDeliverySchema.parse(JSON.parse(await readFile(path, "utf8")));
        if (raced.status === "DELIVERED") return false;
        if (raced.nextAttemptAt && raced.nextAttemptAt > lease.claimedAt) return false;
      }
    }
    const lockPath = `${path}.lock`;
    const lockBody = JSON.stringify(lease);
    try {
      await writeFile(lockPath, lockBody, { encoding: "utf8", flag: "wx" });
      return true;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      try {
        const existingLease = JSON.parse(await readFile(lockPath, "utf8")) as { leaseExpiresAt?: string };
        if (existingLease.leaseExpiresAt && existingLease.leaseExpiresAt > lease.claimedAt) return false;
        await unlink(lockPath);
        await writeFile(lockPath, lockBody, { encoding: "utf8", flag: "wx" });
        return true;
      } catch (retryError) {
        if ((retryError as NodeJS.ErrnoException).code === "EEXIST") return false;
        throw retryError;
      }
    }
  }

  async completeAlertDelivery(delivery: LiveAlertDelivery, leaseId: string): Promise<boolean> {
    const parsed = liveAlertDeliverySchema.parse(delivery);
    await this.ensureDirectories();
    const path = join(this.directory, "deliveries", `${safeFilePart(parsed.sinkId)}-${safeFilePart(parsed.alertId)}.json`);
    const lockPath = `${path}.lock`;
    const lease = await readDeliveryLease(lockPath);
    if (lease?.leaseId !== leaseId) return false;
    const existing = await this.alertDelivery(parsed.alertId, parsed.sinkId);
    if (existing?.status === "DELIVERED") return false;
    const temporaryPath = `${path}.${safeFilePart(leaseId)}.tmp`;
    await writeFile(temporaryPath, `${JSON.stringify(parsed, null, 2)}\n`, "utf8");
    const confirmedLease = await readDeliveryLease(lockPath);
    if (confirmedLease?.leaseId !== leaseId) {
      await unlink(temporaryPath).catch(() => undefined);
      return false;
    }
    await rename(temporaryPath, path);
    await unlink(lockPath).catch((error: NodeJS.ErrnoException) => {
      if (error.code !== "ENOENT") throw error;
    });
    return true;
  }

  async alertDelivery(alertId: string, sinkId: string): Promise<LiveAlertDelivery | null> {
    const path = join(this.directory, "deliveries", `${safeFilePart(sinkId)}-${safeFilePart(alertId)}.json`);
    try {
      return liveAlertDeliverySchema.parse(JSON.parse(await readFile(path, "utf8")));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw error;
    }
  }

  async alertDeliveries(options: { limit?: number; status?: AlertDeliveryStatus } = {}): Promise<LiveAlertDelivery[]> {
    const files = await listJsonFiles(join(this.directory, "deliveries"));
    const deliveries = await Promise.all(files.map(async (file) =>
      liveAlertDeliverySchema.parse(JSON.parse(await readFile(join(this.directory, "deliveries", file), "utf8"))),
    ));
    return deliveries
      .filter((delivery) => !options.status || delivery.status === options.status)
      .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt))
      .slice(0, boundedLimit(options.limit));
  }

  async databaseHealth(): Promise<{ state: "HEALTHY"; latencyMs: number; reason: null }> {
    await this.ensureDirectories();
    return { state: "HEALTHY", latencyMs: 0, reason: null };
  }

  private async readObservations() {
    const directory = join(this.directory, "observations");
    const files = await listJsonFiles(directory);
    return Promise.all(files.map(async (file) =>
      liveSnapshotObservationSchema.parse(JSON.parse(await readFile(join(directory, file), "utf8"))),
    ));
  }

  private async ensureDirectories(): Promise<void> {
    await Promise.all([
      mkdir(join(this.directory, "snapshots"), { recursive: true }),
      mkdir(join(this.directory, "observations"), { recursive: true }),
      mkdir(join(this.directory, "alerts"), { recursive: true }),
      mkdir(join(this.directory, "operations"), { recursive: true }),
      mkdir(join(this.directory, "deliveries"), { recursive: true }),
    ]);
  }
}

async function writeImmutable(path: string, value: unknown): Promise<boolean> {
  try {
    await writeFile(path, `${JSON.stringify(value, null, 2)}\n`, {
      encoding: "utf8",
      flag: "wx",
    });
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EEXIST") return false;
    throw error;
  }
}

async function listJsonFiles(directory: string): Promise<string[]> {
  try {
    return (await readdir(directory)).filter((file) => file.endsWith(".json"));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
}

function fileName(hash: string): string {
  if (!/^0x[0-9a-fA-F]{64}$/.test(hash)) throw new Error("Invalid snapshot hash.");
  return `${hash.toLowerCase()}.json`;
}

function boundedLimit(limit = 50): number {
  return Math.max(1, Math.min(250, Math.floor(limit)));
}

function safeFilePart(value: string): string {
  return value.replace(/[^a-zA-Z0-9_.-]/g, "_");
}

async function readDeliveryLease(path: string): Promise<{ leaseId?: string; leaseExpiresAt?: string } | null> {
  try {
    return JSON.parse(await readFile(path, "utf8")) as { leaseId?: string; leaseExpiresAt?: string };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
}
