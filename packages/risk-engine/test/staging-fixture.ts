import { parseEther, type Hex, type PublicClient } from "viem";
import {
  buildArchivedLiveSnapshot,
  buildOnchainProtectionPolicy,
  EgressShadowKeeper,
  executionProtocolConfigHash,
  executionProtocolFromConfig,
  InMemoryLiveSnapshotArchive,
  liveRiskSnapshotSchema,
  liveSnapshotEnvelopeSchema,
  liveSnapshotStateHash,
  protectionPolicyId,
  signAutonomousRiskAttestation,
  signProtectionPolicy,
  StaticMarketContextProvider,
  XLAYER_MAINNET,
  type AdapterHealth,
  type ExecutionStagingConfig,
  type ExecutionStagingRequest,
  type LiveRiskSnapshot,
  type LiveSnapshotEnvelope,
  type MarketContext,
  type RiskEventRecord,
} from "../src/index.js";
import { REPLAY_REVISIONS } from "../src/replay/fixtures.js";
import { InMemoryStore } from "../src/sources/store.js";
import {
  runRevision,
  TEST_ATTESTOR_ACCOUNT,
  TEST_NOW,
  TEST_USER_ACCOUNT,
} from "./helpers.js";

export const STAGING_ANCHOR_HASH = `0x${"77".repeat(32)}` as Hex;
export const STAGING_TRANSACTION_HASH = `0x${"88".repeat(32)}` as Hex;

export async function createStagingFixture(input: {
  simulationError?: Error;
  market?: MarketContext;
  submissionEnabled?: boolean;
} = {}) {
  const sourceStore = new InMemoryStore();
  await runRevision({ store: sourceStore, rawContent: REPLAY_REVISIONS.A });
  await runRevision({ store: sourceStore, rawContent: REPLAY_REVISIONS.B });
  const result = await runRevision({ store: sourceStore, rawContent: REPLAY_REVISIONS.C });
  if (!result.event || !result.event.marketContext || !result.event.intent) {
    throw new Error("Expected a complete HIGH staging event.");
  }
  const market = input.market ?? result.event.marketContext;
  const event: RiskEventRecord = {
    ...result.event,
    mode: "TEST",
    marketContext: market,
  };
  const protocol = executionProtocolFromConfig(XLAYER_MAINNET);
  const onchainPolicy = buildOnchainProtectionPolicy({
    policy: event.policy,
    protocolConfigHash: executionProtocolConfigHash(protocol),
    nonce: 91n,
    revocationNonce: 0n,
    maxExecutions: 2n,
    maxCumulativeRepaymentWei: parseEther("20"),
    maxCumulativeCollateralWei: parseEther("20"),
    maxPositionDebtWei: parseEther("50"),
    maxOracleDeviationBps: 200n,
  });
  const policyAuthorizationSignature = await signProtectionPolicy({
    account: TEST_USER_ACCOUNT,
    chainId: event.policy.chainId,
    egressContract: event.policy.egressContract as `0x${string}`,
    policy: onchainPolicy,
  });
  const riskAttestation = await signAutonomousRiskAttestation({
    account: TEST_ATTESTOR_ACCOUNT,
    verdict: event.verdict,
    policyId: protectionPolicyId({
      chainId: event.policy.chainId,
      egressContract: event.policy.egressContract as `0x${string}`,
      policy: onchainPolicy,
    }),
    chainId: event.policy.chainId,
    egressContract: event.policy.egressContract as `0x${string}`,
  });
  const envelope = await stagingEnvelope(event, sourceStore, market);
  const snapshot = buildArchivedLiveSnapshot(envelope, TEST_NOW.toISOString());
  const archive = new InMemoryLiveSnapshotArchive();
  await archive.archive(snapshot, TEST_NOW.toISOString());
  const broadcasts: unknown[] = [];
  const publicClient = {
    async getChainId() {
      return event.policy.chainId;
    },
    async readContract(request: { functionName: string }) {
      if (request.functionName === "policyStates") {
        return [
          onchainPolicy.user,
          true,
          0n,
          0n,
          0n,
          0n,
          parseEther("50"),
          parseEther("44.05"),
        ] as const;
      }
      if (request.functionName === "revocationNonces") return 0n;
      if (request.functionName === "paused") return false;
      if (request.functionName === "riskEventUsed") return false;
      if (request.functionName === "PROTOCOL_CONFIG_HASH") return executionProtocolConfigHash(protocol);
      if (request.functionName === "allowance") return parseEther("20");
      throw new Error(`Unexpected read ${request.functionName}`);
    },
    async simulateContract(request: unknown) {
      if (input.simulationError) throw input.simulationError;
      return { request: { ...(request as object), gas: 900_000n } };
    },
  } as unknown as PublicClient;
  const keeper = new EgressShadowKeeper({
    publicClient,
    marketProvider: new StaticMarketContextProvider(market),
    keeperAccount: event.policy.executor as `0x${string}`,
    now: () => TEST_NOW,
  });
  const config: ExecutionStagingConfig = {
    environment: "FORK_WRITE",
    submissionEnabled: input.submissionEnabled ?? false,
    rpcUrl: "http://127.0.0.1:8545/",
    chainId: 196,
    egressContract: event.policy.egressContract as `0x${string}`,
    keeperAddress: event.policy.executor as `0x${string}`,
    protocol,
    anchorBlockNumber: XLAYER_MAINNET.forkBlock,
    anchorBlockHash: STAGING_ANCHOR_HASH,
    forkRuntime: "ANVIL",
    databaseUrl: "postgresql://egress:secret@example.invalid/egress",
    environmentId: null,
    credentialReference: null,
    testnetManifestPath: null,
    testnetManifestHash: null,
    testnetDeployment: null,
    maxSnapshotAgeSeconds: 300,
    maxIntentAgeSeconds: 300,
    issues: [],
  };
  const request: ExecutionStagingRequest = {
    schemaVersion: 1,
    actionType: "AAVE_XBETH_XETH_DELEVERAGE",
    snapshotHash: snapshot.snapshotHash,
    riskEvent: event,
    policy: onchainPolicy,
    policyAuthorizationSignature,
    riskAttestation,
    environment: "FORK_WRITE",
    requestedAt: TEST_NOW.toISOString(),
  };
  return {
    archive,
    broadcasts,
    config,
    envelope,
    event,
    keeper,
    onchainPolicy,
    policyAuthorizationSignature,
    protocol,
    publicClient,
    request,
    riskAttestation,
    sourceStore,
    snapshot,
  };
}

async function stagingEnvelope(
  event: RiskEventRecord,
  store: InMemoryStore,
  market: MarketContext,
): Promise<LiveSnapshotEnvelope> {
  const block = BigInt(market.position.blockNumber);
  const currentRevision = await store.getRevision(event.verdict.sourceRevisionIds[0]!);
  if (!currentRevision?.diffId) throw new Error("Missing staging source revision.");
  const diff = await store.getDiff(currentRevision.diffId);
  if (!diff) throw new Error("Missing staging source diff.");
  const adapters = [
    "xlayer",
    "configuration",
    "aave",
    "xbeth",
    "oracle",
    "uniswap-pool",
    "uniswap",
    "rwa",
  ].map((adapter) => adapterHealth(adapter, block));
  const oracle = {
    xbEth: feed(market.position.collateralToken, market.position.xbEthPriceBase, XLAYER_MAINNET.contracts.xbEthOracleSource),
    xeth: feed(market.position.debtToken, market.position.xethPriceBase, XLAYER_MAINNET.contracts.xethOracleSource),
    maxAgeSeconds: 21_600,
  };
  const pool = {
    factory: XLAYER_MAINNET.contracts.uniswapFactory,
    pool: XLAYER_MAINNET.contracts.swapPool,
    token0: XLAYER_MAINNET.contracts.xbEth,
    token1: XLAYER_MAINNET.contracts.xeth,
    feeTier: XLAYER_MAINNET.poolFee,
    sqrtPriceX96: "79228162514264337593543950336",
    tick: "0",
    activeLiquidity: market.liquidity.activeLiquidity,
    poolTokenInBalanceWei: market.liquidity.poolTokenInBalanceWei,
    poolTokenOutBalanceWei: market.liquidity.poolTokenOutBalanceWei,
    unlocked: true,
    configurationVerified: true,
  };
  const sourceState = {
    sourceId: currentRevision.sourceId,
    sourceUrl: currentRevision.sourceUrl,
    revisionId: currentRevision.revisionId,
    sourceVersion: currentRevision.sourceVersion,
    contentHash: currentRevision.contentHash,
    retrievedAt: currentRevision.retrievedAt,
    changed: true,
    diff,
    snapshot: currentRevision,
  };
  const rwa = {
    status: "AVAILABLE" as const,
    riskLevel: event.verdict.riskLevel,
    verdictId: event.verdict.verdictId,
    summary: event.verdict.summary,
    confidence: event.verdict.confidence,
    claims: event.verdict.claims,
    evidenceValid: true,
    latestRetrievedAt: currentRevision.retrievedAt,
    sourceStates: [sourceState],
    reasons: [],
    analyzer: event.verdict.analyzer.analyzer,
  };
  const policyState = {
    status: "PREVIEW_ONLY" as const,
    policy: event.policy,
    reason: "Staging fixture remains preview-only in the archived observation.",
  };
  const executionPreview = {
    status: "PREVIEW_ONLY" as const,
    plan: market.plan,
    policyEvaluation: event.intent!,
    broadcastPermitted: false as const,
    transactionSubmitted: false as const,
    reason: "Archived live evidence cannot submit a transaction.",
  };
  const base = {
    schemaVersion: 1 as const,
    mode: "LIVE_READ_ONLY" as const,
    generatedAt: TEST_NOW.toISOString(),
    chain: {
      chainId: 196,
      rpcUrl: XLAYER_MAINNET.rpcUrl,
      blockNumber: block.toString(),
      blockHash: STAGING_ANCHOR_HASH,
      blockTimestamp: TEST_NOW.toISOString(),
      rpcHealthy: true,
    },
    account: event.policy.user,
    aave: {
      position: market.position,
      collateralReserve: reserve(XLAYER_MAINNET.contracts.xbEth),
      debtReserve: reserve(XLAYER_MAINNET.contracts.xeth),
      flashLoanPremiumBps: 5,
      addressesProviderVerified: true,
      oracleAddressVerified: true,
    },
    tokens: {
      xbEth: token(XLAYER_MAINNET.contracts.xbEth, "xBETH"),
      xeth: token(XLAYER_MAINNET.contracts.xeth, "xETH"),
    },
    oracle,
    uniswap: { ...pool, quote: market.liquidity },
    rwa,
    policy: policyState,
    marketContext: market,
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
    ...base,
    snapshotHash: liveSnapshotStateHash(base as Omit<LiveRiskSnapshot, "snapshotHash">),
  });
  return liveSnapshotEnvelopeSchema.parse({
    mode: "LIVE_READ_ONLY",
    status: "AVAILABLE",
    generatedAt: TEST_NOW.toISOString(),
    snapshot,
    partial: {
      chain: snapshot.chain,
      account: snapshot.account,
      position: market.position,
      liquidity: market.liquidity,
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

function adapterHealth(adapter: string, block: bigint): AdapterHealth {
  return {
    adapter,
    version: "1",
    status: "AVAILABLE",
    message: `${adapter} available`,
    freshness: {
      observedAt: TEST_NOW.toISOString(),
      sourceTimestamp: TEST_NOW.toISOString(),
      blockNumber: adapter === "rwa" ? "0" : block.toString(),
      ageSeconds: 0,
      maxAgeSeconds: adapter === "rwa" ? 86_400 : 120,
      fresh: true,
    },
    provenance: [adapter, `block:${block.toString()}`],
  };
}

function feed(asset: string, priceBase: string, source: string) {
  return {
    asset,
    oracle: XLAYER_MAINNET.contracts.aaveOracle,
    source,
    sourceKind: "CHAINLINK" as const,
    priceBase,
    decimals: 8,
    answer: priceBase,
    updatedAt: TEST_NOW.toISOString(),
    roundId: "1",
    sourceDescription: "staging fixture",
    ratio: null,
    snapshotRatio: null,
    snapshotTimestamp: null,
    fresh: true,
    provenance: [source],
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
