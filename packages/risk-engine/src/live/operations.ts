import { z } from "zod";
import { shortId } from "../domain/hash.js";
import {
  hex32Schema,
  isoTimestampSchema,
  uintStringSchema,
} from "../domain/schemas.js";
import type {
  ArchivedLiveSnapshot,
  LiveAlert,
  LiveArchiveHistoryEntry,
} from "./archive-schemas.js";
import type { LiveSnapshotArchive } from "./archive.js";
import {
  executionStagingHealthSchema,
  type ExecutionStagingHealth,
} from "../staging/schemas.js";

export const operationalHealthStateSchema = z.enum([
  "HEALTHY",
  "DEGRADED",
  "UNAVAILABLE",
]);

export const operationalEventTypeSchema = z.enum([
  "POLL_SUCCEEDED",
  "POLL_FAILED",
  "POLL_SKIPPED_OVERLAP",
  "ARCHIVE_WRITE_FAILED",
  "ALERTS_EVALUATED",
  "ALERT_DELIVERY_ATTEMPTED",
  "ALERT_DELIVERY_SUCCEEDED",
  "ALERT_DELIVERY_FAILED",
]);

export const liveOperationalEventSchema = z.object({
  schemaVersion: z.literal(1),
  eventId: z.string().min(1),
  eventType: operationalEventTypeSchema,
  healthState: operationalHealthStateSchema,
  snapshotHash: hex32Schema.nullable(),
  block: uintStringSchema.nullable(),
  startedAt: isoTimestampSchema,
  completedAt: isoTimestampSchema,
  durationMs: z.number().int().nonnegative(),
  consecutiveFailures: z.number().int().nonnegative(),
  payload: z.record(z.string(), z.unknown()),
  createdAt: isoTimestampSchema,
});

export const alertDeliveryStatusSchema = z.enum([
  "PENDING",
  "DELIVERED",
  "FAILED",
]);

export const liveAlertDeliverySchema = z.object({
  schemaVersion: z.literal(1),
  alertId: z.string().min(1),
  sinkId: z.string().min(1),
  idempotencyKey: z.string().min(1),
  status: alertDeliveryStatusSchema,
  attempts: z.number().int().nonnegative(),
  responseStatus: z.number().int().nullable(),
  lastError: z.string().nullable(),
  lastAttemptAt: isoTimestampSchema.nullable(),
  nextAttemptAt: isoTimestampSchema.nullable(),
  deliveredAt: isoTimestampSchema.nullable(),
  createdAt: isoTimestampSchema,
  updatedAt: isoTimestampSchema,
});

export const liveOperationalHealthSchema = z.object({
  schemaVersion: z.literal(1),
  runtimeMode: z.literal("LIVE_READ_ONLY"),
  broadcastPermitted: z.literal(false),
  transactionSubmitted: z.literal(false),
  poller: z.object({
    state: operationalHealthStateSchema,
    lastSuccessfulObservationAt: isoTimestampSchema.nullable(),
    lastAttemptAt: isoTimestampSchema.nullable(),
    consecutiveFailures: z.number().int().nonnegative(),
    lastError: z.string().nullable(),
  }),
  archive: z.object({
    state: operationalHealthStateSchema,
    lastSuccessfulSnapshotHash: hex32Schema.nullable(),
    lastWriteAt: isoTimestampSchema.nullable(),
    reason: z.string().nullable(),
  }),
  rpc: z.object({
    state: operationalHealthStateSchema,
    latencyMs: z.number().int().nonnegative().nullable(),
    lastBlock: uintStringSchema.nullable(),
    headBlock: uintStringSchema.nullable(),
    indexedThroughBlock: uintStringSchema.nullable(),
    indexLagBlocks: uintStringSchema.nullable(),
    provider: z.string().url().nullable(),
    failureCount: z.number().int().nonnegative(),
    reason: z.string().nullable(),
  }),
  oracle: z.object({
    state: operationalHealthStateSchema,
    ageSeconds: z.number().nonnegative().nullable(),
    reason: z.string().nullable(),
  }),
  source: z.object({
    state: operationalHealthStateSchema,
    ageSeconds: z.number().nonnegative().nullable(),
    reason: z.string().nullable(),
  }),
  alertDelivery: z.object({
    state: operationalHealthStateSchema,
    pending: z.number().int().nonnegative(),
    failed: z.number().int().nonnegative(),
    delivered: z.number().int().nonnegative(),
    reason: z.string().nullable(),
  }),
  database: z.object({
    state: operationalHealthStateSchema,
    latencyMs: z.number().int().nonnegative().nullable(),
    reason: z.string().nullable(),
  }),
  executionStaging: executionStagingHealthSchema,
  current: z.object({
    snapshotHash: hex32Schema.nullable(),
    observedAt: isoTimestampSchema.nullable(),
    ageSeconds: z.number().nonnegative().nullable(),
    archiveStatus: z.string().nullable(),
    healthFactorWad: uintStringSchema.nullable(),
    debtBalanceWei: uintStringSchema.nullable(),
    collateralBalanceWei: uintStringSchema.nullable(),
    liquidityExecutable: z.boolean().nullable(),
  }),
  metrics: z.object({
    pollSuccesses: z.number().int().nonnegative(),
    pollFailures: z.number().int().nonnegative(),
    archiveWriteFailures: z.number().int().nonnegative(),
    alertsGenerated: z.number().int().nonnegative(),
    alertsDeduplicated: z.number().int().nonnegative(),
    alertDeliveryAttempts: z.number().int().nonnegative(),
    alertDeliveryFailures: z.number().int().nonnegative(),
    pollDurationMs: z.number().int().nonnegative().nullable(),
    archiveLagSeconds: z.number().nonnegative().nullable(),
    snapshotStatusCounts: z.object({
      COMPLETE: z.number().int().nonnegative(),
      STALE: z.number().int().nonnegative(),
      INVALID: z.number().int().nonnegative(),
      UNAVAILABLE: z.number().int().nonnegative(),
    }),
  }),
  generatedAt: isoTimestampSchema,
});

export type OperationalHealthState = z.infer<typeof operationalHealthStateSchema>;
export type OperationalEventType = z.infer<typeof operationalEventTypeSchema>;
export type LiveOperationalEvent = z.infer<typeof liveOperationalEventSchema>;
export type AlertDeliveryStatus = z.infer<typeof alertDeliveryStatusSchema>;
export type LiveAlertDelivery = z.infer<typeof liveAlertDeliverySchema>;
export type LiveOperationalHealth = z.infer<typeof liveOperationalHealthSchema>;

export interface LiveOperationalStore {
  saveOperationalEvent(event: LiveOperationalEvent): Promise<{ inserted: boolean }>;
  operationalEvents(options?: { limit?: number; before?: string }): Promise<LiveOperationalEvent[]>;
  saveAlertDelivery(delivery: LiveAlertDelivery): Promise<{ inserted: boolean }>;
  claimAlertDelivery(
    delivery: LiveAlertDelivery,
    lease: { leaseId: string; claimedAt: string; leaseExpiresAt: string },
  ): Promise<boolean>;
  completeAlertDelivery(delivery: LiveAlertDelivery, leaseId: string): Promise<boolean>;
  alertDelivery(alertId: string, sinkId: string): Promise<LiveAlertDelivery | null>;
  alertDeliveries(options?: { limit?: number; status?: AlertDeliveryStatus }): Promise<LiveAlertDelivery[]>;
  databaseHealth(): Promise<{ state: OperationalHealthState; latencyMs: number | null; reason: string | null }>;
}

export type LiveOperationalArchive = LiveSnapshotArchive & LiveOperationalStore;

export function createOperationalEvent(input: {
  eventType: OperationalEventType;
  healthState: OperationalHealthState;
  snapshotHash?: string | null;
  block?: string | null;
  startedAt: string;
  completedAt: string;
  durationMs: number;
  consecutiveFailures?: number;
  payload?: Record<string, unknown>;
  createdAt?: string;
}): LiveOperationalEvent {
  const createdAt = input.createdAt ?? input.completedAt;
  const identity = {
    eventType: input.eventType,
    snapshotHash: input.snapshotHash ?? null,
    block: input.block ?? null,
    startedAt: input.startedAt,
    completedAt: input.completedAt,
    payload: input.payload ?? {},
  };
  return liveOperationalEventSchema.parse({
    schemaVersion: 1,
    eventId: shortId("operation", identity),
    eventType: input.eventType,
    healthState: input.healthState,
    snapshotHash: input.snapshotHash ?? null,
    block: input.block ?? null,
    startedAt: input.startedAt,
    completedAt: input.completedAt,
    durationMs: Math.max(0, Math.floor(input.durationMs)),
    consecutiveFailures: Math.max(0, Math.floor(input.consecutiveFailures ?? 0)),
    payload: input.payload ?? {},
    createdAt,
  });
}

export function createAlertDelivery(input: {
  alert: LiveAlert;
  sinkId: string;
  now: string;
  status?: AlertDeliveryStatus;
  attempts?: number;
  responseStatus?: number | null;
  lastError?: string | null;
  lastAttemptAt?: string | null;
  nextAttemptAt?: string | null;
  deliveredAt?: string | null;
  createdAt?: string;
}): LiveAlertDelivery {
  const idempotencyKey = `${input.sinkId}:${input.alert.alertId}`;
  return liveAlertDeliverySchema.parse({
    schemaVersion: 1,
    alertId: input.alert.alertId,
    sinkId: input.sinkId,
    idempotencyKey,
    status: input.status ?? "PENDING",
    attempts: Math.max(0, Math.floor(input.attempts ?? 0)),
    responseStatus: input.responseStatus ?? null,
    lastError: input.lastError ?? null,
    lastAttemptAt: input.lastAttemptAt ?? null,
    nextAttemptAt: input.nextAttemptAt ?? null,
    deliveredAt: input.deliveredAt ?? null,
    createdAt: input.createdAt ?? input.now,
    updatedAt: input.now,
  });
}

export function buildOperationalHealth(input: {
  current: LiveArchiveHistoryEntry | null;
  history?: readonly LiveArchiveHistoryEntry[];
  events: readonly LiveOperationalEvent[];
  deliveries: readonly LiveAlertDelivery[];
  databaseHealth?: {
    state: OperationalHealthState;
    latencyMs: number | null;
    reason: string | null;
  };
  now?: Date;
  pollFailureThreshold?: number;
  pollIntervalSeconds?: number;
  executionStaging?: ExecutionStagingHealth;
  rpcHead?: {
    blockNumber: string | null;
    provider: string | null;
    latencyMs: number | null;
    reason: string | null;
  };
}): LiveOperationalHealth {
  const now = input.now ?? new Date();
  const events = [...input.events].sort((left, right) => right.createdAt.localeCompare(left.createdAt));
  const latestSuccess = events.find((event) => event.eventType === "POLL_SUCCEEDED");
  const pollAttempts = events.filter((event) =>
    event.eventType === "POLL_SUCCEEDED" || event.eventType === "POLL_FAILED"
  );
  const latestAttempt = pollAttempts[0];
  const latestFailure = latestAttempt?.eventType === "POLL_FAILED" ? latestAttempt : undefined;
  const failureCount = latestFailure?.consecutiveFailures ?? 0;
  const threshold = input.pollFailureThreshold ?? 3;
  const eventPollerState: OperationalHealthState = !latestAttempt
    ? "UNAVAILABLE"
    : latestAttempt.eventType === "POLL_FAILED"
      ? failureCount >= threshold ? "UNAVAILABLE" : "DEGRADED"
      : latestAttempt.healthState;
  const current = input.current;
  const currentSnapshot = current?.snapshot ?? null;
  const currentAgeSeconds = current
    ? Math.max(0, (now.getTime() - new Date(current.observation.observedAt).getTime()) / 1_000)
    : null;
  const archiveLagSeconds = current
    ? Math.max(
        0,
        (new Date(current.observation.observedAt).getTime() -
          new Date(current.snapshot.timestamp).getTime()) / 1_000,
      )
    : null;
  const pollIntervalSeconds = Math.max(60, input.pollIntervalSeconds ?? 300);
  const agePollerState: OperationalHealthState | null = currentAgeSeconds === null
    ? null
    : currentAgeSeconds > pollIntervalSeconds * 3
      ? "UNAVAILABLE"
      : currentAgeSeconds > pollIntervalSeconds * 2
        ? "DEGRADED"
        : "HEALTHY";
  const pollerState = worstHealthState(eventPollerState, agePollerState);
  const xlayer = currentSnapshot?.freshness.adapters.find((adapter) => adapter.adapter === "xlayer");
  const oracle = currentSnapshot?.freshness.adapters.find((adapter) => adapter.adapter === "oracle");
  const rwa = currentSnapshot?.freshness.adapters.find((adapter) => adapter.adapter === "rwa");
  const latestPollPayload = latestSuccess?.payload ?? {};
  const failed = input.deliveries.filter((delivery) => delivery.status === "FAILED").length;
  const pending = input.deliveries.filter((delivery) => delivery.status === "PENDING").length;
  const delivered = input.deliveries.filter((delivery) => delivery.status === "DELIVERED").length;
  const snapshotStatusCounts = {
    COMPLETE: 0,
    STALE: 0,
    INVALID: 0,
    UNAVAILABLE: 0,
  };
  for (const entry of input.history ?? (current ? [current] : [])) {
    snapshotStatusCounts[entry.snapshot.archiveStatus] += 1;
  }
  const archiveState: OperationalHealthState = currentSnapshot
    ? currentSnapshot.archiveStatus === "COMPLETE" ? "HEALTHY" : "DEGRADED"
    : "UNAVAILABLE";
  const sourceAge = currentSnapshot?.rwaEvidence?.latestRetrievedAt
    ? Math.max(0, (now.getTime() - new Date(currentSnapshot.rwaEvidence.latestRetrievedAt).getTime()) / 1_000)
    : null;
  const oracleAge = oracle?.freshness.ageSeconds ?? null;
  const deliveryState: OperationalHealthState = failed > 0 ? "DEGRADED" : pending > 0 ? "DEGRADED" : "HEALTHY";
  const indexedThroughBlock = currentSnapshot?.observedBlock ?? null;
  const headBlock = input.rpcHead?.blockNumber ?? indexedThroughBlock;
  const indexLagBlocks = blockLag(headBlock, indexedThroughBlock);
  const rpcState = input.rpcHead?.reason
    ? worstHealthState(
      xlayer?.status === "AVAILABLE" ? "HEALTHY" : xlayer?.status === "STALE" ? "DEGRADED" : "UNAVAILABLE",
      "DEGRADED",
    )
    : xlayer?.status === "AVAILABLE" ? "HEALTHY" : xlayer?.status === "STALE" ? "DEGRADED" : "UNAVAILABLE";
  return liveOperationalHealthSchema.parse({
    schemaVersion: 1,
    runtimeMode: "LIVE_READ_ONLY",
    broadcastPermitted: false,
    transactionSubmitted: false,
    poller: {
      state: pollerState,
      lastSuccessfulObservationAt: latestSuccess?.completedAt ??
        (currentSnapshot?.archiveStatus === "COMPLETE" ? current?.observation.observedAt ?? null : null),
      lastAttemptAt: latestAttempt?.completedAt ?? null,
      consecutiveFailures: failureCount,
      lastError: stringOrNull(latestFailure?.payload.error),
    },
    archive: {
      state: archiveState,
      lastSuccessfulSnapshotHash: latestSuccess?.snapshotHash ??
        (currentSnapshot?.archiveStatus === "COMPLETE" ? currentSnapshot.snapshotHash : null),
      lastWriteAt: latestSuccess?.completedAt ?? current?.observation.observedAt ?? null,
      reason: currentSnapshot?.archiveStatus === "COMPLETE"
        ? null
        : currentSnapshot?.consistencyReasons.join(" ") ?? "No complete snapshot is archived.",
    },
    rpc: {
      state: rpcState,
      latencyMs: input.rpcHead?.latencyMs ?? numberOrNull(latestPollPayload.rpcLatencyMs),
      lastBlock: indexedThroughBlock,
      headBlock,
      indexedThroughBlock,
      indexLagBlocks,
      provider: input.rpcHead?.provider ?? null,
      failureCount: events.filter((event) => event.eventType === "POLL_FAILED").length,
      reason: input.rpcHead?.reason ?? xlayer?.message ?? null,
    },
    oracle: {
      state: oracle?.status === "AVAILABLE" ? "HEALTHY" : oracle?.status === "STALE" ? "DEGRADED" : "UNAVAILABLE",
      ageSeconds: oracleAge,
      reason: oracle?.message ?? null,
    },
    source: {
      state: rwa?.status === "AVAILABLE" ? "HEALTHY" : rwa?.status === "STALE" ? "DEGRADED" : "UNAVAILABLE",
      ageSeconds: sourceAge,
      reason: rwa?.message ?? null,
    },
    alertDelivery: {
      state: deliveryState,
      pending,
      failed,
      delivered,
      reason: failed > 0 ? "One or more alert deliveries failed." : null,
    },
    database: {
      state: input.databaseHealth?.state ?? "HEALTHY",
      latencyMs: input.databaseHealth?.latencyMs ?? null,
      reason: input.databaseHealth?.reason ?? null,
    },
    executionStaging: input.executionStaging ?? disabledExecutionStagingHealth(now),
    current: {
      snapshotHash: currentSnapshot?.snapshotHash ?? null,
      observedAt: current?.observation.observedAt ?? null,
      ageSeconds: currentAgeSeconds,
      archiveStatus: currentSnapshot?.archiveStatus ?? null,
      healthFactorWad: currentSnapshot?.position?.healthFactorWad ?? null,
      debtBalanceWei: currentSnapshot?.position?.debtBalanceWei ?? null,
      collateralBalanceWei: currentSnapshot?.position?.collateralBalanceWei ?? null,
      liquidityExecutable: currentSnapshot?.liquidity?.executable ?? null,
    },
    metrics: {
      pollSuccesses: events.filter((event) => event.eventType === "POLL_SUCCEEDED").length,
      pollFailures: events.filter((event) => event.eventType === "POLL_FAILED").length,
      archiveWriteFailures: events.filter((event) => event.eventType === "ARCHIVE_WRITE_FAILED").length,
      alertsGenerated: events
        .filter((event) => event.eventType === "ALERTS_EVALUATED")
        .reduce((sum, event) => sum + numberOrZero(event.payload.inserted), 0),
      alertsDeduplicated: events
        .filter((event) => event.eventType === "ALERTS_EVALUATED")
        .reduce((sum, event) => sum + numberOrZero(event.payload.duplicates), 0),
      alertDeliveryAttempts: events
        .filter((event) => event.eventType === "ALERT_DELIVERY_ATTEMPTED")
        .length,
      alertDeliveryFailures: events
        .filter((event) => event.eventType === "ALERT_DELIVERY_FAILED")
        .length,
      pollDurationMs: latestSuccess?.durationMs ?? null,
      archiveLagSeconds,
      snapshotStatusCounts,
    },
    generatedAt: now.toISOString(),
  });
}

export async function readOperationalHealth(
  archive: LiveOperationalArchive,
  options: {
    now?: Date;
    historyLimit?: number;
    eventLimit?: number;
    deliveryLimit?: number;
    pollIntervalSeconds?: number;
    executionStaging?: ExecutionStagingHealth;
    rpcHead?: {
      blockNumber: string | null;
      provider: string | null;
      latencyMs: number | null;
      reason: string | null;
    };
  } = {},
): Promise<LiveOperationalHealth> {
  const [current, history, events, deliveries, databaseHealth] = await Promise.all([
    archive.current(),
    archive.history({ limit: options.historyLimit ?? 250 }),
    archive.operationalEvents({ limit: options.eventLimit ?? 250 }),
    archive.alertDeliveries({ limit: options.deliveryLimit ?? 250 }),
    archive.databaseHealth(),
  ]);
  return buildOperationalHealth({
    current,
    history,
    events,
    deliveries,
    databaseHealth,
    now: options.now,
    pollIntervalSeconds: options.pollIntervalSeconds,
    executionStaging: options.executionStaging,
    rpcHead: options.rpcHead,
  });
}

function disabledExecutionStagingHealth(now: Date): ExecutionStagingHealth {
  return executionStagingHealthSchema.parse({
    schemaVersion: 1,
    configured: false,
    environment: "DISABLED",
    state: "HEALTHY",
    submissionPermitted: false,
    latestIntent: null,
    latestSimulation: null,
    latestReservation: null,
    latestSubmission: null,
    lastError: null,
    lastEventAt: null,
    generatedAt: now.toISOString(),
  });
}

function worstHealthState(
  left: OperationalHealthState,
  right: OperationalHealthState | null,
): OperationalHealthState {
  if (right === null) return left;
  const rank: Record<OperationalHealthState, number> = {
    HEALTHY: 0,
    DEGRADED: 1,
    UNAVAILABLE: 2,
  };
  return rank[left] >= rank[right] ? left : right;
}

function numberOrZero(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? Math.max(0, Math.floor(value)) : 0;
}

function numberOrNull(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? Math.max(0, Math.floor(value)) : null;
}

function blockLag(headBlock: string | null, indexedThroughBlock: string | null): string | null {
  if (!headBlock || !indexedThroughBlock || !/^\d+$/u.test(headBlock) || !/^\d+$/u.test(indexedThroughBlock)) {
    return null;
  }
  const head = BigInt(headBlock);
  const indexed = BigInt(indexedThroughBlock);
  return (head >= indexed ? head - indexed : 0n).toString();
}

function stringOrNull(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value : null;
}
