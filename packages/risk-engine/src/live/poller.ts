import type { LiveAlert } from "./archive-schemas.js";
import {
  buildArchivedLiveSnapshot,
  type LiveSnapshotArchive,
} from "./archive.js";
import { evaluateLiveAlerts, type LiveAlertConfig } from "./alerts.js";
import {
  createOperationalEvent,
  type LiveOperationalStore,
  type OperationalHealthState,
} from "./operations.js";
import type { LiveSnapshotEnvelope } from "./schemas.js";
import type { AlertDeliveryRunResult } from "./alert-delivery.js";
import { operationalErrorMessage } from "./redaction.js";

export interface LivePollResult {
  envelope: LiveSnapshotEnvelope;
  archived: Awaited<ReturnType<LiveSnapshotArchive["archive"]>>;
  alerts: LiveAlert[];
  delivery?: AlertDeliveryRunResult;
  durationMs: number;
  healthState: OperationalHealthState;
}

export interface LivePollerHealth {
  state: OperationalHealthState;
  lastAttemptAt: string | null;
  lastSuccessfulObservationAt: string | null;
  consecutiveFailures: number;
  lastError: string | null;
  lastArchiveStatus: string | null;
}

export interface LivePollerOptions {
  read: () => Promise<LiveSnapshotEnvelope>;
  archive: LiveSnapshotArchive & Partial<LiveOperationalStore>;
  now?: () => Date;
  alertConfig?: Partial<LiveAlertConfig>;
  onResult?: (result: LivePollResult) => void | Promise<void>;
  readTimeoutMs?: number;
  archiveTimeoutMs?: number;
  maxAttempts?: number;
  retryBackoffMs?: number;
  maxRetryBackoffMs?: number;
  failureThreshold?: number;
  sleep?: (milliseconds: number) => Promise<void>;
  deliverAlerts?: (alerts: readonly LiveAlert[]) => Promise<AlertDeliveryRunResult>;
}

export class LiveSnapshotPoller {
  private stopped = false;
  private activePoll: Promise<LivePollResult> | null = null;
  private consecutiveFailures = 0;
  private lastAttemptAt: string | null = null;
  private lastSuccessfulObservationAt: string | null = null;
  private lastError: string | null = null;
  private lastArchiveStatus: string | null = null;

  constructor(private readonly options: LivePollerOptions) {}

  getHealth(): LivePollerHealth {
    const threshold = this.options.failureThreshold ?? 3;
    const state: OperationalHealthState = this.lastSuccessfulObservationAt === null
      ? "UNAVAILABLE"
      : this.consecutiveFailures >= threshold
        ? "UNAVAILABLE"
        : this.consecutiveFailures > 0 || this.lastArchiveStatus !== "COMPLETE"
          ? "DEGRADED"
          : "HEALTHY";
    return {
      state,
      lastAttemptAt: this.lastAttemptAt,
      lastSuccessfulObservationAt: this.lastSuccessfulObservationAt,
      consecutiveFailures: this.consecutiveFailures,
      lastError: this.lastError,
      lastArchiveStatus: this.lastArchiveStatus,
    };
  }

  async pollOnce(): Promise<LivePollResult> {
    if (this.activePoll) {
      const now = this.now().toISOString();
      await this.recordEvent(createOperationalEvent({
        eventType: "POLL_SKIPPED_OVERLAP",
        healthState: this.getHealth().state,
        startedAt: now,
        completedAt: now,
        durationMs: 0,
        consecutiveFailures: this.consecutiveFailures,
        payload: { reason: "A poll cycle is already in progress." },
      }));
      return this.activePoll;
    }
    const active = this.executePoll();
    this.activePoll = active;
    try {
      return await active;
    } finally {
      if (this.activePoll === active) this.activePoll = null;
    }
  }

  async run(intervalSeconds: number, signal?: AbortSignal): Promise<void> {
    if (!Number.isFinite(intervalSeconds) || intervalSeconds < 60) {
      throw new Error("Live polling interval must be at least 60 seconds.");
    }
    this.stopped = false;
    while (!this.stopped && !signal?.aborted) {
      try {
        await this.pollOnce();
      } catch {
        // A transient observation failure is represented in health state; the loop remains alive.
      }
      await wait(intervalSeconds * 1_000, signal);
    }
  }

  stop(): void {
    this.stopped = true;
  }

  private async executePoll(): Promise<LivePollResult> {
    const startedAt = this.now();
    this.lastAttemptAt = startedAt.toISOString();
    let stage = "CURRENT_READ";
    try {
      const previous = await this.withArchiveTimeout(
        () => this.options.archive.current(),
        "Reading the current archived observation timed out.",
      );
      const readStartedAt = Date.now();
      stage = "ADAPTER_READ";
      const envelope = await this.withRetry(
        () => withTimeout(
          this.options.read(),
          this.options.readTimeoutMs ?? 120_000,
          "Live adapter read timed out.",
        ),
      );
      const readDurationMs = Date.now() - readStartedAt;
      stage = "SNAPSHOT_ARCHIVE";
      const record = buildArchivedLiveSnapshot(envelope, envelope.generatedAt);
      const archived = await this.withArchiveTimeout(
        () => this.options.archive.archive(record, envelope.generatedAt),
        "Writing the canonical observation timed out.",
      );
      stage = "ALERT_EVALUATION";
      const alerts = evaluateLiveAlerts({
        previous: previous?.snapshot ?? null,
        current: archived.entry.snapshot,
        now: this.now().toISOString(),
        config: this.options.alertConfig,
      });
      stage = "ALERT_ARCHIVE";
      const alertResult = await this.withArchiveTimeout(
        () => this.options.archive.saveAlerts(alerts),
        "Writing live alerts timed out.",
      );
      let delivery: AlertDeliveryRunResult | undefined;
      let healthState: OperationalHealthState = archived.entry.snapshot.archiveStatus === "COMPLETE"
        ? "HEALTHY"
        : "DEGRADED";
      if (this.options.deliverAlerts && alertResult.inserted.length > 0) {
        stage = "ALERT_DELIVERY";
        try {
          delivery = await this.options.deliverAlerts(alertResult.inserted);
          if (delivery.failed > 0) healthState = "DEGRADED";
        } catch (error) {
          healthState = "DEGRADED";
          await this.recordEvent(createOperationalEvent({
            eventType: "ALERT_DELIVERY_FAILED",
            healthState,
            snapshotHash: archived.entry.snapshot.snapshotHash,
            block: archived.entry.snapshot.observedBlock,
            startedAt: this.now().toISOString(),
            completedAt: this.now().toISOString(),
            durationMs: 0,
            consecutiveFailures: 0,
            payload: { error: errorMessage(error) },
          }));
        }
      }
      const durationMs = Math.max(0, Date.now() - startedAt.getTime());
      this.consecutiveFailures = 0;
      this.lastError = null;
      this.lastArchiveStatus = archived.entry.snapshot.archiveStatus;
      this.lastSuccessfulObservationAt = archived.entry.observation.observedAt;
      await this.recordEvent(createOperationalEvent({
        eventType: "POLL_SUCCEEDED",
        healthState,
        snapshotHash: archived.entry.snapshot.snapshotHash,
        block: archived.entry.snapshot.observedBlock,
        startedAt: startedAt.toISOString(),
        completedAt: this.now().toISOString(),
        durationMs,
        consecutiveFailures: 0,
        payload: {
          readDurationMs,
          rpcLatencyMs: envelope.adapters.find((adapter) => adapter.adapter === "xlayer")?.latencyMs ?? null,
          archiveStatus: archived.entry.snapshot.archiveStatus,
          snapshotInserted: archived.inserted,
          observationInserted: archived.observationInserted,
          deliveryFailed: delivery?.failed ?? null,
        },
      }));
      await this.recordEvent(createOperationalEvent({
        eventType: "ALERTS_EVALUATED",
        healthState,
        snapshotHash: archived.entry.snapshot.snapshotHash,
        block: archived.entry.snapshot.observedBlock,
        startedAt: startedAt.toISOString(),
        completedAt: this.now().toISOString(),
        durationMs: 0,
        payload: {
          generated: alerts.length,
          inserted: alertResult.inserted.length,
          duplicates: alertResult.duplicates.length,
        },
      }));
      const result: LivePollResult = {
        envelope,
        archived,
        alerts: alertResult.inserted,
        delivery,
        durationMs,
        healthState,
      };
      await this.options.onResult?.(result);
      return result;
    } catch (error) {
      this.consecutiveFailures += 1;
      this.lastError = errorMessage(error);
      await this.recordEvent(createOperationalEvent({
        eventType: stage === "SNAPSHOT_ARCHIVE" || stage === "ALERT_ARCHIVE"
          ? "ARCHIVE_WRITE_FAILED"
          : "POLL_FAILED",
        healthState: this.consecutiveFailures >= (this.options.failureThreshold ?? 3)
          ? "UNAVAILABLE"
          : "DEGRADED",
        startedAt: startedAt.toISOString(),
        completedAt: this.now().toISOString(),
        durationMs: Math.max(0, Date.now() - startedAt.getTime()),
        consecutiveFailures: this.consecutiveFailures,
        payload: {
          error: this.lastError,
          stage,
        },
      }));
      if (stage === "SNAPSHOT_ARCHIVE" || stage === "ALERT_ARCHIVE") {
        await this.recordEvent(createOperationalEvent({
          eventType: "POLL_FAILED",
          healthState: this.consecutiveFailures >= (this.options.failureThreshold ?? 3)
            ? "UNAVAILABLE"
            : "DEGRADED",
          startedAt: startedAt.toISOString(),
          completedAt: this.now().toISOString(),
          durationMs: Math.max(0, Date.now() - startedAt.getTime()),
          consecutiveFailures: this.consecutiveFailures,
          payload: { error: this.lastError, stage },
        }));
      }
      throw error;
    }
  }

  private now(): Date {
    return this.options.now?.() ?? new Date();
  }

  private async withArchiveTimeout<T>(operation: () => Promise<T>, message: string): Promise<T> {
    return withTimeout(operation(), this.options.archiveTimeoutMs ?? 30_000, message);
  }

  private async withRetry<T>(operation: () => Promise<T>): Promise<T> {
    const maxAttempts = boundedInteger(this.options.maxAttempts ?? 2, 1, 5);
    const base = boundedInteger(this.options.retryBackoffMs ?? 500, 0, 30_000);
    const maximum = boundedInteger(this.options.maxRetryBackoffMs ?? 5_000, base, 60_000);
    let attempt = 0;
    while (true) {
      attempt += 1;
      try {
        return await operation();
      } catch (error) {
        if (attempt >= maxAttempts) throw error;
        const delay = Math.min(maximum, base * 2 ** (attempt - 1));
        await (this.options.sleep ?? defaultSleep)(delay);
      }
    }
  }

  private async recordEvent(event: ReturnType<typeof createOperationalEvent>): Promise<void> {
    try {
      await this.options.archive.saveOperationalEvent?.(event);
    } catch {
      // Operational storage failure must not turn a valid read-only snapshot into a false one.
    }
  }
}

function withTimeout<T>(promise: Promise<T>, milliseconds: number, message: string): Promise<T> {
  const timeoutMs = boundedInteger(milliseconds, 1, 300_000);
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(message)), timeoutMs);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error) => {
        clearTimeout(timer);
        reject(error);
      },
    );
  });
}

function wait(milliseconds: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal?.aborted) {
      resolve();
      return;
    }
    const timer = setTimeout(resolve, milliseconds);
    signal?.addEventListener("abort", () => {
      clearTimeout(timer);
      resolve();
    }, { once: true });
  });
}

function defaultSleep(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function boundedInteger(value: number, minimum: number, maximum: number): number {
  if (!Number.isFinite(value)) return minimum;
  return Math.max(minimum, Math.min(maximum, Math.floor(value)));
}

function errorMessage(error: unknown): string {
  return operationalErrorMessage(error);
}
