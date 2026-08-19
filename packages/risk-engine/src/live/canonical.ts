import { objectHash, stableStringify } from "../domain/hash.js";
import type {
  LiveExecutionPreview,
  LivePolicyState,
  LiveRiskSnapshot,
  LiveRwaEvidence,
  LiveSnapshotEnvelope,
  OracleFeedState,
} from "./schemas.js";

type SnapshotWithoutHash = Omit<LiveRiskSnapshot, "snapshotHash">;

export function canonicalLiveSnapshotState(
  snapshot: LiveRiskSnapshot | SnapshotWithoutHash,
  options: { includeVolatileAdapterSourceTimestamp?: boolean } = {},
): unknown {
  return normalizeCanonical({
    schemaVersion: snapshot.schemaVersion,
    mode: snapshot.mode,
    chain: canonicalChain(snapshot.chain),
    account: snapshot.account,
    aave: {
      position: canonicalPosition(snapshot.aave.position),
      collateralReserve: snapshot.aave.collateralReserve,
      debtReserve: snapshot.aave.debtReserve,
      flashLoanPremiumBps: snapshot.aave.flashLoanPremiumBps,
      addressesProviderVerified: snapshot.aave.addressesProviderVerified,
      oracleAddressVerified: snapshot.aave.oracleAddressVerified,
    },
    tokens: snapshot.tokens,
    oracle: canonicalOracle(snapshot.oracle),
    uniswap: {
      factory: snapshot.uniswap.factory,
      pool: snapshot.uniswap.pool,
      token0: snapshot.uniswap.token0,
      token1: snapshot.uniswap.token1,
      feeTier: snapshot.uniswap.feeTier,
      sqrtPriceX96: snapshot.uniswap.sqrtPriceX96,
      tick: snapshot.uniswap.tick,
      activeLiquidity: snapshot.uniswap.activeLiquidity,
      poolTokenInBalanceWei: snapshot.uniswap.poolTokenInBalanceWei,
      poolTokenOutBalanceWei: snapshot.uniswap.poolTokenOutBalanceWei,
      unlocked: snapshot.uniswap.unlocked,
      configurationVerified: snapshot.uniswap.configurationVerified,
      quote: canonicalLiquidity(snapshot.uniswap.quote),
    },
    rwa: canonicalRwa(snapshot.rwa),
    policy: canonicalPolicy(snapshot.policy),
    marketPlan: snapshot.marketContext.plan,
    executionPreview: canonicalExecutionPreview(snapshot.executionPreview),
    freshness: snapshot.freshness,
    adapters: canonicalAdapters(snapshot.adapters, options.includeVolatileAdapterSourceTimestamp ?? false),
    adapterVersions: snapshot.adapterVersions,
  });
}

export function canonicalLiveSnapshotSerialization(
  snapshot: LiveRiskSnapshot | SnapshotWithoutHash,
): string {
  return stableStringify(canonicalLiveSnapshotState(snapshot));
}

export function liveSnapshotStateHash(
  snapshot: LiveRiskSnapshot | SnapshotWithoutHash,
): `0x${string}` {
  return objectHash(canonicalLiveSnapshotState(snapshot));
}

function legacyLiveSnapshotStateHash(
  snapshot: LiveRiskSnapshot | SnapshotWithoutHash,
): `0x${string}` {
  return objectHash(canonicalLiveSnapshotState(snapshot, {
    includeVolatileAdapterSourceTimestamp: true,
  }));
}

export function verifyLiveSnapshotHash(snapshot: LiveRiskSnapshot): boolean {
  const claimed = snapshot.snapshotHash.toLowerCase();
  return claimed === liveSnapshotStateHash(snapshot).toLowerCase() ||
    claimed === legacyLiveSnapshotStateHash(snapshot).toLowerCase();
}

export function canonicalEnvelopeState(
  envelope: LiveSnapshotEnvelope,
  options: { includeVolatileAdapterSourceTimestamp?: boolean } = {},
): unknown {
  if (envelope.snapshot) {
    return canonicalLiveSnapshotState(envelope.snapshot, options);
  }

  return normalizeCanonical({
    mode: envelope.mode,
    status: envelope.status,
    partial: {
      chain: envelope.partial.chain ? canonicalChain(envelope.partial.chain) : null,
      account: envelope.partial.account,
      position: envelope.partial.position
        ? canonicalPosition(envelope.partial.position)
        : null,
      liquidity: envelope.partial.liquidity
        ? canonicalLiquidity(envelope.partial.liquidity)
        : null,
      oracle: envelope.partial.oracle ? canonicalOracle(envelope.partial.oracle) : null,
      uniswapPool: envelope.partial.uniswapPool,
      rwa: envelope.partial.rwa ? canonicalRwa(envelope.partial.rwa) : null,
      policy: envelope.partial.policy ? canonicalPolicy(envelope.partial.policy) : null,
      executionPreview: envelope.partial.executionPreview
        ? canonicalExecutionPreview(envelope.partial.executionPreview)
        : null,
    },
    adapters: canonicalAdapters(
      envelope.adapters,
      options.includeVolatileAdapterSourceTimestamp ?? false,
    ),
    reasons: [...envelope.reasons].sort(),
  });
}

export function envelopeStateHash(envelope: LiveSnapshotEnvelope): `0x${string}` {
  return envelope.snapshot
    ? envelope.snapshot.snapshotHash as `0x${string}`
    : objectHash(canonicalEnvelopeState(envelope));
}

export function verifyEnvelopeStateHash(
  envelope: LiveSnapshotEnvelope,
  claimedHash: string,
): boolean {
  if (envelope.snapshot) {
    return claimedHash.toLowerCase() === envelope.snapshot.snapshotHash.toLowerCase() &&
      verifyLiveSnapshotHash(envelope.snapshot);
  }
  const claimed = claimedHash.toLowerCase();
  const current = objectHash(canonicalEnvelopeState(envelope)).toLowerCase();
  const legacy = objectHash(canonicalEnvelopeState(envelope, {
    includeVolatileAdapterSourceTimestamp: true,
  })).toLowerCase();
  return claimed === current || claimed === legacy;
}

export function protocolConfigurationHash(
  envelope: LiveSnapshotEnvelope,
): `0x${string}` {
  const snapshot = envelope.snapshot;
  const oracle = snapshot?.oracle ?? envelope.partial.oracle;
  const pool = snapshot?.uniswap ?? envelope.partial.uniswapPool;
  const configurationAdapter = envelope.adapters.find(
    (adapter) => adapter.adapter === "configuration",
  );
  return objectHash(normalizeCanonical({
    chainId: snapshot?.chain.chainId ?? envelope.partial.chain?.chainId ?? null,
    collateralReserve: snapshot?.aave.collateralReserve ?? null,
    debtReserve: snapshot?.aave.debtReserve ?? null,
    flashLoanPremiumBps: snapshot?.aave.flashLoanPremiumBps ?? null,
    tokens: snapshot?.tokens
      ? {
          xbEth: tokenConfiguration(snapshot.tokens.xbEth),
          xeth: tokenConfiguration(snapshot.tokens.xeth),
        }
      : null,
    oracle: oracle
      ? {
          xbEth: feedConfiguration(oracle.xbEth),
          xeth: feedConfiguration(oracle.xeth),
        }
      : null,
    pool: pool
      ? {
          factory: pool.factory,
          pool: pool.pool,
          token0: pool.token0,
          token1: pool.token1,
          feeTier: pool.feeTier,
          configurationVerified: pool.configurationVerified,
        }
      : null,
    configurationProvenance: configurationAdapter?.provenance.filter(
      (value) => !value.startsWith("block:"),
    ) ?? [],
    adapterVersions: snapshot?.adapterVersions ?? Object.fromEntries(
      envelope.adapters.map((adapter) => [adapter.adapter, adapter.version]),
    ),
  }));
}

function canonicalChain(chain: LiveRiskSnapshot["chain"]) {
  return {
    chainId: chain.chainId,
    blockNumber: chain.blockNumber,
    blockHash: chain.blockHash,
    blockTimestamp: chain.blockTimestamp,
    rpcHealthy: chain.rpcHealthy,
  };
}

function canonicalPosition(position: LiveRiskSnapshot["aave"]["position"]) {
  const { observedAt: _observedAt, ...state } = position;
  return state;
}

function canonicalLiquidity(liquidity: LiveRiskSnapshot["marketContext"]["liquidity"]) {
  const { observedAt: _observedAt, ...state } = liquidity;
  return state;
}

function canonicalOracle(oracle: LiveRiskSnapshot["oracle"]) {
  return {
    xbEth: canonicalFeed(oracle.xbEth),
    xeth: canonicalFeed(oracle.xeth),
    maxAgeSeconds: oracle.maxAgeSeconds,
  };
}

function canonicalFeed(feed: OracleFeedState) {
  return {
    asset: feed.asset,
    oracle: feed.oracle,
    source: feed.source,
    sourceKind: feed.sourceKind,
    priceBase: feed.priceBase,
    decimals: feed.decimals,
    answer: feed.answer,
    updatedAt: feed.updatedAt,
    roundId: feed.roundId,
    sourceDescription: feed.sourceDescription,
    ratio: feed.ratio,
    snapshotRatio: feed.snapshotRatio,
    snapshotTimestamp: feed.snapshotTimestamp,
    fresh: feed.fresh,
    provenance: feed.provenance,
  };
}

function feedConfiguration(feed: OracleFeedState) {
  return {
    asset: feed.asset,
    oracle: feed.oracle,
    source: feed.source,
    sourceKind: feed.sourceKind,
    decimals: feed.decimals,
    sourceDescription: feed.sourceDescription,
  };
}

function tokenConfiguration(token: LiveRiskSnapshot["tokens"]["xbEth"]) {
  return {
    address: token.address,
    symbol: token.symbol,
    name: token.name,
    decimals: token.decimals,
  };
}

function canonicalRwa(rwa: LiveRwaEvidence) {
  return {
    status: rwa.status,
    riskLevel: rwa.riskLevel,
    summary: rwa.summary,
    confidence: rwa.confidence,
    claims: rwa.claims,
    evidenceValid: rwa.evidenceValid,
    reasons: [...rwa.reasons].sort(),
    analyzer: rwa.analyzer,
    sourceStates: rwa.sourceStates.map((source) => ({
      sourceId: source.sourceId,
      sourceUrl: source.sourceUrl,
      revisionId: source.revisionId,
      sourceVersion: source.sourceVersion,
      contentHash: source.contentHash,
      diff: {
        diffId: source.diff.diffId,
        sourceId: source.diff.sourceId,
        fromRevisionId: source.diff.fromRevisionId,
        toRevisionId: source.diff.toRevisionId,
        kind: source.diff.kind,
        cosmeticOnly: source.diff.cosmeticOnly,
        summary: source.diff.summary,
        hunks: source.diff.hunks,
      },
      snapshot: {
        revisionId: source.snapshot.revisionId,
        sourceId: source.snapshot.sourceId,
        sourceUrl: source.snapshot.sourceUrl,
        sourceVersion: source.snapshot.sourceVersion,
        contentHash: source.snapshot.contentHash,
        rawContentHash: source.snapshot.rawContentHash,
        semanticFingerprint: source.snapshot.normalized.semanticFingerprint,
        previousRevisionId: source.snapshot.previousRevisionId,
        diffId: source.snapshot.diffId,
      },
    })),
  };
}

function canonicalPolicy(policy: LivePolicyState) {
  if (!policy.policy) return { status: policy.status, policy: null };
  const previewPolicy = policy.policy.policyId === "policy_live_read_only_preview";
  return {
    status: policy.status,
    policy: {
      ...policy.policy,
      authorizationExpiresAt: previewPolicy
        ? "PREVIEW_RELATIVE_EXPIRY"
        : policy.policy.authorizationExpiresAt,
    },
  };
}

function canonicalExecutionPreview(preview: LiveExecutionPreview) {
  return {
    status: preview.status,
    plan: preview.plan,
    policyEvaluation: {
      allowed: preview.policyEvaluation.allowed,
      autoExecutionEligible: preview.policyEvaluation.autoExecutionEligible,
      requiresUserSignature: preview.policyEvaluation.requiresUserSignature,
      status: preview.policyEvaluation.status,
      reasons: [...preview.policyEvaluation.reasons].sort(),
      checks: preview.policyEvaluation.checks.map((check) => ({
        check: check.check,
        passed: check.passed,
        reason: check.reason,
      })),
      chainId: preview.policyEvaluation.chainId,
      egressContract: preview.policyEvaluation.egressContract,
      authorization: preview.policyEvaluation.authorization
        ? {
            ...preview.policyEvaluation.authorization,
            deadline: "BOUNDED_RELATIVE_DEADLINE",
          }
        : null,
    },
    broadcastPermitted: preview.broadcastPermitted,
    transactionSubmitted: preview.transactionSubmitted,
  };
}

function canonicalAdapters(
  adapters: LiveSnapshotEnvelope["adapters"],
  includeVolatileSourceTimestamp: boolean,
) {
  return [...adapters]
    .map((adapter) => ({
      adapter: adapter.adapter,
      version: adapter.version,
      status: adapter.status,
      freshness: {
        ...(includeVolatileSourceTimestamp
          ? { sourceTimestamp: adapter.freshness.sourceTimestamp }
          : {}),
        blockNumber: adapter.freshness.blockNumber,
        maxAgeSeconds: adapter.freshness.maxAgeSeconds,
        fresh: adapter.freshness.fresh,
      },
      provenance: [...adapter.provenance].sort(),
    }))
    .sort((left, right) => left.adapter.localeCompare(right.adapter));
}

function normalizeCanonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(normalizeCanonical);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .filter(([, child]) => child !== undefined)
        .map(([key, child]) => [key, normalizeCanonical(child)]),
    );
  }
  if (typeof value === "string" && /^0x[0-9a-fA-F]+$/.test(value)) {
    return value.toLowerCase();
  }
  return value;
}
