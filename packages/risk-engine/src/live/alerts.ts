import { objectHash, shortId } from "../domain/hash.js";
import type { RiskVerdict } from "../domain/schemas.js";
import {
  liveAlertSchema,
  type ArchivedLiveSnapshot,
  type LiveAlert,
  type LiveAlertEvidence,
  type LiveAlertSeverity,
  type LiveAlertType,
} from "./archive-schemas.js";

export interface LiveAlertConfig {
  thresholdPolicyVersion: number;
  healthFactorApproachMarginBps: number;
  healthFactorApproachExitMarginBps: number;
  healthFactorDeteriorationMinimumWad: string;
  healthFactorDeteriorationMinimumBps: number;
  debtIncreaseMinimumWei: string;
  debtIncreaseMinimumBps: number;
  liquidityDeteriorationBps: number;
  slippageDeteriorationBps: number;
  oracleApproachRatioBps: number;
}

export const DEFAULT_LIVE_ALERT_CONFIG: LiveAlertConfig = {
  thresholdPolicyVersion: 1,
  healthFactorApproachMarginBps: 500,
  healthFactorApproachExitMarginBps: 100,
  healthFactorDeteriorationMinimumWad: "1000000000000000",
  healthFactorDeteriorationMinimumBps: 10,
  debtIncreaseMinimumWei: "10000000000000000",
  debtIncreaseMinimumBps: 5,
  liquidityDeteriorationBps: 1_000,
  slippageDeteriorationBps: 25,
  oracleApproachRatioBps: 8_000,
};

export function evaluateLiveAlerts(input: {
  previous: ArchivedLiveSnapshot | null;
  current: ArchivedLiveSnapshot;
  now?: string;
  config?: Partial<LiveAlertConfig>;
}): LiveAlert[] {
  const config = { ...DEFAULT_LIVE_ALERT_CONFIG, ...input.config };
  const previous = input.previous;
  const current = input.current;
  const alerts: LiveAlert[] = [];
  const timestamp = current.timestamp;
  const common = {
    snapshotHash: current.snapshotHash as `0x${string}`,
    previousSnapshotHash: previous?.snapshotHash as `0x${string}` | null ?? null,
    block: current.observedBlock,
    timestamp,
    createdAt: input.now ?? timestamp,
    thresholdPolicyVersion: config.thresholdPolicyVersion,
  };

  if (
    previous &&
    current.riskClassification !== null &&
    previous.riskClassification !== null &&
    current.riskClassification !== previous.riskClassification
  ) {
    alerts.push(makeAlert({
      ...common,
      alertType: "RISK_CHANGED",
      severity: riskChangeSeverity(current.riskClassification),
      evidence: evidence(
        "RISK_CLASSIFICATION_CHANGED",
        `Risk classification changed from ${previous.riskClassification ?? "UNAVAILABLE"} to ${current.riskClassification ?? "UNAVAILABLE"}.`,
        "risk-engine",
        current.rwaEvidence?.sourceStates.flatMap((source) => [source.sourceUrl, source.revisionId]) ?? [],
      ),
      previousState: previous.riskClassification,
      currentState: current.riskClassification,
      dedupeState: {
        previous: previous.riskClassification,
        current: current.riskClassification,
      },
    }));
  }

  const previousSources = sourceRevisionMap(previous?.rwaEvidence);
  const currentSources = sourceRevisionMap(current.rwaEvidence);
  if (previous && JSON.stringify(previousSources) !== JSON.stringify(currentSources)) {
    alerts.push(makeAlert({
      ...common,
      alertType: "SOURCE_CHANGED",
      severity: "INFO",
      evidence: evidence(
        "SOURCE_REVISION_CHANGED",
        "An official OKX evidence revision changed; risk classification is evaluated separately.",
        "okx-rwa",
        current.rwaEvidence?.sourceStates.flatMap((source) => [source.sourceUrl, source.revisionId, source.contentHash]) ?? [],
      ),
      previousState: previousSources,
      currentState: currentSources,
      dedupeState: { previous: previousSources, current: currentSources },
    }));
  }

  if (current.archiveStatus === "INVALID" && current.consistencyReasons.length > 0) {
    const integrityFailure = current.consistencyReasons.some((reason) => /INTEGRITY_FAILURE/i.test(reason));
    alerts.push(makeAlert({
      ...common,
      alertType: integrityFailure ? "SNAPSHOT_INTEGRITY_FAILURE" : "SNAPSHOT_UNAVAILABLE",
      severity: "CRITICAL",
      evidence: evidence(
        integrityFailure ? "SNAPSHOT_INTEGRITY_FAILURE" : "INCONSISTENT_BLOCK_DATA",
        current.consistencyReasons.join(" "),
        "snapshot-validator",
        current.provenance,
      ),
      previousState: previous?.archiveStatus ?? null,
      currentState: current.archiveStatus,
      dedupeState: { status: current.archiveStatus, reasons: current.consistencyReasons },
    }));
  } else if (
    current.archiveStatus !== "COMPLETE" &&
    (!previous || previous.archiveStatus === "COMPLETE")
  ) {
    alerts.push(makeAlert({
      ...common,
      alertType: "SNAPSHOT_UNAVAILABLE",
      severity: current.archiveStatus === "STALE" ? "WARNING" : "HIGH",
      evidence: evidence(
        "LIVE_SNAPSHOT_NOT_COMPLETE",
        `Current observation is ${current.archiveStatus}; no previous snapshot is reused as current.`,
        "snapshot-archive",
        current.provenance,
      ),
      previousState: previous?.archiveStatus ?? null,
      currentState: current.archiveStatus,
      dedupeState: { status: current.archiveStatus },
    }));
  }

  const currentOracle = current.oracle;
  const previousOracle = previous?.oracle;
  if (currentOracle) {
    for (const [label, currentFeed, previousFeed] of [
      ["xBETH", currentOracle.xbEth, previousOracle?.xbEth],
      ["xETH", currentOracle.xeth, previousOracle?.xeth],
    ] as const) {
      const currentHealth = current.freshness.adapters.find((adapter) => adapter.adapter === "oracle");
      const previousHealth = previous?.freshness.adapters.find((adapter) => adapter.adapter === "oracle");
      const maxAge = currentOracle.maxAgeSeconds;
      const age = currentHealth?.freshness.ageSeconds;
      const approaching = age !== null && age !== undefined && age >= maxAge * config.oracleApproachRatioBps / 10_000;
      const wasApproaching = previousHealth?.freshness.ageSeconds !== null &&
        previousHealth?.freshness.ageSeconds !== undefined &&
        previousHealth.freshness.ageSeconds >= maxAge * config.oracleApproachRatioBps / 10_000;
      if (approaching && !wasApproaching && currentHealth?.status === "AVAILABLE") {
        alerts.push(makeAlert({
          ...common,
          alertType: "ORACLE_APPROACHING_STALE",
          severity: "WARNING",
          evidence: evidence(
            "ORACLE_FRESHNESS_NEAR_LIMIT",
            `${label} oracle age is ${Math.round(age)}s of ${maxAge}s allowed.`,
            "oracle",
            currentFeed.provenance,
          ),
          previousState: previousHealth?.freshness.ageSeconds ?? null,
          currentState: age,
          dedupeState: { label, approaching: true },
        }));
      }
      if (
        currentHealth?.status === "STALE" &&
        previousHealth?.status !== "STALE"
      ) {
        alerts.push(makeAlert({
          ...common,
          alertType: "ORACLE_STALE",
          severity: "HIGH",
          evidence: evidence(
            "ORACLE_STALE",
            `${label} oracle data exceeded its configured freshness limit.`,
            "oracle",
            currentFeed.provenance,
          ),
          previousState: previousHealth?.status ?? null,
          currentState: currentHealth.status,
          dedupeState: { label, status: "STALE" },
        }));
      }
      void previousFeed;
    }
  } else {
    const currentHealth = current.freshness.adapters.find((adapter) => adapter.adapter === "oracle");
    const previousHealth = previous?.freshness.adapters.find((adapter) => adapter.adapter === "oracle");
    if (currentHealth?.status === "STALE" && previousHealth?.status !== "STALE") {
      alerts.push(makeAlert({
        ...common,
        alertType: "ORACLE_STALE",
        severity: "HIGH",
        evidence: evidence(
          "ORACLE_STALE",
          "The Aave oracle adapter is stale and no current oracle state is accepted.",
          "oracle",
          currentHealth.provenance,
        ),
        previousState: previousHealth?.status ?? null,
        currentState: currentHealth.status,
        dedupeState: { status: "STALE" },
      }));
    }
  }

  const currentPosition = current.position;
  const previousPosition = previous?.position;
  if (previousPosition && !currentPosition) {
    alerts.push(makeAlert({
      ...common,
      alertType: "POSITION_UNAVAILABLE",
      severity: "HIGH",
      evidence: evidence(
        "POSITION_UNAVAILABLE",
        "The previously observed Aave position is no longer readable; historical state is not reused as current.",
        "aave",
        current.freshness.adapters.find((adapter) => adapter.adapter === "aave")?.provenance ?? [],
      ),
      previousState: positionSummary(previousPosition),
      currentState: null,
      dedupeState: { position: "unavailable" },
    }));
  }
  if (currentPosition && previousPosition) {
    const currentClosed = currentPosition.collateralBalanceWei === "0" || currentPosition.debtBalanceWei === "0";
    const previousOpen = previousPosition.collateralBalanceWei !== "0" && previousPosition.debtBalanceWei !== "0";
    if (currentClosed && previousOpen) {
      alerts.push(makeAlert({
        ...common,
        alertType: "POSITION_CLOSED",
        severity: "HIGH",
        evidence: evidence(
          "POSITION_CLOSED",
          "The observed xBETH/xETH position no longer contains both supported legs.",
          "aave",
          current.freshness.adapters.find((adapter) => adapter.adapter === "aave")?.provenance ?? [],
        ),
        previousState: positionSummary(previousPosition),
        currentState: positionSummary(currentPosition),
        dedupeState: { position: "closed" },
      }));
    }
    const debtIncrease = BigInt(currentPosition.debtBalanceWei) - BigInt(previousPosition.debtBalanceWei);
    const debtThreshold = maxBigInt(
      BigInt(config.debtIncreaseMinimumWei),
      BigInt(previousPosition.debtBalanceWei) * BigInt(config.debtIncreaseMinimumBps) / 10_000n,
    );
    if (debtIncrease >= debtThreshold && debtIncrease > 0n) {
      alerts.push(makeAlert({
        ...common,
        alertType: "DEBT_INCREASED",
        severity: "WARNING",
        evidence: evidence(
          "DEBT_INCREASED",
          `xETH debt materially increased from ${previousPosition.debtBalanceWei} to ${currentPosition.debtBalanceWei} wei (delta ${debtIncrease}; threshold ${debtThreshold}).`,
          "aave",
          current.freshness.adapters.find((adapter) => adapter.adapter === "aave")?.provenance ?? [],
        ),
        previousState: previousPosition.debtBalanceWei,
        currentState: currentPosition.debtBalanceWei,
        dedupeState: { previous: previousPosition.debtBalanceWei, current: currentPosition.debtBalanceWei },
      }));
    }
    if (BigInt(currentPosition.collateralBalanceWei) < BigInt(previousPosition.collateralBalanceWei)) {
      alerts.push(makeAlert({
        ...common,
        alertType: "COLLATERAL_REDUCED",
        severity: "WARNING",
        evidence: evidence(
          "COLLATERAL_REDUCED",
          `xBETH collateral reduced from ${previousPosition.collateralBalanceWei} to ${currentPosition.collateralBalanceWei} wei.`,
          "aave",
          current.freshness.adapters.find((adapter) => adapter.adapter === "aave")?.provenance ?? [],
        ),
        previousState: previousPosition.collateralBalanceWei,
        currentState: currentPosition.collateralBalanceWei,
        dedupeState: { previous: previousPosition.collateralBalanceWei, current: currentPosition.collateralBalanceWei },
      }));
    }
    if (
      currentPosition.singleMarketPosition !== previousPosition.singleMarketPosition ||
      currentPosition.collateralToken.toLowerCase() !== previousPosition.collateralToken.toLowerCase() ||
      currentPosition.debtToken.toLowerCase() !== previousPosition.debtToken.toLowerCase()
    ) {
      alerts.push(makeAlert({
        ...common,
        alertType: "POSITION_SCOPE_CHANGED",
        severity: "CRITICAL",
        evidence: evidence(
          "POSITION_SCOPE_CHANGED",
          "The observed account no longer matches the supported isolated xBETH/xETH position scope.",
          "aave",
          current.freshness.adapters.find((adapter) => adapter.adapter === "aave")?.provenance ?? [],
        ),
        previousState: positionSummary(previousPosition),
        currentState: positionSummary(currentPosition),
        dedupeState: { position: positionSummary(currentPosition) },
      }));
    }
    const healthFactorDecrease = BigInt(previousPosition.healthFactorWad) - BigInt(currentPosition.healthFactorWad);
    const healthFactorThreshold = maxBigInt(
      BigInt(config.healthFactorDeteriorationMinimumWad),
      BigInt(previousPosition.healthFactorWad) * BigInt(config.healthFactorDeteriorationMinimumBps) / 10_000n,
    );
    if (healthFactorDecrease >= healthFactorThreshold && healthFactorDecrease > 0n) {
      alerts.push(makeAlert({
        ...common,
        alertType: "HEALTH_FACTOR_DETERIORATED",
        severity: "WARNING",
        evidence: evidence(
          "HEALTH_FACTOR_DETERIORATED",
          `Health factor materially decreased from ${previousPosition.healthFactorWad} to ${currentPosition.healthFactorWad} wad (delta ${healthFactorDecrease}; threshold ${healthFactorThreshold}).`,
          "aave",
          current.freshness.adapters.find((adapter) => adapter.adapter === "aave")?.provenance ?? [],
        ),
        previousState: previousPosition.healthFactorWad,
        currentState: currentPosition.healthFactorWad,
        dedupeState: {
          previous: previousPosition.healthFactorWad,
          current: currentPosition.healthFactorWad,
          thresholdPolicyVersion: config.thresholdPolicyVersion,
        },
      }));
    }
  }

  const currentPolicy = current.envelope.snapshot?.policy.policy ?? current.envelope.partial.policy?.policy;
  if (currentPosition && currentPolicy) {
    const trigger = BigInt(currentPolicy.triggerHealthFactorWad);
    const approach = trigger + trigger * BigInt(config.healthFactorApproachMarginBps) / 10_000n;
    const currentHf = BigInt(currentPosition.healthFactorWad);
    const previousHf = previousPosition ? BigInt(previousPosition.healthFactorWad) : null;
    const exit = approach + trigger * BigInt(config.healthFactorApproachExitMarginBps) / 10_000n;
    const wasApproaching = previousHf !== null && previousHf <= exit && previousHf > trigger;
    const movingTowardTrigger = previousHf === null || currentHf < previousHf;
    if (currentHf <= approach && currentHf > trigger && !wasApproaching && movingTowardTrigger) {
      alerts.push(makeAlert({
        ...common,
        alertType: "HEALTH_FACTOR_APPROACHING_TRIGGER",
        severity: "WARNING",
        evidence: evidence(
          "HEALTH_FACTOR_APPROACHING_TRIGGER",
          `Health factor ${currentPosition.healthFactorWad} is within ${config.healthFactorApproachMarginBps}bps of the ${currentPolicy.triggerHealthFactorWad} trigger.`,
          "aave",
          current.freshness.adapters.find((adapter) => adapter.adapter === "aave")?.provenance ?? [],
        ),
        previousState: previousPosition?.healthFactorWad ?? null,
        currentState: currentPosition.healthFactorWad,
        dedupeState: {
          approaching: true,
          trigger: currentPolicy.triggerHealthFactorWad,
          thresholdPolicyVersion: config.thresholdPolicyVersion,
        },
      }));
    }
  }

  const currentLiquidity = current.liquidity;
  const previousLiquidity = previous?.liquidity;
  if (currentLiquidity && previousLiquidity) {
    const currentActive = BigInt(currentLiquidity.activeLiquidity);
    const previousActive = BigInt(previousLiquidity.activeLiquidity);
    if (previousActive > 0n && currentActive * 10_000n < previousActive * BigInt(10_000 - config.liquidityDeteriorationBps)) {
      alerts.push(makeAlert({
        ...common,
        alertType: "LIQUIDITY_DETERIORATED",
        severity: "HIGH",
        evidence: evidence(
          "LIQUIDITY_DETERIORATED",
          `Active liquidity decreased from ${previousLiquidity.activeLiquidity} to ${currentLiquidity.activeLiquidity}.`,
          "uniswap",
          current.freshness.adapters.find((adapter) => adapter.adapter === "uniswap-pool")?.provenance ?? [],
        ),
        previousState: previousLiquidity.activeLiquidity,
        currentState: currentLiquidity.activeLiquidity,
        dedupeState: { previous: previousLiquidity.activeLiquidity, current: currentLiquidity.activeLiquidity },
      }));
    }
    if (currentLiquidity.estimatedSlippageBps - previousLiquidity.estimatedSlippageBps >= config.slippageDeteriorationBps) {
      alerts.push(makeAlert({
        ...common,
        alertType: "SLIPPAGE_DETERIORATED",
        severity: "HIGH",
        evidence: evidence(
          "SLIPPAGE_DETERIORATED",
          `Estimated slippage increased from ${previousLiquidity.estimatedSlippageBps}bps to ${currentLiquidity.estimatedSlippageBps}bps.`,
          "uniswap",
          current.freshness.adapters.find((adapter) => adapter.adapter === "uniswap")?.provenance ?? [],
        ),
        previousState: previousLiquidity.estimatedSlippageBps,
        currentState: currentLiquidity.estimatedSlippageBps,
        dedupeState: { previous: previousLiquidity.estimatedSlippageBps, current: currentLiquidity.estimatedSlippageBps },
      }));
    }
  }

  if (previous && previous.configurationHash.toLowerCase() !== current.configurationHash.toLowerCase()) {
    alerts.push(makeAlert({
      ...common,
      alertType: "PROTOCOL_CONFIGURATION_CHANGED",
      severity: "CRITICAL",
      evidence: evidence(
        "PROTOCOL_CONFIGURATION_CHANGED",
        "Verified Aave, oracle, token, or Uniswap configuration changed between observations.",
        "configuration",
        current.freshness.adapters.find((adapter) => adapter.adapter === "configuration")?.provenance ?? [],
      ),
      previousState: previous.configurationHash,
      currentState: current.configurationHash,
      dedupeState: { previous: previous.configurationHash, current: current.configurationHash },
    }));
  }

  return alerts;
}

function makeAlert(input: {
  alertType: LiveAlertType;
  severity: LiveAlertSeverity;
  snapshotHash: `0x${string}`;
  previousSnapshotHash: `0x${string}` | null;
  block: string | null;
  timestamp: string;
  createdAt: string;
  evidence: LiveAlertEvidence[];
  previousState: unknown;
  currentState: unknown;
  dedupeState: unknown;
  thresholdPolicyVersion?: number;
}): LiveAlert {
  const deduplicationKey = objectHash({
    alertType: input.alertType,
    severity: input.severity,
    snapshotHash: input.snapshotHash,
    previousSnapshotHash: input.previousSnapshotHash,
    state: input.dedupeState,
    thresholdPolicyVersion: input.thresholdPolicyVersion ?? DEFAULT_LIVE_ALERT_CONFIG.thresholdPolicyVersion,
  });
  return liveAlertSchema.parse({
    schemaVersion: 1,
    alertId: shortId("alert", deduplicationKey),
    deduplicationKey,
    alertType: input.alertType,
    severity: input.severity,
    snapshotHash: input.snapshotHash,
    previousSnapshotHash: input.previousSnapshotHash,
    block: input.block,
    timestamp: input.timestamp,
    evidence: input.evidence,
    previousState: input.previousState,
    currentState: input.currentState,
    thresholdPolicyVersion: input.thresholdPolicyVersion ?? DEFAULT_LIVE_ALERT_CONFIG.thresholdPolicyVersion,
    createdAt: input.createdAt,
  });
}

function maxBigInt(left: bigint, right: bigint): bigint {
  return left > right ? left : right;
}

function evidence(code: string, message: string, source: string, provenance: string[]): LiveAlertEvidence[] {
  return [{ code, message, source, provenance: [...new Set(provenance)] }];
}

function sourceRevisionMap(
  rwa: ArchivedLiveSnapshot["rwaEvidence"] | undefined,
): Record<string, string> {
  return Object.fromEntries(
    (rwa?.sourceStates ?? [])
      .map((source) => [source.sourceId, `${source.revisionId}:${source.contentHash}`])
      .sort((left, right) => left[0]!.localeCompare(right[0]!)),
  );
}

function positionSummary(position: NonNullable<ArchivedLiveSnapshot["position"]>) {
  return {
    user: position.user,
    collateralToken: position.collateralToken,
    debtToken: position.debtToken,
    collateralBalanceWei: position.collateralBalanceWei,
    debtBalanceWei: position.debtBalanceWei,
    healthFactorWad: position.healthFactorWad,
    singleMarketPosition: position.singleMarketPosition,
  };
}

function riskChangeSeverity(level: RiskVerdict["riskLevel"] | null): LiveAlertSeverity {
  if (level === "CRITICAL") return "CRITICAL";
  if (level === "HIGH") return "HIGH";
  if (level === "MEDIUM") return "WARNING";
  return "INFO";
}
