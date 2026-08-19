import {
  buildArchivedLiveSnapshot,
  liveRiskSnapshotSchema,
  liveSnapshotEnvelopeSchema,
  liveSnapshotStateHash,
  type AdapterHealth,
  type LiveRiskSnapshot,
  type LiveSnapshotEnvelope,
} from "../src/index.js";
import { XLAYER_MAINNET } from "../src/market/config.js";
import { replayMarketContext, replayPolicy } from "../src/replay/fixtures.js";

const FIXTURE_NOW = new Date("2026-08-15T10:00:00.000Z");
const FIXTURE_BLOCK = 67_881_241n;
const FIXTURE_BLOCK_HASH = `0x${"52".repeat(32)}` as `0x${string}`;

/** Builds a compact, deterministic archive record without relying on .data. */
export function createPostgresArchiveFixture() {
  return buildArchivedLiveSnapshot(createEnvelope(), FIXTURE_NOW.toISOString());
}

function createEnvelope(): LiveSnapshotEnvelope {
  const market = replayMarketContext(FIXTURE_NOW);
  const policy = replayPolicy(FIXTURE_NOW);
  const position = {
    ...market.position,
    blockNumber: FIXTURE_BLOCK.toString(),
    observedAt: FIXTURE_NOW.toISOString(),
  };
  const liquidity = {
    ...market.liquidity,
    blockNumber: FIXTURE_BLOCK.toString(),
    observedAt: FIXTURE_NOW.toISOString(),
  };
  const adapters = [
    "xlayer",
    "configuration",
    "aave",
    "xbeth",
    "oracle",
    "uniswap-pool",
    "uniswap",
    "rwa",
  ].map((adapter) => adapterHealth(adapter));
  const oracle = {
    xbEth: feed(
      position.collateralToken,
      position.xbEthPriceBase,
      XLAYER_MAINNET.contracts.xbEthOracleSource,
      "CAPPED_RATIO",
    ),
    xeth: feed(
      position.debtToken,
      position.xethPriceBase,
      XLAYER_MAINNET.contracts.xethOracleSource,
      "CHAINLINK",
    ),
    maxAgeSeconds: 21_600,
  };
  const pool = {
    factory: XLAYER_MAINNET.contracts.uniswapFactory,
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
    riskLevel: "NORMAL" as const,
    verdictId: "verdict_normal",
    summary: "Deterministic archive fixture evidence.",
    confidence: 0.95,
    claims: [],
    evidenceValid: true,
    latestRetrievedAt: FIXTURE_NOW.toISOString(),
    sourceStates: [sourceState()],
    reasons: [],
    analyzer: "DETERMINISTIC_FILTER",
  };
  const policyState = {
    status: "PREVIEW_ONLY" as const,
    policy,
    reason: "The archive fixture is read-only.",
  };
  const policyEvaluation = {
    intentId: "intent_archive_fixture",
    riskEventId: "risk_archive_fixture",
    riskVerdictId: rwa.verdictId,
    policyId: policy.policyId,
    allowed: false,
    autoExecutionEligible: false,
    requiresUserSignature: false,
    status: "REJECTED" as const,
    reasons: ["Read-only archive fixture."],
    checks: [],
    generatedAt: FIXTURE_NOW.toISOString(),
    expiresAt: new Date(FIXTURE_NOW.getTime() + 120_000).toISOString(),
    chainId: XLAYER_MAINNET.chainId,
    egressContract: policy.egressContract,
    authorization: null,
    intentHash: `0x${"aa".repeat(32)}` as `0x${string}`,
  };
  const executionPreview = {
    status: "PREVIEW_ONLY" as const,
    plan: market.plan,
    policyEvaluation,
    broadcastPermitted: false as const,
    transactionSubmitted: false as const,
    reason: "The archive fixture cannot submit a transaction.",
  };
  const snapshotBase = {
    schemaVersion: 1 as const,
    mode: "LIVE_READ_ONLY" as const,
    generatedAt: FIXTURE_NOW.toISOString(),
    chain: {
      chainId: XLAYER_MAINNET.chainId,
      rpcUrl: XLAYER_MAINNET.rpcUrl,
      blockNumber: FIXTURE_BLOCK.toString(),
      blockHash: FIXTURE_BLOCK_HASH,
      blockTimestamp: FIXTURE_NOW.toISOString(),
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
    generatedAt: FIXTURE_NOW.toISOString(),
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

function adapterHealth(adapter: string): AdapterHealth {
  return {
    adapter,
    version: "1",
    status: "AVAILABLE",
    message: `${adapter} fixture available`,
    freshness: {
      observedAt: FIXTURE_NOW.toISOString(),
      sourceTimestamp: FIXTURE_NOW.toISOString(),
      blockNumber: adapter === "rwa" ? "0" : FIXTURE_BLOCK.toString(),
      ageSeconds: 0,
      maxAgeSeconds: adapter === "rwa" ? 86_400 : 120,
      fresh: true,
    },
    provenance: [`fixture:${adapter}`],
  };
}

function feed(
  asset: string,
  priceBase: string,
  source: string,
  sourceKind: "CHAINLINK" | "CAPPED_RATIO",
) {
  return {
    asset,
    oracle: XLAYER_MAINNET.contracts.aaveOracle,
    source,
    sourceKind,
    priceBase,
    decimals: 8,
    answer: priceBase,
    updatedAt: FIXTURE_NOW.toISOString(),
    roundId: "1",
    sourceDescription: "deterministic fixture",
    ratio: sourceKind === "CAPPED_RATIO" ? "1000000000000000000" : null,
    snapshotRatio: sourceKind === "CAPPED_RATIO" ? "1000000000000000000" : null,
    snapshotTimestamp: sourceKind === "CAPPED_RATIO" ? FIXTURE_NOW.toISOString() : null,
    fresh: true,
    provenance: ["fixture:oracle"],
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

function sourceState() {
  const contentHash = `sha256:${"1".padStart(64, "0")}`;
  const rawContentHash = `sha256:${"65".padStart(64, "0")}`;
  const sourceUrl = "https://www.okx.com/help/how-does-xasset-work";
  const revisionId = "revision_archive_fixture";
  const diffId = "diff_archive_fixture";
  const diff = {
    diffId,
    sourceId: "okx-x-rwa-deposit-withdrawal",
    fromRevisionId: null,
    toRevisionId: revisionId,
    generatedAt: FIXTURE_NOW.toISOString(),
    kind: "INITIAL" as const,
    cosmeticOnly: false,
    summary: "Deterministic archive fixture revision.",
    hunks: [],
  };
  const snapshot = {
    revisionId,
    sourceId: "okx-x-rwa-deposit-withdrawal",
    sourceUrl,
    sourceVersion: 1,
    retrievedAt: FIXTURE_NOW.toISOString(),
    contentHash,
    rawContentHash,
    rawContent: "Deterministic archive fixture content.",
    normalized: {
      title: "xAsset fixture",
      description: "Deterministic archive fixture.",
      text: "Deterministic archive fixture content.",
      lines: [{ line: 1, section: "fixture", text: "Deterministic archive fixture content." }],
      semanticFingerprint: contentHash,
    },
    previousRevisionId: null,
    diffId,
    extractionStatus: "ANALYZED" as const,
    responseMetadata: {
      status: 200,
      contentType: "text/plain",
      etag: null,
      lastModified: null,
      finalUrl: sourceUrl,
    },
  };
  return {
    sourceId: snapshot.sourceId,
    sourceUrl,
    revisionId,
    sourceVersion: 1,
    contentHash,
    retrievedAt: FIXTURE_NOW.toISOString(),
    changed: false,
    diff,
    snapshot,
  };
}
