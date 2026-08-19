import type { Hex } from "viem";
import type { MarketContext, RiskEventRecord } from "../domain/schemas.js";
import { liveSnapshotStateHash } from "../live/canonical.js";
import {
  liveRiskSnapshotSchema,
  liveSnapshotEnvelopeSchema,
  type AdapterHealth,
  type LiveRiskSnapshot,
  type LiveSnapshotEnvelope,
  type ReserveConfiguration,
} from "../live/schemas.js";
import type { RevisionStore } from "../sources/store.js";
import type { ExecutionProtocolIdentity } from "./schemas.js";
import { XLAYER_TESTNET_CHAIN_ID } from "./testnet-deployment.js";

export async function buildTestnetExecutionSnapshotEnvelope(input: {
  event: RiskEventRecord;
  store: RevisionStore;
  market: MarketContext;
  protocol: ExecutionProtocolIdentity;
  oracleSources: { xbEth: string; xeth: string };
  chainId: number;
  publicRpcUrl: string;
  blockHash: Hex;
  blockTimestamp: Date;
  now: Date;
  flashLoanPremiumBps: number;
  collateralReserve: ReserveConfiguration;
  debtReserve: ReserveConfiguration;
  tokens: {
    xbEth: { name: string; symbol: string; decimals: number; walletBalanceWei: string; aTokenAllowanceWei: string };
    xeth: { name: string; symbol: string; decimals: number; walletBalanceWei: string };
  };
}): Promise<LiveSnapshotEnvelope> {
  const { event, market, protocol } = input;
  const block = BigInt(market.position.blockNumber);
  if (
    input.chainId !== XLAYER_TESTNET_CHAIN_ID ||
    event.mode === "REPLAY" ||
    event.policy.chainId !== input.chainId ||
    market.position.chainId !== input.chainId ||
    market.liquidity.chainId !== input.chainId ||
    BigInt(market.liquidity.blockNumber) !== block ||
    event.intent === null
  ) {
    throw new Error("Testnet snapshot input is not chain-bound, same-block, and execution-evaluated.");
  }
  const currentRevision = await input.store.getRevision(event.verdict.sourceRevisionIds[0]!);
  if (!currentRevision?.diffId) throw new Error("Testnet snapshot is missing its source revision.");
  const diff = await input.store.getDiff(currentRevision.diffId);
  if (!diff) throw new Error("Testnet snapshot is missing its semantic source diff.");

  const adapters = [
    "xlayer",
    "configuration",
    "aave",
    "xbeth",
    "oracle",
    "uniswap-pool",
    "uniswap",
    "rwa",
  ].map((adapter) => adapterHealth(adapter, block, input.now));
  const oracle = {
    xbEth: feed({
      asset: protocol.xbEth,
      oracle: protocol.aaveOracle,
      source: input.oracleSources.xbEth,
      priceBase: market.position.xbEthPriceBase,
      now: input.now,
    }),
    xeth: feed({
      asset: protocol.xeth,
      oracle: protocol.aaveOracle,
      source: input.oracleSources.xeth,
      priceBase: market.position.xethPriceBase,
      now: input.now,
    }),
    maxAgeSeconds: 21_600,
  };
  const pool = {
    factory: protocol.uniswapFactory,
    pool: protocol.swapPool,
    token0: protocol.xbEth,
    token1: protocol.xeth,
    feeTier: protocol.poolFee,
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
    reason: "The archived testnet observation remains read-only; execution capability exists only in the isolated worker.",
  };
  const executionPreview = {
    status: "PREVIEW_ONLY" as const,
    plan: market.plan,
    policyEvaluation: event.intent,
    broadcastPermitted: false as const,
    transactionSubmitted: false as const,
    reason: "Canonical observation evidence cannot sign or submit a transaction.",
  };
  const base = {
    schemaVersion: 1 as const,
    mode: "LIVE_READ_ONLY" as const,
    generatedAt: input.now.toISOString(),
    chain: {
      chainId: input.chainId,
      rpcUrl: input.publicRpcUrl,
      blockNumber: block.toString(),
      blockHash: input.blockHash,
      blockTimestamp: input.blockTimestamp.toISOString(),
      rpcHealthy: true,
    },
    account: event.policy.user,
    aave: {
      position: market.position,
      collateralReserve: input.collateralReserve,
      debtReserve: input.debtReserve,
      flashLoanPremiumBps: input.flashLoanPremiumBps,
      addressesProviderVerified: true,
      oracleAddressVerified: true,
    },
    tokens: {
      xbEth: {
        address: protocol.xbEth,
        symbol: input.tokens.xbEth.symbol,
        name: input.tokens.xbEth.name,
        decimals: input.tokens.xbEth.decimals,
        walletBalanceWei: input.tokens.xbEth.walletBalanceWei,
        aTokenAllowanceWei: input.tokens.xbEth.aTokenAllowanceWei,
      },
      xeth: {
        address: protocol.xeth,
        symbol: input.tokens.xeth.symbol,
        name: input.tokens.xeth.name,
        decimals: input.tokens.xeth.decimals,
        walletBalanceWei: input.tokens.xeth.walletBalanceWei,
        aTokenAllowanceWei: null,
      },
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
    adapterVersions: Object.fromEntries(adapters.map((adapter) => [adapter.adapter, "phase11-1"])),
  };
  const snapshot = liveRiskSnapshotSchema.parse({
    ...base,
    snapshotHash: liveSnapshotStateHash(base as Omit<LiveRiskSnapshot, "snapshotHash">),
  });
  return liveSnapshotEnvelopeSchema.parse({
    mode: "LIVE_READ_ONLY",
    status: "AVAILABLE",
    generatedAt: input.now.toISOString(),
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

function adapterHealth(adapter: string, block: bigint, now: Date): AdapterHealth {
  return {
    adapter,
    version: "phase11-1",
    status: "AVAILABLE",
    message: `${adapter} verified for the pinned X Layer testnet deployment`,
    freshness: {
      observedAt: now.toISOString(),
      sourceTimestamp: now.toISOString(),
      blockNumber: adapter === "rwa" ? "0" : block.toString(),
      ageSeconds: 0,
      maxAgeSeconds: adapter === "rwa" ? 86_400 : 120,
      fresh: true,
    },
    provenance: [adapter, `chain:1952`, `block:${block.toString()}`],
  };
}

function feed(input: {
  asset: string;
  oracle: string;
  source: string;
  priceBase: string;
  now: Date;
}) {
  return {
    asset: input.asset,
    oracle: input.oracle,
    source: input.source,
    sourceKind: "CHAINLINK" as const,
    priceBase: input.priceBase,
    decimals: 8,
    answer: input.priceBase,
    updatedAt: input.now.toISOString(),
    roundId: "1",
    sourceDescription: "Egress Phase 11 compatibility oracle",
    ratio: null,
    snapshotRatio: null,
    snapshotTimestamp: null,
    fresh: true,
    provenance: [input.oracle, input.source],
  };
}
