import { z } from "zod";
import {
  addressSchema,
  executionIntentSchema,
  executionPlanSchema,
  hex32Schema,
  isoTimestampSchema,
  liquidityQuoteSchema,
  marketContextSchema,
  positionStateSchema,
  riskLevelSchema,
  sourceDiffSchema,
  sourceSnapshotSchema,
  uintStringSchema,
  userProtectionPolicySchema,
} from "../domain/schemas.js";
import { runtimeModeSchema } from "./modes.js";

export const adapterStatusSchema = z.enum([
  "AVAILABLE",
  "UNAVAILABLE",
  "STALE",
  "INVALID_CONFIGURATION",
]);

export const adapterFreshnessSchema = z.object({
  observedAt: isoTimestampSchema,
  sourceTimestamp: isoTimestampSchema.nullable(),
  blockNumber: uintStringSchema.nullable(),
  ageSeconds: z.number().nonnegative().finite().nullable(),
  maxAgeSeconds: z.number().int().nonnegative(),
  fresh: z.boolean(),
});

export const adapterHealthSchema = z.object({
  adapter: z.string().min(1),
  version: z.string().min(1),
  status: adapterStatusSchema,
  message: z.string().min(1),
  freshness: adapterFreshnessSchema,
  provenance: z.array(z.string()),
  latencyMs: z.number().int().nonnegative().nullable().optional(),
});

export const xLayerBlockStateSchema = z.object({
  chainId: z.number().int().positive(),
  rpcUrl: z.string().url(),
  blockNumber: uintStringSchema,
  blockHash: hex32Schema,
  blockTimestamp: isoTimestampSchema,
  rpcHealthy: z.boolean(),
});

export const reserveConfigurationSchema = z.object({
  asset: addressSchema,
  rawData: uintStringSchema,
  ltvBps: z.number().int().min(0).max(10_000),
  liquidationThresholdBps: z.number().int().min(0).max(10_000),
  liquidationBonusBps: z.number().int().nonnegative(),
  decimals: z.number().int().min(0).max(255),
  active: z.boolean(),
  frozen: z.boolean(),
  borrowingEnabled: z.boolean(),
  paused: z.boolean(),
});

export const aaveLiveStateSchema = z.object({
  position: positionStateSchema,
  collateralReserve: reserveConfigurationSchema,
  debtReserve: reserveConfigurationSchema,
  flashLoanPremiumBps: z.number().int().nonnegative(),
  addressesProviderVerified: z.boolean(),
  oracleAddressVerified: z.boolean(),
});

export const tokenLiveStateSchema = z.object({
  address: addressSchema,
  symbol: z.string().min(1),
  name: z.string().min(1),
  decimals: z.number().int().min(0).max(255),
  walletBalanceWei: uintStringSchema,
  aTokenAllowanceWei: uintStringSchema.nullable(),
});

export const oracleFeedStateSchema = z.object({
  asset: addressSchema,
  oracle: addressSchema,
  source: addressSchema,
  sourceKind: z.enum(["CHAINLINK", "CAPPED_RATIO"]),
  priceBase: uintStringSchema,
  decimals: z.number().int().min(0).max(255),
  answer: z.string(),
  updatedAt: isoTimestampSchema.nullable(),
  roundId: uintStringSchema.nullable(),
  sourceDescription: z.string().nullable(),
  ratio: uintStringSchema.nullable(),
  snapshotRatio: uintStringSchema.nullable(),
  snapshotTimestamp: isoTimestampSchema.nullable(),
  fresh: z.boolean(),
  provenance: z.array(z.string()),
});

export const oracleLiveStateSchema = z.object({
  xbEth: oracleFeedStateSchema,
  xeth: oracleFeedStateSchema,
  maxAgeSeconds: z.number().int().positive(),
});

export const uniswapPoolLiveStateSchema = z.object({
  factory: addressSchema,
  pool: addressSchema,
  token0: addressSchema,
  token1: addressSchema,
  feeTier: z.number().int().min(0).max(1_000_000),
  sqrtPriceX96: uintStringSchema,
  tick: z.string(),
  activeLiquidity: uintStringSchema,
  poolTokenInBalanceWei: uintStringSchema,
  poolTokenOutBalanceWei: uintStringSchema,
  unlocked: z.boolean(),
  configurationVerified: z.boolean(),
});

export const uniswapLiveStateSchema = uniswapPoolLiveStateSchema.extend({
  quote: liquidityQuoteSchema,
});

export const rwaSourceStateSchema = z.object({
  sourceId: z.string().min(1),
  sourceUrl: z.string().url(),
  revisionId: z.string().min(1),
  sourceVersion: z.number().int().positive(),
  contentHash: z.string().min(1),
  retrievedAt: isoTimestampSchema,
  changed: z.boolean(),
  diff: sourceDiffSchema,
  snapshot: sourceSnapshotSchema,
});

export const liveRwaEvidenceSchema = z.object({
  status: z.enum(["AVAILABLE", "LIVE_DATA_UNAVAILABLE"]),
  riskLevel: riskLevelSchema.nullable(),
  verdictId: z.string().nullable(),
  summary: z.string(),
  confidence: z.number().min(0).max(1).nullable(),
  claims: z.array(z.unknown()),
  evidenceValid: z.boolean(),
  latestRetrievedAt: isoTimestampSchema.nullable(),
  sourceStates: z.array(rwaSourceStateSchema),
  reasons: z.array(z.string()),
  analyzer: z.string().nullable(),
});

export const livePolicyStateSchema = z.object({
  status: z.enum(["UNCONFIGURED", "PREVIEW_ONLY", "REGISTERED"]),
  policy: userProtectionPolicySchema.nullable(),
  reason: z.string(),
});

export const liveExecutionPreviewSchema = z.object({
  status: z.literal("PREVIEW_ONLY"),
  plan: executionPlanSchema,
  policyEvaluation: executionIntentSchema,
  broadcastPermitted: z.literal(false),
  transactionSubmitted: z.literal(false),
  reason: z.string().min(1),
});

export const liveRiskSnapshotSchema = z.object({
  schemaVersion: z.literal(1),
  mode: z.literal("LIVE_READ_ONLY"),
  generatedAt: isoTimestampSchema,
  chain: xLayerBlockStateSchema,
  account: addressSchema,
  aave: aaveLiveStateSchema,
  tokens: z.object({ xbEth: tokenLiveStateSchema, xeth: tokenLiveStateSchema }),
  oracle: oracleLiveStateSchema,
  uniswap: uniswapLiveStateSchema,
  rwa: liveRwaEvidenceSchema,
  policy: livePolicyStateSchema,
  marketContext: marketContextSchema,
  executionPreview: liveExecutionPreviewSchema,
  freshness: z.object({
    maxBlockAgeSeconds: z.number().int().positive(),
    maxSourceAgeSeconds: z.number().int().positive(),
    allRequiredFresh: z.boolean(),
  }),
  adapters: z.array(adapterHealthSchema),
  adapterVersions: z.record(z.string(), z.string()),
  snapshotHash: hex32Schema,
});

export const liveSnapshotEnvelopeSchema = z.object({
  mode: runtimeModeSchema,
  status: z.enum(["AVAILABLE", "LIVE_DATA_UNAVAILABLE"]),
  generatedAt: isoTimestampSchema,
  snapshot: liveRiskSnapshotSchema.nullable(),
  partial: z.object({
    chain: xLayerBlockStateSchema.nullable(),
    account: addressSchema.nullable(),
    position: positionStateSchema.nullable(),
    liquidity: liquidityQuoteSchema.nullable(),
    oracle: oracleLiveStateSchema.nullable(),
    uniswapPool: uniswapPoolLiveStateSchema.nullable(),
    rwa: liveRwaEvidenceSchema.nullable(),
    policy: livePolicyStateSchema.nullable(),
    executionPreview: liveExecutionPreviewSchema.nullable(),
  }),
  adapters: z.array(adapterHealthSchema),
  reasons: z.array(z.string()),
});

export type AdapterStatus = z.infer<typeof adapterStatusSchema>;
export type AdapterFreshness = z.infer<typeof adapterFreshnessSchema>;
export type AdapterHealth = z.infer<typeof adapterHealthSchema>;
export type XLayerBlockState = z.infer<typeof xLayerBlockStateSchema>;
export type ReserveConfiguration = z.infer<typeof reserveConfigurationSchema>;
export type AaveLiveState = z.infer<typeof aaveLiveStateSchema>;
export type TokenLiveState = z.infer<typeof tokenLiveStateSchema>;
export type OracleFeedState = z.infer<typeof oracleFeedStateSchema>;
export type OracleLiveState = z.infer<typeof oracleLiveStateSchema>;
export type UniswapPoolLiveState = z.infer<typeof uniswapPoolLiveStateSchema>;
export type UniswapLiveState = z.infer<typeof uniswapLiveStateSchema>;
export type RwaSourceState = z.infer<typeof rwaSourceStateSchema>;
export type LiveRwaEvidence = z.infer<typeof liveRwaEvidenceSchema>;
export type LivePolicyState = z.infer<typeof livePolicyStateSchema>;
export type LiveExecutionPreview = z.infer<typeof liveExecutionPreviewSchema>;
export type LiveRiskSnapshot = z.infer<typeof liveRiskSnapshotSchema>;
export type LiveSnapshotEnvelope = z.infer<typeof liveSnapshotEnvelopeSchema>;

export interface LiveAdapterFailure {
  health: AdapterHealth;
  reason: string;
}

export function unavailableHealth(
  adapter: string,
  message: string,
  now: Date,
  options: { blockNumber?: bigint; maxAgeSeconds?: number; status?: AdapterStatus } = {},
): AdapterHealth {
  return {
    adapter,
    version: "1",
    status: options.status ?? "UNAVAILABLE",
    message,
    freshness: {
      observedAt: now.toISOString(),
      sourceTimestamp: null,
      blockNumber: options.blockNumber?.toString() ?? null,
      ageSeconds: null,
      maxAgeSeconds: options.maxAgeSeconds ?? 0,
      fresh: false,
    },
    provenance: [],
  };
}

export function availableHealth(input: {
  adapter: string;
  version?: string;
  message: string;
  now: Date;
  blockNumber: bigint;
  sourceTimestamp?: Date;
  maxAgeSeconds: number;
  provenance: string[];
}): AdapterHealth {
  const ageSeconds = input.sourceTimestamp
    ? Math.max(0, (input.now.getTime() - input.sourceTimestamp.getTime()) / 1000)
    : 0;
  const fresh = ageSeconds <= input.maxAgeSeconds;
  return {
    adapter: input.adapter,
    version: input.version ?? "1",
    status: fresh ? "AVAILABLE" : "STALE",
    message: fresh ? input.message : `${input.adapter} data is stale (${ageSeconds.toFixed(0)}s old).`,
    freshness: {
      observedAt: input.now.toISOString(),
      sourceTimestamp: input.sourceTimestamp?.toISOString() ?? null,
      blockNumber: input.blockNumber.toString(),
      ageSeconds,
      maxAgeSeconds: input.maxAgeSeconds,
      fresh,
    },
    provenance: input.provenance,
  };
}

// Kept as a named type so callers cannot accidentally pass an execution plan
// produced by an AI response into the snapshot builder.
export type LiveExecutionPlan = z.infer<typeof executionPlanSchema>;
