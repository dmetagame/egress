import "server-only";

import {
  createLiveAlertDeliveryService,
  createLiveRevisionStore,
  createLiveSnapshotArchive,
  liveSnapshotEnvelopeSchema,
  LiveRiskSnapshotService,
  LiveSnapshotPoller,
  readOperationalHealth,
  operationalErrorMessage,
  readLiveRuntimeConfig as readSharedLiveRuntimeConfig,
  liveOperationalHealthSchema,
  XLayerReadAdapter,
  type AdapterHealth,
  type LiveAlert,
  type LiveArchiveHistoryEntry,
  type LiveRuntimeConfig,
  type LiveSnapshotEnvelope,
  type LiveOperationalHealth,
  PostgresExecutionStagingStore,
  readExecutionStagingConfig,
  readExecutionStagingHealth,
} from "@egress/risk-engine";

export type { LiveRuntimeConfig };

export interface LiveArchiveDashboard {
  envelope: LiveSnapshotEnvelope;
  current: LiveArchiveHistoryEntry | null;
  history: LiveArchiveHistoryEntry[];
  alerts: LiveAlert[];
  archiveAvailable: boolean;
  reasons: string[];
}

export interface LiveCurrentApiResponse {
  mode: "LIVE_READ_ONLY";
  status: "COMPLETE" | "STALE" | "INVALID" | "UNAVAILABLE";
  snapshotHash: string | null;
  block: string | null;
  blockHash: string | null;
  timestamp: string;
  risk: {
    classification: string | null;
    evidenceStatus: string | null;
    confidence: number | null;
    summary: string | null;
  };
  freshness: LiveArchiveHistoryEntry["snapshot"]["freshness"] | null;
  provenance: string[];
  observation: LiveArchiveHistoryEntry["observation"] | null;
  snapshot: LiveCurrentArchiveSummary | null;
  envelope: LiveSnapshotEnvelope;
  reasons: string[];
  broadcastPermitted: false;
  transactionSubmitted: false;
}

export interface LiveCurrentArchiveSummary {
  snapshotHash: string;
  integrityHash: string;
  archiveStatus: LiveArchiveHistoryEntry["snapshot"]["archiveStatus"];
  consistencyStatus: LiveArchiveHistoryEntry["snapshot"]["consistencyStatus"];
  consistencyReasons: string[];
  integrityValid: boolean;
  observedBlock: string | null;
  blockHash: string | null;
  timestamp: string;
  sourceStates: Array<{
    sourceId: string;
    sourceUrl: string;
    revisionId: string;
    contentHash: string;
    retrievedAt: string;
  }>;
}

export interface LiveHistoryApiResponse {
  mode: "LIVE_READ_ONLY";
  items: Array<{
    observationId: string;
    snapshotHash: string;
    status: LiveArchiveHistoryEntry["snapshot"]["archiveStatus"];
    block: string | null;
    blockHash: string | null;
    timestamp: string;
    riskClassification: string | null;
    healthFactorWad: string | null;
    collateralBalanceWei: string | null;
    debtBalanceWei: string | null;
    sourceRevisionIds: string[];
    integrityHash: string;
  }>;
}

export interface LiveAlertsApiResponse {
  mode: "LIVE_READ_ONLY";
  items: LiveAlert[];
}

export interface LiveOperationsHealthApiResponse extends LiveOperationalHealth {}

const activePolls = new Map<string, Promise<void>>();

export function readLiveRuntimeConfig(
  environment: Readonly<Partial<NodeJS.ProcessEnv>> = process.env,
): LiveRuntimeConfig {
  return readSharedLiveRuntimeConfig(environment);
}

export async function getLiveReadOnlySnapshot(
  environment: Readonly<Partial<NodeJS.ProcessEnv>> = process.env,
): Promise<LiveSnapshotEnvelope> {
  const config = readLiveRuntimeConfig(environment);
  if (config.issues.length > 0) {
    return unavailableEnvelope(config.issues);
  }

  const result = await createSnapshotService(config).read();
  return liveSnapshotEnvelopeSchema.parse(result);
}

export async function getLiveArchiveDashboard(
  environment: Readonly<Partial<NodeJS.ProcessEnv>> = process.env,
  options: {
    forceRefresh?: boolean;
    refreshIfDue?: boolean;
    historyLimit?: number;
    alertLimit?: number;
    now?: Date;
  } = {},
): Promise<LiveArchiveDashboard> {
  const config = readLiveRuntimeConfig(environment);
  if (config.issues.length > 0) {
    return unavailableDashboard(config.issues);
  }

  try {
    const archive = createLiveSnapshotArchive(config);
    let current = await archive.current();
    const now = options.now ?? new Date();
    const currentAgeSeconds = current
      ? Math.max(0, (now.getTime() - new Date(current.observation.observedAt).getTime()) / 1_000)
      : Number.POSITIVE_INFINITY;
    if (
      config.inlinePollingPermitted &&
      (options.forceRefresh ||
        ((options.refreshIfDue ?? true) && currentAgeSeconds >= config.pollIntervalSeconds))
    ) {
      await pollArchiveSingleFlight(config, archive, now);
      current = await archive.current();
    }
    if (!current) {
      return unavailableDashboard(["No archived live observation is available."]);
    }
    const [history, alerts] = await Promise.all([
      archive.history({ limit: options.historyLimit ?? 20 }),
      archive.alerts({ limit: options.alertLimit ?? 30 }),
    ]);
    return {
      envelope: redactLiveEnvelopeForClient(current.snapshot.envelope),
      current,
      history,
      alerts,
      archiveAvailable: true,
      reasons: current.snapshot.archiveStatus === "COMPLETE"
        ? []
        : current.snapshot.envelope.reasons,
    };
  } catch (error) {
    const reason = error instanceof Error ? error.message.split("\n")[0] : "Live archive failed.";
    return unavailableDashboard([
      `Durable live archive unavailable: ${reason}`,
      "Historical data is not reused as current.",
    ]);
  }
}

export async function getLiveOperationalHealth(
  environment: Readonly<Partial<NodeJS.ProcessEnv>> = process.env,
  options: { now?: Date } = {},
): Promise<LiveOperationalHealth> {
  const config = readLiveRuntimeConfig(environment);
  if (config.issues.length > 0) return unavailableOperationalHealth(config.issues.join(" "));
  try {
    const archive = createLiveSnapshotArchive(config);
    const stagingConfig = readExecutionStagingConfig(environment);
    const stagingStore = stagingConfig.databaseUrl
      ? new PostgresExecutionStagingStore(stagingConfig.databaseUrl)
      : null;
    const executionStaging = await readExecutionStagingHealth(stagingConfig, stagingStore, options.now);
    return await readOperationalHealth(archive, {
      now: options.now,
      pollIntervalSeconds: config.pollIntervalSeconds,
      executionStaging,
      rpcHead: await readRpcHead(config),
    });
  } catch (error) {
    const reason = operationalErrorMessage(error);
    return unavailableOperationalHealth(`Operational health unavailable: ${reason}`);
  }
}

async function pollArchiveSingleFlight(
  config: LiveRuntimeConfig,
  archive: ReturnType<typeof createLiveSnapshotArchive>,
  now: Date,
): Promise<void> {
  const key = config.databaseUrl ? "postgres" : config.archivePath;
  const active = activePolls.get(key);
  if (active) return active;
  const alertDelivery = createLiveAlertDeliveryService(config, archive);
  const poll = new LiveSnapshotPoller({
    read: () => createSnapshotService(config).read(),
    archive,
    now: () => now,
    readTimeoutMs: config.pollReadTimeoutMs,
    archiveTimeoutMs: config.pollArchiveTimeoutMs,
    maxAttempts: config.pollMaxAttempts,
    retryBackoffMs: config.pollRetryBackoffMs,
    maxRetryBackoffMs: config.pollMaxRetryBackoffMs,
    failureThreshold: config.pollFailureThreshold,
    deliverAlerts: alertDelivery ? (alerts) => alertDelivery.deliver(alerts) : undefined,
  }).pollOnce().then(() => undefined);
  activePolls.set(key, poll);
  try {
    await poll;
  } finally {
    if (activePolls.get(key) === poll) activePolls.delete(key);
  }
}

export function redactLiveEnvelopeForClient(
  envelope: LiveSnapshotEnvelope,
): LiveSnapshotEnvelope {
  const publicEnvelope = structuredClone(envelope);
  const evidenceStates = [
    ...(publicEnvelope.snapshot?.rwa.sourceStates ?? []),
    ...(publicEnvelope.partial.rwa?.sourceStates ?? []),
  ];
  for (const source of evidenceStates) {
    source.snapshot.rawContent = "";
    source.snapshot.normalized.text = "";
    source.snapshot.normalized.lines = [];
  }
  return publicEnvelope;
}

export function toLiveCurrentApiResponse(
  dashboard: LiveArchiveDashboard,
): LiveCurrentApiResponse {
  const entry = dashboard.current;
  const snapshot = entry?.snapshot ?? null;
  return {
    mode: "LIVE_READ_ONLY",
    status: snapshot?.archiveStatus ?? "UNAVAILABLE",
    snapshotHash: snapshot?.snapshotHash ?? null,
    block: snapshot?.observedBlock ?? null,
    blockHash: snapshot?.blockHash ?? null,
    timestamp: snapshot?.timestamp ?? dashboard.envelope.generatedAt,
    risk: {
      classification: snapshot?.riskClassification ?? null,
      evidenceStatus: snapshot?.rwaEvidence?.status ?? null,
      confidence: snapshot?.rwaEvidence?.confidence ?? null,
      summary: snapshot?.rwaEvidence?.summary ?? null,
    },
    freshness: snapshot?.freshness ?? null,
    provenance: snapshot?.provenance ?? [],
    observation: entry?.observation ?? null,
    snapshot: snapshot ? {
      snapshotHash: snapshot.snapshotHash,
      integrityHash: snapshot.integrityHash,
      archiveStatus: snapshot.archiveStatus,
      consistencyStatus: snapshot.consistencyStatus,
      consistencyReasons: snapshot.consistencyReasons,
      integrityValid: snapshot.integrityValid,
      observedBlock: snapshot.observedBlock,
      blockHash: snapshot.blockHash,
      timestamp: snapshot.timestamp,
      sourceStates: snapshot.rwaEvidence?.sourceStates.map((source) => ({
        sourceId: source.sourceId,
        sourceUrl: source.sourceUrl,
        revisionId: source.revisionId,
        contentHash: source.contentHash,
        retrievedAt: source.retrievedAt,
      })) ?? [],
    } : null,
    envelope: dashboard.envelope,
    reasons: dashboard.reasons,
    broadcastPermitted: false,
    transactionSubmitted: false,
  };
}

export function toLiveHistoryApiResponse(
  dashboard: LiveArchiveDashboard,
): LiveHistoryApiResponse {
  return {
    mode: "LIVE_READ_ONLY",
    items: dashboard.history.map(({ observation, snapshot }) => ({
      observationId: observation.observationId,
      snapshotHash: snapshot.snapshotHash,
      status: snapshot.archiveStatus,
      block: snapshot.observedBlock,
      blockHash: snapshot.blockHash,
      timestamp: observation.observedAt,
      riskClassification: snapshot.riskClassification,
      healthFactorWad: snapshot.position?.healthFactorWad ?? null,
      collateralBalanceWei: snapshot.position?.collateralBalanceWei ?? null,
      debtBalanceWei: snapshot.position?.debtBalanceWei ?? null,
      sourceRevisionIds: snapshot.rwaEvidence?.sourceStates.map((source) => source.revisionId) ?? [],
      integrityHash: snapshot.integrityHash,
    })),
  };
}

export function toLiveAlertsApiResponse(
  dashboard: LiveArchiveDashboard,
): LiveAlertsApiResponse {
  return { mode: "LIVE_READ_ONLY", items: dashboard.alerts };
}

function createSnapshotService(config: LiveRuntimeConfig): LiveRiskSnapshotService {
  return new LiveRiskSnapshotService({
    rpcUrl: config.rpcUrl,
    rpcUrls: config.rpcUrls,
    account: config.account,
    egressSpender: config.egressSpender,
    maxBlockAgeSeconds: config.maxBlockAgeSeconds,
    observationBlockNumber: config.observationBlockNumber,
    observationBlockHash: config.observationBlockHash,
    maxOracleAgeSeconds: config.maxOracleAgeSeconds,
    maxSourceAgeSeconds: config.maxSourceAgeSeconds,
    store: createLiveRevisionStore(config),
  });
}

async function readRpcHead(config: LiveRuntimeConfig): Promise<{
  blockNumber: string | null;
  provider: string | null;
  latencyMs: number | null;
  reason: string | null;
}> {
  try {
    const result = await new XLayerReadAdapter({
      rpcUrl: config.rpcUrl,
      rpcUrls: config.rpcUrls,
      maxBlockAgeSeconds: Number.MAX_SAFE_INTEGER,
    }).read();
    const chain = result.state;
    return {
      blockNumber: chain?.blockNumber ?? null,
      provider: chain?.rpcUrl ?? null,
      latencyMs: result.health.latencyMs ?? null,
      reason: chain ? null : result.health.message,
    };
  } catch (error) {
    return {
      blockNumber: null,
      provider: null,
      latencyMs: null,
      reason: operationalErrorMessage(error),
    };
  }
}

export function emitLiveSnapshotLogs(
  envelope: LiveSnapshotEnvelope,
  logger: (line: string) => void = (line) => console.info(line),
): void {
  const write = (event: string, fields: Record<string, unknown> = {}) => {
    logger(JSON.stringify({ event, mode: envelope.mode, ...fields }));
  };

  write("egress.live.execution_mode", {
    broadcastAllowed: false,
    liveMainnetBroadcast: false,
  });
  for (const adapter of envelope.adapters) {
    write("egress.live.adapter_health", {
      adapter: adapter.adapter,
      status: adapter.status,
      fresh: adapter.freshness.fresh,
      blockNumber: adapter.freshness.blockNumber,
    });
  }
  write("egress.live.snapshot", {
    status: envelope.status,
    blockNumber: envelope.snapshot?.chain.blockNumber ?? envelope.partial.chain?.blockNumber ?? null,
    snapshotHash: envelope.snapshot?.snapshotHash ?? null,
    reasonCount: envelope.reasons.length,
    unavailableAdapters: envelope.adapters
      .filter((adapter) => adapter.status !== "AVAILABLE")
      .map((adapter) => adapter.adapter),
  });
  const riskEvidence = envelope.status === "AVAILABLE" ? envelope.snapshot?.rwa ?? null : null;
  write("egress.live.risk_evaluation", {
    status: riskEvidence?.status ?? "LIVE_DATA_UNAVAILABLE",
    riskLevel: riskEvidence?.riskLevel ?? null,
    verdictId: riskEvidence?.verdictId ?? null,
    evidenceStatus: envelope.partial.rwa?.status ?? null,
  });
  write("egress.live.policy_evaluation", {
    status: envelope.snapshot?.executionPreview.policyEvaluation.status ?? null,
    allowed: envelope.snapshot?.executionPreview.policyEvaluation.allowed ?? false,
  });
  write("egress.live.simulation", {
    status: "NOT_RUN",
    reason: "LIVE_READ_ONLY does not simulate or submit a write transaction.",
  });
}

function unavailableEnvelope(reasons: string[]): LiveSnapshotEnvelope {
  const now = new Date().toISOString();
  const health: AdapterHealth = {
    adapter: "runtime-config",
    version: "1",
    status: "INVALID_CONFIGURATION",
    message: reasons.join(" "),
    freshness: {
      observedAt: now,
      sourceTimestamp: null,
      blockNumber: null,
      ageSeconds: null,
      maxAgeSeconds: 0,
      fresh: false,
    },
    provenance: [],
  };
  return {
    mode: "LIVE_READ_ONLY",
    status: "LIVE_DATA_UNAVAILABLE",
    generatedAt: now,
    snapshot: null,
    partial: {
      chain: null,
      account: null,
      position: null,
      liquidity: null,
      oracle: null,
      uniswapPool: null,
      rwa: null,
      policy: null,
      executionPreview: null,
    },
    adapters: [health],
    reasons,
  };
}

function unavailableDashboard(reasons: string[]): LiveArchiveDashboard {
  return {
    envelope: unavailableEnvelope(reasons),
    current: null,
    history: [],
    alerts: [],
    archiveAvailable: false,
    reasons,
  };
}

function unavailableOperationalHealth(reason: string): LiveOperationalHealth {
  const now = new Date().toISOString();
  return liveOperationalHealthSchema.parse({
    schemaVersion: 1,
    runtimeMode: "LIVE_READ_ONLY",
    broadcastPermitted: false,
    transactionSubmitted: false,
    poller: {
      state: "UNAVAILABLE",
      lastSuccessfulObservationAt: null,
      lastAttemptAt: null,
      consecutiveFailures: 0,
      lastError: reason,
    },
    archive: {
      state: "UNAVAILABLE",
      lastSuccessfulSnapshotHash: null,
      lastWriteAt: null,
      reason,
    },
    rpc: {
      state: "UNAVAILABLE",
      latencyMs: null,
      lastBlock: null,
      headBlock: null,
      indexedThroughBlock: null,
      indexLagBlocks: null,
      provider: null,
      failureCount: 0,
      reason,
    },
    oracle: { state: "UNAVAILABLE", ageSeconds: null, reason },
    source: { state: "UNAVAILABLE", ageSeconds: null, reason },
    alertDelivery: { state: "UNAVAILABLE", pending: 0, failed: 0, delivered: 0, reason },
    database: { state: "UNAVAILABLE", latencyMs: null, reason },
    executionStaging: {
      schemaVersion: 1,
      configured: false,
      environment: "DISABLED",
      state: "UNAVAILABLE",
      submissionPermitted: false,
      latestIntent: null,
      latestSimulation: null,
      latestReservation: null,
      latestSubmission: null,
      lastError: reason,
      lastEventAt: null,
      generatedAt: now,
    },
    current: {
      snapshotHash: null,
      observedAt: null,
      ageSeconds: null,
      archiveStatus: null,
      healthFactorWad: null,
      debtBalanceWei: null,
      collateralBalanceWei: null,
      liquidityExecutable: null,
    },
    metrics: {
      pollSuccesses: 0,
      pollFailures: 0,
      archiveWriteFailures: 0,
      alertsGenerated: 0,
      alertsDeduplicated: 0,
      alertDeliveryAttempts: 0,
      alertDeliveryFailures: 0,
      pollDurationMs: null,
      archiveLagSeconds: null,
      snapshotStatusCounts: { COMPLETE: 0, STALE: 0, INVALID: 0, UNAVAILABLE: 0 },
    },
    generatedAt: now,
  });
}
