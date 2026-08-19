import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  liveRiskSnapshotSchema,
  liveSnapshotEnvelopeSchema,
  type AdapterHealth,
  type LiveRiskSnapshot,
  type LiveSnapshotEnvelope,
} from "../src/live/schemas.js";
import {
  buildArchivedLiveSnapshot,
  type LiveSnapshotArchive,
  verifyArchivedLiveSnapshot,
} from "../src/live/archive.js";
import { evaluateLiveAlerts } from "../src/live/alerts.js";
import { FilesystemLiveSnapshotArchive } from "../src/live/filesystem-archive.js";
import { InMemoryLiveSnapshotArchive } from "../src/live/memory-archive.js";
import { LiveSnapshotPoller } from "../src/live/poller.js";
import { liveSnapshotStateHash } from "../src/live/canonical.js";
import {
  exportArchivedLiveSnapshot,
  importArchivedLiveSnapshot,
  parseLiveSnapshotExport,
} from "../src/live/export.js";
import { replayMarketContext, replayPolicy } from "../src/replay/fixtures.js";
import { LiveAlertDeliveryService } from "../src/live/alert-delivery.js";
import { readOperationalHealth } from "../src/live/operations.js";

const NOW = new Date("2026-08-15T10:00:00.000Z");
const BLOCK = 68_048_783n;
const BLOCK_HASH = `0x${"52".repeat(32)}` as const;

describe("durable live snapshot archive", () => {
  it("uses deterministic state identity while preserving volatile observation metadata", () => {
    const first = completeEnvelope();
    const later = structuredClone(first);
    later.generatedAt = new Date(NOW.getTime() + 30_000).toISOString();
    later.snapshot!.generatedAt = later.generatedAt;
    for (const adapter of later.snapshot!.adapters) {
      adapter.freshness.observedAt = later.generatedAt;
      adapter.freshness.sourceTimestamp = later.generatedAt;
      adapter.freshness.ageSeconds = 30;
    }
    later.adapters = later.snapshot!.adapters;

    const firstRecord = buildArchivedLiveSnapshot(first);
    const laterRecord = buildArchivedLiveSnapshot(later);
    expect(firstRecord.snapshotHash).toBe(laterRecord.snapshotHash);
    expect(firstRecord.integrityHash).not.toBe(laterRecord.integrityHash);
    expect(firstRecord.archiveStatus).toBe("COMPLETE");
    expect(verifyArchivedLiveSnapshot(firstRecord)).toBe(true);
  });

  it.each([
    ["block", { block: BLOCK + 1n }],
    ["position", { debtBalanceWei: "45000000000000000000" }],
    ["oracle", { xethPriceBase: "300100000000" }],
    ["liquidity", { activeLiquidity: "90000000000000000000000" }],
    ["RWA evidence", { riskLevel: "MEDIUM" as const }],
  ])("changes the hash when %s changes", (_label, overrides) => {
    const first = buildArchivedLiveSnapshot(completeEnvelope());
    const changed = buildArchivedLiveSnapshot(completeEnvelope(overrides));
    expect(changed.snapshotHash).not.toBe(first.snapshotHash);
  });

  it("stores canonical snapshots immutably and records duplicate observations separately", async () => {
    const directory = await mkdtemp(join(tmpdir(), "egress-live-archive-"));
    try {
      const archive = new FilesystemLiveSnapshotArchive(directory);
      const envelope = completeEnvelope();
      const record = buildArchivedLiveSnapshot(envelope);
      const first = await archive.archive(record, NOW.toISOString());
      const second = await archive.archive(
        buildArchivedLiveSnapshot({
          ...envelope,
          generatedAt: new Date(NOW.getTime() + 60_000).toISOString(),
        }),
        new Date(NOW.getTime() + 60_000).toISOString(),
      );

      expect(first.inserted).toBe(true);
      expect(second.inserted).toBe(false);
      expect(second.observationInserted).toBe(true);
      expect(await archive.history()).toHaveLength(2);
      const stored = await archive.get(record.snapshotHash);
      expect(stored?.integrityHash).toBe(record.integrityHash);
      const raw = await readFile(
        join(directory, "snapshots", `${record.snapshotHash.toLowerCase()}.json`),
        "utf8",
      );
      expect(JSON.parse(raw).createdAt).toBe(record.createdAt);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("keeps protocol configuration identity stable across blocks and changes it for reserve configuration", () => {
    const first = buildArchivedLiveSnapshot(completeEnvelope({ block: BLOCK }));
    const nextBlock = buildArchivedLiveSnapshot(completeEnvelope({ block: BLOCK + 1n }));
    expect(nextBlock.configurationHash).toBe(first.configurationHash);

    const changed = completeEnvelope({ block: BLOCK + 2n });
    changed.snapshot!.aave.collateralReserve.ltvBps = 8_700;
    changed.snapshot!.snapshotHash = liveSnapshotStateHash(changed.snapshot!);
    const changedRecord = buildArchivedLiveSnapshot(changed);
    expect(changedRecord.configurationHash).not.toBe(first.configurationHash);
  });

  it("distinguishes stale, unavailable, and inconsistent observations from complete state", () => {
    const stale = completeEnvelope();
    const staleAdapter = stale.adapters.find((adapter) => adapter.adapter === "oracle")!;
    staleAdapter.status = "STALE";
    staleAdapter.freshness.fresh = false;
    stale.snapshot!.adapters = stale.adapters;
    stale.snapshot!.snapshotHash = liveSnapshotStateHash(stale.snapshot!);
    expect(buildArchivedLiveSnapshot(stale).archiveStatus).toBe("STALE");

    const unavailable = unavailableEnvelope();
    const unavailableRecord = buildArchivedLiveSnapshot(unavailable);
    expect(unavailableRecord.archiveStatus).toBe("UNAVAILABLE");
    expect(unavailableRecord.riskClassification).toBeNull();

    const inconsistent = completeEnvelope();
    inconsistent.snapshot!.aave.position.blockNumber = (BLOCK - 1n).toString();
    inconsistent.snapshot!.marketContext.position.blockNumber = (BLOCK - 1n).toString();
    inconsistent.snapshot!.snapshotHash = liveSnapshotStateHash(inconsistent.snapshot!);
    const invalidRecord = buildArchivedLiveSnapshot(inconsistent);
    expect(invalidRecord.archiveStatus).toBe("INVALID");
    expect(invalidRecord.consistencyStatus).toBe("INCONSISTENT_BLOCK_DATA");
  });

  it("rejects a tampered archive payload without mutating stored state", async () => {
    const archive = new InMemoryLiveSnapshotArchive();
    const record = buildArchivedLiveSnapshot(completeEnvelope());
    await archive.archive(record);
    const tampered = structuredClone(record);
    tampered.position!.debtBalanceWei = "999";
    await expect(archive.archive(tampered)).rejects.toThrow(/integrity/i);
    expect((await archive.get(record.snapshotHash))?.position?.debtBalanceWei)
      .toBe(record.position?.debtBalanceWei);
  });

  it("exports and imports canonical evidence without changing its content hash", async () => {
    const record = buildArchivedLiveSnapshot(completeEnvelope());
    const serialized = exportArchivedLiveSnapshot(record, NOW.toISOString());
    const parsed = parseLiveSnapshotExport(serialized);
    const archive = new InMemoryLiveSnapshotArchive();
    const imported = await importArchivedLiveSnapshot(archive, serialized);
    expect(parsed.snapshot.snapshotHash).toBe(record.snapshotHash);
    expect(imported.entry.snapshot.snapshotHash).toBe(record.snapshotHash);
    expect(imported.entry.snapshot.integrityHash).toBe(record.integrityHash);
    expect(exportArchivedLiveSnapshot(imported.entry.snapshot, NOW.toISOString())).toBe(serialized);
  });
});

describe("live transition alerts and poller", () => {
  it("emits evidence-backed risk and position transitions once", () => {
    const previous = buildArchivedLiveSnapshot(completeEnvelope());
    const current = buildArchivedLiveSnapshot(completeEnvelope({
      block: BLOCK + 1n,
      riskLevel: "HIGH",
      healthFactorWad: "1040000000000000000",
      debtBalanceWei: "45000000000000000000",
      collateralBalanceWei: "49000000000000000000",
    }));
    const alerts = evaluateLiveAlerts({ previous, current });
    expect(alerts.map((alert) => alert.alertType)).toEqual(expect.arrayContaining([
      "RISK_CHANGED",
      "HEALTH_FACTOR_DETERIORATED",
      "DEBT_INCREASED",
      "COLLATERAL_REDUCED",
    ]));
    expect(alerts.every((alert) => alert.evidence.length > 0)).toBe(true);
    expect(evaluateLiveAlerts({ previous: current, current })).toEqual([]);
  });

  it("separates an OKX source revision from a material risk transition", () => {
    const previous = buildArchivedLiveSnapshot(completeEnvelope({ sourceVersion: 1 }));
    const sourceOnly = buildArchivedLiveSnapshot(completeEnvelope({
      block: BLOCK + 1n,
      sourceVersion: 2,
    }));
    const sourceAlerts = evaluateLiveAlerts({ previous, current: sourceOnly });
    expect(sourceAlerts.map((alert) => alert.alertType)).toContain("SOURCE_CHANGED");
    expect(sourceAlerts.map((alert) => alert.alertType)).not.toContain("RISK_CHANGED");
    expect(sourceAlerts.map((alert) => alert.alertType)).not.toContain("PROTOCOL_CONFIGURATION_CHANGED");

    const material = buildArchivedLiveSnapshot(completeEnvelope({
      block: BLOCK + 2n,
      sourceVersion: 3,
      riskLevel: "HIGH",
    }));
    const materialAlerts = evaluateLiveAlerts({ previous: sourceOnly, current: material });
    expect(materialAlerts.map((alert) => alert.alertType)).toEqual(expect.arrayContaining([
      "SOURCE_CHANGED",
      "RISK_CHANGED",
    ]));
  });

  it("alerts on stale oracle, liquidity deterioration, position closure, and configuration change", () => {
    const previous = buildArchivedLiveSnapshot(completeEnvelope());

    const staleEnvelope = completeEnvelope({
      block: BLOCK + 1n,
      oracleStatus: "STALE",
      oracleAgeSeconds: 22_000,
    });
    const stale = buildArchivedLiveSnapshot(staleEnvelope);
    expect(stale.archiveStatus).toBe("STALE");
    expect(evaluateLiveAlerts({ previous, current: stale }).map((alert) => alert.alertType))
      .toEqual(expect.arrayContaining(["ORACLE_STALE", "SNAPSHOT_UNAVAILABLE"]));

    const thinLiquidity = buildArchivedLiveSnapshot(completeEnvelope({
      block: BLOCK + 2n,
      activeLiquidity: "70000000000000000000000",
      estimatedSlippageBps: 50,
    }));
    expect(evaluateLiveAlerts({ previous, current: thinLiquidity }).map((alert) => alert.alertType))
      .toEqual(expect.arrayContaining(["LIQUIDITY_DETERIORATED", "SLIPPAGE_DETERIORATED"]));

    const closedEnvelope = unavailableEnvelope();
    closedEnvelope.generatedAt = new Date(NOW.getTime() + 3_000).toISOString();
    closedEnvelope.partial.position = {
      ...previous.position!,
      debtBalanceWei: "0",
      totalDebtBase: "0",
    };
    const closed = buildArchivedLiveSnapshot(closedEnvelope);
    expect(evaluateLiveAlerts({ previous, current: closed }).map((alert) => alert.alertType))
      .toContain("POSITION_CLOSED");

    const configEnvelope = completeEnvelope({ block: BLOCK + 4n });
    configEnvelope.snapshot!.aave.collateralReserve.ltvBps = 8_700;
    configEnvelope.snapshot!.snapshotHash = liveSnapshotStateHash(configEnvelope.snapshot!);
    const configured = buildArchivedLiveSnapshot(configEnvelope);
    expect(evaluateLiveAlerts({ previous, current: configured }).map((alert) => alert.alertType))
      .toContain("PROTOCOL_CONFIGURATION_CHANGED");
  });

  it("archives polling failures as current unavailable state and never reuses history", async () => {
    const archive = new InMemoryLiveSnapshotArchive();
    const unavailable = unavailableEnvelope();
    unavailable.generatedAt = new Date(NOW.getTime() + 1_000).toISOString();
    const reads = [completeEnvelope(), unavailable];
    const poller = new LiveSnapshotPoller({
      archive,
      read: async () => reads.shift()!,
      now: () => NOW,
    });
    const first = await poller.pollOnce();
    const second = await poller.pollOnce();
    expect(first.archived.entry.snapshot.archiveStatus).toBe("COMPLETE");
    expect(second.archived.entry.snapshot.archiveStatus).toBe("UNAVAILABLE");
    expect((await archive.current())?.snapshot.archiveStatus).toBe("UNAVAILABLE");
    expect(second.alerts.map((alert) => alert.alertType)).toContain("SNAPSHOT_UNAVAILABLE");
  });

  it("deduplicates repeated risk transitions by deterministic state", async () => {
    const archive = new InMemoryLiveSnapshotArchive();
    const previous = buildArchivedLiveSnapshot(completeEnvelope());
    const current = buildArchivedLiveSnapshot(completeEnvelope({
      block: BLOCK + 1n,
      riskLevel: "MEDIUM",
    }));
    await archive.archive(previous);
    const alerts = evaluateLiveAlerts({ previous, current });
    const first = await archive.saveAlerts(alerts);
    const second = await archive.saveAlerts(alerts);
    expect(first.inserted.some((alert) => alert.alertType === "RISK_CHANGED")).toBe(true);
    expect(second.inserted).toEqual([]);
    expect(second.duplicates).toHaveLength(alerts.length);
  });

  it("suppresses continuous micro-accrual while preserving material deterioration", () => {
    const previous = buildArchivedLiveSnapshot(completeEnvelope());
    const micro = buildArchivedLiveSnapshot(completeEnvelope({
      block: BLOCK + 1n,
      debtBalanceWei: (BigInt(previous.position!.debtBalanceWei) + 1_000_000_000_000n).toString(),
      healthFactorWad: (BigInt(previous.position!.healthFactorWad) - 1_000_000_000_000n).toString(),
    }));
    const microTypes = evaluateLiveAlerts({ previous, current: micro })
      .map((alert) => alert.alertType);
    expect(microTypes).not.toContain("DEBT_INCREASED");
    expect(microTypes).not.toContain("HEALTH_FACTOR_DETERIORATED");
  });

  it("does not emit an approaching-trigger alert while health factor is recovering", () => {
    const previous = buildArchivedLiveSnapshot(completeEnvelope({
      healthFactorWad: "1100000000000000000",
    }));
    const recovering = buildArchivedLiveSnapshot(completeEnvelope({
      block: BLOCK + 1n,
      healthFactorWad: "1130000000000000000",
    }));
    expect(evaluateLiveAlerts({ previous, current: recovering }).map((alert) => alert.alertType))
      .not.toContain("HEALTH_FACTOR_APPROACHING_TRIGGER");
  });

  it("prevents overlapping poll cycles and records the skipped cycle", async () => {
    const archive = new InMemoryLiveSnapshotArchive();
    let releaseRead!: () => void;
    let readStarted!: () => void;
    let readCount = 0;
    const started = new Promise<void>((resolve) => { readStarted = resolve; });
    const gate = new Promise<void>((resolve) => { releaseRead = resolve; });
    const poller = new LiveSnapshotPoller({
      archive,
      read: async () => {
        readCount += 1;
        readStarted();
        await gate;
        return completeEnvelope();
      },
      now: () => NOW,
    });
    const first = poller.pollOnce();
    await started;
    const second = poller.pollOnce();
    releaseRead();
    const [firstResult, secondResult] = await Promise.all([first, second]);
    expect(readCount).toBe(1);
    expect(secondResult.archived.entry.snapshot.snapshotHash)
      .toBe(firstResult.archived.entry.snapshot.snapshotHash);
    expect((await archive.operationalEvents()).map((event) => event.eventType))
      .toContain("POLL_SKIPPED_OVERLAP");
  });

  it("fails closed when durable storage is unavailable before reading new current state", async () => {
    let readCalled = false;
    const databaseUnavailable = {
      current: async () => { throw new Error("database unavailable"); },
    } as unknown as LiveSnapshotArchive;
    const poller = new LiveSnapshotPoller({
      archive: databaseUnavailable,
      read: async () => {
        readCalled = true;
        return completeEnvelope();
      },
    });
    await expect(poller.pollOnce()).rejects.toThrow(/database unavailable/i);
    expect(readCalled).toBe(false);
  });

  it("runs adapters through archive, alert delivery, and operator health end to end", async () => {
    const archive = new InMemoryLiveSnapshotArchive();
    await archive.archive(buildArchivedLiveSnapshot(completeEnvelope()), NOW.toISOString());
    const deliveredAlertIds: string[] = [];
    const delivery = new LiveAlertDeliveryService({
      store: archive,
      sinks: [{
        id: "operator-webhook",
        deliver: async (alert) => {
          deliveredAlertIds.push(alert.alertId);
          return { responseStatus: 202 };
        },
      }],
      now: () => new Date(NOW.getTime() + 60_000),
    });
    const poller = new LiveSnapshotPoller({
      archive,
      read: async () => completeEnvelope({ block: BLOCK + 1n, riskLevel: "HIGH" }),
      now: () => new Date(NOW.getTime() + 60_000),
      deliverAlerts: (alerts) => delivery.deliver(alerts),
    });

    const result = await poller.pollOnce();
    const health = await readOperationalHealth(archive, {
      now: new Date(NOW.getTime() + 60_000),
    });

    expect(result.archived.entry.snapshot.archiveStatus).toBe("COMPLETE");
    expect(result.alerts.map((alert) => alert.alertType)).toContain("RISK_CHANGED");
    expect(result.delivery?.delivered).toBeGreaterThan(0);
    expect(deliveredAlertIds).toHaveLength(result.alerts.length);
    expect(health.poller.state).toBe("HEALTHY");
    expect(health.alertDelivery.delivered).toBe(result.alerts.length);
    expect(health.current.snapshotHash).toBe(result.archived.entry.snapshot.snapshotHash);
    expect(health.broadcastPermitted).toBe(false);
    expect(health.transactionSubmitted).toBe(false);
  });
});

function completeEnvelope(overrides: {
  block?: bigint;
  healthFactorWad?: string;
  debtBalanceWei?: string;
  collateralBalanceWei?: string;
  xethPriceBase?: string;
  activeLiquidity?: string;
  estimatedSlippageBps?: number;
  riskLevel?: "NORMAL" | "MEDIUM" | "HIGH";
  sourceVersion?: number;
  oracleStatus?: "AVAILABLE" | "STALE";
  oracleAgeSeconds?: number;
} = {}): LiveSnapshotEnvelope {
  const block = overrides.block ?? BLOCK;
  const blockHash = overrides.block ? `0x${block.toString(16).padStart(64, "0")}` : BLOCK_HASH;
  const market = replayMarketContext(NOW);
  const policy = replayPolicy(NOW);
  const position = {
    ...market.position,
    blockNumber: block.toString(),
    healthFactorWad: overrides.healthFactorWad ?? market.position.healthFactorWad,
    debtBalanceWei: overrides.debtBalanceWei ?? market.position.debtBalanceWei,
    collateralBalanceWei: overrides.collateralBalanceWei ?? market.position.collateralBalanceWei,
    xethPriceBase: overrides.xethPriceBase ?? market.position.xethPriceBase,
  };
  const liquidity = {
    ...market.liquidity,
    blockNumber: block.toString(),
    activeLiquidity: overrides.activeLiquidity ?? market.liquidity.activeLiquidity,
    estimatedSlippageBps: overrides.estimatedSlippageBps ?? market.liquidity.estimatedSlippageBps,
  };
  const riskLevel = overrides.riskLevel ?? "NORMAL";
  const adapters = [
    "xlayer",
    "configuration",
    "aave",
    "xbeth",
    "oracle",
    "uniswap-pool",
    "uniswap",
    "rwa",
  ].map((adapter) => health(adapter, block));
  const oracleHealth = adapters.find((adapter) => adapter.adapter === "oracle")!;
  if (overrides.oracleStatus === "STALE") {
    oracleHealth.status = "STALE";
    oracleHealth.freshness.fresh = false;
    oracleHealth.freshness.ageSeconds = overrides.oracleAgeSeconds ?? 22_000;
    oracleHealth.freshness.sourceTimestamp = new Date(
      NOW.getTime() - (overrides.oracleAgeSeconds ?? 22_000) * 1_000,
    ).toISOString();
  }
  const oracle = {
    xbEth: feed(position.collateralToken, position.xbEthPriceBase),
    xeth: feed(position.debtToken, position.xethPriceBase),
    maxAgeSeconds: 21_600,
  };
  const pool = {
    factory: "0x4B2ab38DBF28D31D467aA8993f6c2585981D6804",
    pool: liquidity.pool,
    token0: liquidity.tokenIn,
    token1: liquidity.tokenOut,
    feeTier: liquidity.feeTier,
    sqrtPriceX96: "79228162514264337593543950336",
    tick: "0",
    activeLiquidity: liquidity.activeLiquidity,
    poolTokenInBalanceWei: liquidity.poolTokenInBalanceWei,
    poolTokenOutBalanceWei: liquidity.poolTokenOutBalanceWei,
    unlocked: true,
    configurationVerified: true,
  };
  const rwa = {
    status: "AVAILABLE" as const,
    riskLevel,
    verdictId: `verdict_${riskLevel.toLowerCase()}`,
    summary: `${riskLevel} fixture evidence.`,
    confidence: 0.95,
    claims: [],
    evidenceValid: true,
    latestRetrievedAt: NOW.toISOString(),
    sourceStates: [sourceState(overrides.sourceVersion ?? 1)],
    reasons: [],
    analyzer: "DETERMINISTIC_FILTER",
  };
  const policyState = {
    status: "PREVIEW_ONLY" as const,
    policy,
    reason: "Fixture policy is preview-only.",
  };
  const policyEvaluation = {
    intentId: "intent_live_fixture",
    riskEventId: "risk_live_fixture",
    riskVerdictId: rwa.verdictId,
    policyId: policy.policyId,
    allowed: false,
    autoExecutionEligible: false,
    requiresUserSignature: false,
    status: "REJECTED" as const,
    reasons: ["Read-only fixture."],
    checks: [],
    generatedAt: NOW.toISOString(),
    expiresAt: new Date(NOW.getTime() + 120_000).toISOString(),
    chainId: 196,
    egressContract: policy.egressContract,
    authorization: null,
    intentHash: `0x${"aa".repeat(32)}`,
  };
  const executionPreview = {
    status: "PREVIEW_ONLY" as const,
    plan: market.plan,
    policyEvaluation,
    broadcastPermitted: false as const,
    transactionSubmitted: false as const,
    reason: "LIVE_READ_ONLY never submits a transaction.",
  };
  const snapshotBase = {
    schemaVersion: 1 as const,
    mode: "LIVE_READ_ONLY" as const,
    generatedAt: NOW.toISOString(),
    chain: {
      chainId: 196,
      rpcUrl: "https://rpc.xlayer.tech",
      blockNumber: block.toString(),
      blockHash,
      blockTimestamp: NOW.toISOString(),
      rpcHealthy: true,
    },
    account: policy.user,
    aave: {
      position,
      collateralReserve: reserve(position.collateralToken),
      debtReserve: reserve(position.debtToken),
      flashLoanPremiumBps: 5,
      addressesProviderVerified: true,
      oracleAddressVerified: true,
    },
    tokens: {
      xbEth: token(position.collateralToken, "xBETH"),
      xeth: token(position.debtToken, "xETH"),
    },
    oracle,
    uniswap: { ...pool, quote: liquidity },
    rwa,
    policy: policyState,
    marketContext: { position, liquidity, plan: market.plan },
    executionPreview,
    freshness: {
      maxBlockAgeSeconds: 120,
      maxSourceAgeSeconds: 86_400,
      allRequiredFresh: true,
    },
    adapters,
    adapterVersions: Object.fromEntries(adapters.map((adapter) => [adapter.adapter, "1"])),
  };
  const snapshot = liveRiskSnapshotSchema.parse({
    ...snapshotBase,
    snapshotHash: liveSnapshotStateHash(
      snapshotBase as Omit<LiveRiskSnapshot, "snapshotHash">,
    ),
  });
  return liveSnapshotEnvelopeSchema.parse({
    mode: "LIVE_READ_ONLY",
    status: "AVAILABLE",
    generatedAt: NOW.toISOString(),
    snapshot,
    partial: {
      chain: snapshot.chain,
      account: snapshot.account,
      position,
      liquidity,
      oracle,
      uniswapPool: pool,
      rwa,
      policy: policyState,
      executionPreview,
    },
    adapters,
    reasons: [],
  });
}

function unavailableEnvelope(): LiveSnapshotEnvelope {
  const complete = completeEnvelope();
  const adapters = complete.adapters.map((adapter) => adapter.adapter === "aave"
    ? {
        ...adapter,
        status: "UNAVAILABLE" as const,
        message: "Aave unavailable",
        freshness: { ...adapter.freshness, fresh: false },
      }
    : adapter);
  return liveSnapshotEnvelopeSchema.parse({
    ...complete,
    status: "LIVE_DATA_UNAVAILABLE",
    snapshot: null,
    adapters,
    partial: {
      ...complete.partial,
      position: null,
      liquidity: null,
      executionPreview: null,
    },
    reasons: ["Aave unavailable"],
  });
}

function health(adapter: string, block: bigint): AdapterHealth {
  return {
    adapter,
    version: "1",
    status: "AVAILABLE",
    message: `${adapter} available`,
    freshness: {
      observedAt: NOW.toISOString(),
      sourceTimestamp: NOW.toISOString(),
      blockNumber: adapter === "rwa" ? "0" : block.toString(),
      ageSeconds: 0,
      maxAgeSeconds: adapter === "rwa" ? 86_400 : 120,
      fresh: true,
    },
    provenance: [adapter, `block:${block.toString()}`],
  };
}

function feed(asset: string, priceBase: string) {
  return {
    asset,
    oracle: "0x91FC11136d5615575a0fC5981Ab5C0C54418E2C6",
    source: "0x8b85b50535551F8E8cDAF78dA235b5Cf1005907b",
    sourceKind: "CHAINLINK" as const,
    priceBase,
    decimals: 8,
    answer: priceBase,
    updatedAt: NOW.toISOString(),
    roundId: "1",
    sourceDescription: "fixture",
    ratio: null,
    snapshotRatio: null,
    snapshotTimestamp: null,
    fresh: true,
    provenance: ["oracle-fixture"],
  };
}

function reserve(asset: string) {
  return {
    asset,
    rawData: "0",
    ltvBps: 8_800,
    liquidationThresholdBps: 9_000,
    liquidationBonusBps: 10_500,
    decimals: 18,
    active: true,
    frozen: false,
    borrowingEnabled: true,
    paused: false,
  };
}

function token(address: string, symbol: string) {
  return {
    address,
    symbol,
    name: symbol,
    decimals: 18,
    walletBalanceWei: "0",
    aTokenAllowanceWei: null,
  };
}

function sourceState(version: number) {
  const revisionId = `revision_${version}`;
  const previousRevisionId = version > 1 ? `revision_${version - 1}` : null;
  const contentHash = `sha256:${version.toString(16).padStart(64, "0")}`;
  const rawContentHash = `sha256:${(version + 100).toString(16).padStart(64, "0")}`;
  const diffId = `diff_${version}`;
  const diff = {
    diffId,
    sourceId: "okx-x-rwa-deposit-withdrawal",
    fromRevisionId: previousRevisionId,
    toRevisionId: revisionId,
    generatedAt: NOW.toISOString(),
    kind: version === 1 ? "INITIAL" as const : "CHANGED" as const,
    cosmeticOnly: false,
    summary: `Source revision ${version}.`,
    hunks: [],
  };
  const snapshot = {
    revisionId,
    sourceId: "okx-x-rwa-deposit-withdrawal",
    sourceUrl: "https://www.okx.com/help/how-does-xasset-work",
    sourceVersion: version,
    retrievedAt: NOW.toISOString(),
    contentHash,
    rawContentHash,
    rawContent: `<p>Revision ${version}</p>`,
    normalized: {
      title: "xAsset",
      description: "Fixture",
      text: `Revision ${version}`,
      lines: [{ line: 1, section: "xAsset", text: `Revision ${version}` }],
      semanticFingerprint: contentHash,
    },
    previousRevisionId,
    diffId,
    extractionStatus: "ANALYZED" as const,
    responseMetadata: {
      status: 200,
      contentType: "text/html",
      etag: null,
      lastModified: null,
      finalUrl: "https://www.okx.com/help/how-does-xasset-work",
    },
  };
  return {
    sourceId: snapshot.sourceId,
    sourceUrl: snapshot.sourceUrl,
    revisionId,
    sourceVersion: version,
    contentHash,
    retrievedAt: NOW.toISOString(),
    changed: version > 1,
    diff,
    snapshot,
  };
}
