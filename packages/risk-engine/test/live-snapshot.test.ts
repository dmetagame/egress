import { describe, expect, it } from "vitest";
import type { Address, PublicClient } from "viem";
import { riskVerdictSchema, type PositionState } from "../src/domain/schemas.js";
import { replayMarketContext, replayPolicy } from "../src/replay/fixtures.js";
import {
  LiveRiskSnapshotService,
  type LiveSnapshotServiceOptions,
} from "../src/live/snapshot.js";
import type { RwaAdapterResult } from "../src/live/rwa-adapter.js";
import {
  unavailableHealth,
  type AdapterHealth,
  type LiveRwaEvidence,
  type UniswapPoolLiveState,
} from "../src/live/schemas.js";
import { liveSnapshotStateHash } from "../src/live/canonical.js";

const NOW = new Date("2026-08-15T10:00:00.000Z");
const BLOCK = 67_981_000n;
const BLOCK_HASH = `0x${"ab".repeat(32)}` as const;
const USER = "0x1111111111111111111111111111111111111111" as const;

function health(adapter: string): AdapterHealth {
  return {
    adapter,
    version: "1",
    status: "AVAILABLE",
    message: `${adapter} available`,
    freshness: {
      observedAt: NOW.toISOString(),
      sourceTimestamp: NOW.toISOString(),
      blockNumber: BLOCK.toString(),
      ageSeconds: 0,
      maxAgeSeconds: 120,
      fresh: true,
    },
    provenance: [adapter],
  };
}

const poolState: UniswapPoolLiveState = {
  factory: "0x4B2ab38DBF28D31D467aA8993f6c2585981D6804",
  pool: "0x84d4DbEebFf5F77c63F36bD0dCb18121Aa9aC8fc",
  token0: "0xAFeab3B85B6A56cF5F02317F0f7A23340eb983D7",
  token1: "0xE7B000003A45145decf8a28FC755aD5eC5EA025A",
  feeTier: 100,
  sqrtPriceX96: "79228162514264337593543950336",
  tick: "0",
  activeLiquidity: "100000000000000000000000",
  poolTokenInBalanceWei: "500000000000000000000",
  poolTokenOutBalanceWei: "500000000000000000000",
  unlocked: true,
  configurationVerified: true,
};

function harnessOptions(
  account: Address | null = USER,
  positionOverrides: Partial<PositionState> = {},
): LiveSnapshotServiceOptions {
  const market = replayMarketContext(NOW);
  market.position.blockNumber = BLOCK.toString();
  market.position.observedAt = NOW.toISOString();
  Object.assign(market.position, positionOverrides);
  market.liquidity.blockNumber = BLOCK.toString();
  market.liquidity.observedAt = NOW.toISOString();
  const policy = replayPolicy(NOW);
  const verdict = riskVerdictSchema.parse({
    riskEventId: "risk_live_normal",
    verdictId: "verdict_live_normal",
    issuedAt: NOW.toISOString(),
    expiresAt: new Date(NOW.getTime() + 300_000).toISOString(),
    riskLevel: "NORMAL",
    material: false,
    trigger: "NO_MATERIAL_CHANGE",
    summary: "No material source change was detected.",
    rationale: "Current authoritative evidence does not establish deterioration.",
    claims: [],
    confidence: 0.9,
    evidenceValidation: {
      valid: true,
      validatedEvidenceIds: [],
      rejectedEvidenceIds: [],
      errors: [],
      warnings: [],
    },
    sourceRevisionIds: ["rev_live"],
    diffIds: ["diff_live"],
    analyzer: {
      analyzer: "DETERMINISTIC_FILTER",
      provider: "egress",
      model: "fixture",
      modelVersion: "1",
      promptVersion: "1",
      analyzedAt: NOW.toISOString(),
    },
  });
  const evidence: LiveRwaEvidence = {
    status: "AVAILABLE",
    riskLevel: "NORMAL",
    verdictId: verdict.verdictId,
    summary: verdict.summary,
    confidence: verdict.confidence,
    claims: [],
    evidenceValid: true,
    latestRetrievedAt: NOW.toISOString(),
    sourceStates: [],
    reasons: [],
    analyzer: "DETERMINISTIC_FILTER",
  };
  const client = {
    getChainId: async () => 196,
    getBlock: async () => ({
      number: BLOCK,
      hash: BLOCK_HASH,
      timestamp: BigInt(Math.floor(NOW.getTime() / 1_000)),
    }),
  } as unknown as PublicClient;

  return {
    account,
    policy,
    client,
    now: () => NOW,
    observationBlockNumber: BLOCK,
    observationBlockHash: BLOCK_HASH,
    configurationAdapter: {
      read: async () => ({ verified: true, reasons: [], health: health("configuration") }),
    } as never,
    oracleAdapter: {
      read: async () => ({
        health: health("oracle"),
        state: {
          xbEth: feed(market.position.collateralToken, market.position.xbEthPriceBase),
          xeth: feed(market.position.debtToken, market.position.xethPriceBase),
          maxAgeSeconds: 21_600,
        },
      }),
    } as never,
    uniswapAdapter: {
      readPool: async () => ({ state: poolState, health: health("uniswap-pool") }),
      read: async () => ({
        state: { ...poolState, quote: market.liquidity },
        market: { liquidity: market.liquidity, plan: market.plan },
        health: health("uniswap"),
      }),
    } as never,
    aaveAdapter: {
      read: async () => ({
        health: health("aave"),
        state: {
          position: market.position,
          collateralReserve: reserve(market.position.collateralToken),
          debtReserve: reserve(market.position.debtToken),
          flashLoanPremiumBps: 5,
          addressesProviderVerified: false,
          oracleAddressVerified: false,
        },
      }),
      withConfigurationVerification: (state: object, verification: object) => ({ ...state, ...verification }),
    } as never,
    tokenAdapter: {
      read: async () => ({
        health: health("xbeth"),
        xbEth: token(market.position.collateralToken, "xBETH", "1"),
        xeth: token(market.position.debtToken, "xETH", null),
      }),
    } as never,
    rwaAdapter: { read: async (): Promise<RwaAdapterResult> => ({ verdict, evidence, health: health("rwa") }) } as never,
  };
}

function harness(account: Address | null = USER) {
  return new LiveRiskSnapshotService(harnessOptions(account));
}

describe("canonical live snapshot", () => {
  it("is deterministic, auditable, and permanently preview-only", async () => {
    const first = await harness().read();
    const second = await harness().read();
    expect(first.status).toBe("AVAILABLE");
    expect(first.snapshot?.snapshotHash).toBe(second.snapshot?.snapshotHash);
    expect(first.snapshot?.executionPreview.broadcastPermitted).toBe(false);
    expect(first.snapshot?.executionPreview.transactionSubmitted).toBe(false);
    expect(first.snapshot?.mode).toBe("LIVE_READ_ONLY");
    expect(first.snapshot?.snapshotHash).toBe(liveSnapshotStateHash(first.snapshot!));
  });

  it("fails closed when the account is missing while preserving public market evidence", async () => {
    const result = await harness(null).read();
    expect(result.status).toBe("LIVE_DATA_UNAVAILABLE");
    expect(result.partial.chain?.chainId).toBe(196);
    expect(result.partial.oracle).not.toBeNull();
    expect(result.partial.uniswapPool?.configurationVerified).toBe(true);
    expect(result.partial.rwa?.status).toBe("AVAILABLE");
    expect(result.partial.position).toBeNull();
    expect(result.partial.executionPreview).toBeNull();
  });

  it("rejects a malformed observation account before producing a position preview", async () => {
    const result = await new LiveRiskSnapshotService(
      harnessOptions("not-an-address" as Address),
    ).read();
    expect(result.status).toBe("LIVE_DATA_UNAVAILABLE");
    expect(result.snapshot).toBeNull();
    expect(result.partial.position).toBeNull();
    expect(result.partial.executionPreview).toBeNull();
    expect(result.reasons).toContain("EGRESS_LIVE_ACCOUNT is not a valid EVM address.");
  });

  it("rejects an account with no supported xBETH collateral or xETH debt", async () => {
    const result = await new LiveRiskSnapshotService(harnessOptions(USER, {
      collateralBalanceWei: "0",
      debtBalanceWei: "0",
      totalCollateralBase: "0",
      totalDebtBase: "0",
    })).read();
    expect(result.status).toBe("LIVE_DATA_UNAVAILABLE");
    expect(result.snapshot).toBeNull();
    expect(result.partial.executionPreview).toBeNull();
    expect(result.reasons).toContain(
      "Configured account does not contain a supported xBETH collateral and xETH debt position.",
    );
  });

  it("rejects a position with additional Aave exposure", async () => {
    const result = await new LiveRiskSnapshotService(harnessOptions(USER, {
      singleMarketPosition: false,
      positionScopeReason: "Unsupported additional exposure detected.",
    })).read();
    expect(result.status).toBe("LIVE_DATA_UNAVAILABLE");
    expect(result.snapshot).toBeNull();
    expect(result.partial.executionPreview).toBeNull();
    expect(result.reasons).toContain(
      "Configured account has additional Aave exposure outside the supported xBETH/xETH market.",
    );
  });

  it("reports stale prerequisite data alongside a missing observation account", async () => {
    const options = harnessOptions(null);
    options.oracleAdapter = {
      read: async () => ({
        health: unavailableHealth("oracle", "Oracle data is stale.", NOW, {
          blockNumber: BLOCK,
          maxAgeSeconds: 21_600,
          status: "STALE",
        }),
        state: null,
      }),
    } as never;

    const result = await new LiveRiskSnapshotService(options).read();
    expect(result.status).toBe("LIVE_DATA_UNAVAILABLE");
    expect(result.reasons).toContain("Oracle data is stale.");
    expect(result.reasons).toContain(
      "LIVE_DATA_UNAVAILABLE: configure EGRESS_LIVE_ACCOUNT to read a supported Aave position.",
    );
  });

  it("fails closed when required Aave position data is unavailable", async () => {
    const result = await new LiveRiskSnapshotService({
      ...harnessOptions(),
      aaveAdapter: {
        read: async () => ({
          state: null,
          health: unavailableHealth("aave", "Aave read failed", NOW, {
            blockNumber: BLOCK,
            maxAgeSeconds: 120,
          }),
        }),
      } as never,
    }).read();
    expect(result.status).toBe("LIVE_DATA_UNAVAILABLE");
    expect(result.snapshot).toBeNull();
    expect(result.partial.position).toBeNull();
    expect(result.partial.executionPreview).toBeNull();
    expect(result.adapters.find((adapter) => adapter.adapter === "aave")?.status)
      .toBe("UNAVAILABLE");
  });

  it("rejects an invalid protocol address book before producing a preview", async () => {
    const result = await new LiveRiskSnapshotService({
      ...harnessOptions(),
      configurationAdapter: {
        read: async () => ({
          verified: false,
          reasons: ["Configured Aave Pool does not match the provider."],
          health: unavailableHealth(
            "configuration",
            "Configured Aave Pool does not match the provider.",
            NOW,
            { blockNumber: BLOCK, maxAgeSeconds: 120, status: "INVALID_CONFIGURATION" },
          ),
        }),
      } as never,
    }).read();
    expect(result.status).toBe("LIVE_DATA_UNAVAILABLE");
    expect(result.snapshot).toBeNull();
    expect(result.partial.executionPreview).toBeNull();
    expect(result.reasons).toContain("Configured Aave Pool does not match the provider.");
  });
});

function feed(asset: string, priceBase: string) {
  return {
    asset,
    oracle: "0x91FC11136d5615575a0fC5981Ab5C0C54418E2C6",
    source: "0x3333333333333333333333333333333333333333",
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
    provenance: ["fixture"],
  };
}

function reserve(asset: string) {
  return {
    asset,
    rawData: "0",
    ltvBps: 8800,
    liquidationThresholdBps: 9000,
    liquidationBonusBps: 10500,
    decimals: 18,
    active: true,
    frozen: false,
    borrowingEnabled: true,
    paused: false,
  };
}

function token(address: string, symbol: string, allowance: string | null) {
  return {
    address,
    symbol,
    name: symbol,
    decimals: 18,
    walletBalanceWei: "0",
    aTokenAllowanceWei: allowance,
  };
}
