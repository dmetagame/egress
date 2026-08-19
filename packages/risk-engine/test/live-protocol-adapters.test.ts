import { describe, expect, it } from "vitest";
import type { Address, PublicClient } from "viem";
import { AaveReadAdapter } from "../src/live/aave-adapter.js";
import { ProtocolConfigurationReadAdapter } from "../src/live/configuration-adapter.js";
import { OracleReadAdapter } from "../src/live/oracle-adapter.js";
import { OkxRwaReadAdapter } from "../src/live/rwa-adapter.js";
import { UniswapReadAdapter } from "../src/live/uniswap-adapter.js";
import { availableHealth, type UniswapPoolLiveState } from "../src/live/schemas.js";
import { XLAYER_MAINNET } from "../src/market/config.js";
import { XLayerMarketContextProvider } from "../src/market/xlayer-provider.js";
import { REPLAY_REVISIONS, replayMarketContext, replayPolicy } from "../src/replay/fixtures.js";
import { AUTHORITATIVE_OKX_SOURCES } from "../src/sources/registry.js";
import { InMemorySourceFetcher } from "../src/sources/fetcher.js";
import { InMemoryStore } from "../src/sources/store.js";

const NOW = new Date("2026-08-15T10:00:00.000Z");
const BLOCK = 67_981_000n;
const USER = "0x1111111111111111111111111111111111111111" as const;
const PRICE = 300_000_000_000n;
const XBETH_SOURCE = XLAYER_MAINNET.contracts.xbEthOracleSource;
const XETH_SOURCE = XLAYER_MAINNET.contracts.xethOracleSource;
const BASE_SOURCE = XETH_SOURCE;

describe("live protocol adapters", () => {
  it("reads Aave position, reserve configuration, and flash-loan premium at one block", async () => {
    const position = supportedPosition();
    const collateralConfiguration = reserveWord({
      ltvBps: 8_800,
      liquidationThresholdBps: 9_000,
      liquidationBonusBps: 10_500,
      decimals: 18,
      active: true,
      borrowingEnabled: false,
    });
    const debtConfiguration = reserveWord({
      ltvBps: 0,
      liquidationThresholdBps: 0,
      liquidationBonusBps: 0,
      decimals: 18,
      active: true,
      borrowingEnabled: true,
    });
    const client = {
      readContract: async (request: { functionName: string; args?: readonly unknown[] }) => {
        if (request.functionName === "getConfiguration") {
          return request.args?.[0] === XLAYER_MAINNET.contracts.xbEth
            ? collateralConfiguration
            : debtConfiguration;
        }
        if (request.functionName === "FLASHLOAN_PREMIUM_TOTAL") return 5n;
        throw new Error(`Unexpected Aave read ${request.functionName}`);
      },
    } as unknown as PublicClient;
    const adapter = new AaveReadAdapter(client, {
      now: () => NOW,
      marketProvider: {
        getPositionAtBlock: async () => position,
      } as never,
    });

    const result = await adapter.read(USER, BLOCK, NOW);
    expect(result.health.status).toBe("AVAILABLE");
    expect(result.state?.position).toEqual(position);
    expect(result.state?.collateralReserve).toMatchObject({
      ltvBps: 8_800,
      liquidationThresholdBps: 9_000,
      liquidationBonusBps: 10_500,
      decimals: 18,
      active: true,
      borrowingEnabled: false,
    });
    expect(result.state?.debtReserve.borrowingEnabled).toBe(true);
    expect(result.state?.flashLoanPremiumBps).toBe(5);
  });

  it("retrieves oracle provenance and marks each stale feed stale", async () => {
    const freshTimestamp = BigInt(Math.floor(NOW.getTime() / 1_000) - 10);
    const fresh = await new OracleReadAdapter(oracleClient(freshTimestamp), {
      now: () => NOW,
      maxAgeSeconds: 60,
    }).read(BLOCK, NOW);
    expect(fresh.health.status).toBe("AVAILABLE");
    expect(fresh.state?.xbEth.sourceKind).toBe("CAPPED_RATIO");
    expect(fresh.state?.xbEth.fresh).toBe(true);
    expect(fresh.state?.xeth.fresh).toBe(true);
    expect(fresh.state?.xbEth.provenance).toContain(XBETH_SOURCE);

    const staleTimestamp = BigInt(Math.floor(NOW.getTime() / 1_000) - 61);
    const stale = await new OracleReadAdapter(oracleClient(staleTimestamp), {
      now: () => NOW,
      maxAgeSeconds: 60,
    }).read(BLOCK, NOW);
    expect(stale.health.status).toBe("STALE");
    expect(stale.health.freshness.fresh).toBe(false);
    expect(stale.state?.xbEth.fresh).toBe(false);
    expect(stale.state?.xeth.fresh).toBe(false);
  });

  it("rejects a wrong or missing Aave asset oracle source", async () => {
    const updatedAt = BigInt(Math.floor(NOW.getTime() / 1_000) - 10);
    const wrong = await new OracleReadAdapter(oracleClient(updatedAt, {
      xethSource: "0x9999999999999999999999999999999999999999",
    }), { now: () => NOW }).read(BLOCK, NOW);
    expect(wrong.state).toBeNull();
    expect(wrong.health.status).toBe("UNAVAILABLE");
    expect(wrong.health.message).toMatch(/xETH oracle source/i);

    const missing = await new OracleReadAdapter(oracleClient(updatedAt, {
      xbEthSource: "0x0000000000000000000000000000000000000000",
    }), { now: () => NOW }).read(BLOCK, NOW);
    expect(missing.state).toBeNull();
    expect(missing.health.status).toBe("UNAVAILABLE");
    expect(missing.health.message).toMatch(/xBETH oracle source/i);
  });

  it("rejects an oracle timestamp later than the snapshot block", async () => {
    const updatedAt = BigInt(Math.floor(NOW.getTime() / 1_000) + 6);
    const result = await new OracleReadAdapter(oracleClient(updatedAt), {
      now: () => new Date(NOW.getTime() + 30_000),
    }).read(BLOCK, NOW);
    expect(result.state).toBeNull();
    expect(result.health.status).toBe("UNAVAILABLE");
    expect(result.health.message).toMatch(/later than the snapshot block/i);
  });

  it("fails closed when the configured oracle cannot be read", async () => {
    const client = {
      readContract: async () => {
        throw new Error("oracle unavailable");
      },
    } as unknown as PublicClient;
    const result = await new OracleReadAdapter(client, { now: () => NOW }).read(BLOCK, NOW);
    expect(result.state).toBeNull();
    expect(result.health.status).toBe("UNAVAILABLE");
    expect(result.health.message).toContain("oracle unavailable");
  });

  it("verifies the configured Uniswap pool and rejects a token-order mismatch", async () => {
    const valid = await new UniswapReadAdapter(uniswapPoolClient(), { now: () => NOW })
      .readPool(BLOCK, NOW);
    expect(valid.health.status).toBe("AVAILABLE");
    expect(valid.state).toMatchObject({
      pool: XLAYER_MAINNET.contracts.swapPool,
      feeTier: XLAYER_MAINNET.poolFee,
      configurationVerified: true,
      unlocked: true,
    });

    const invalid = await new UniswapReadAdapter(
      uniswapPoolClient({ token0: XLAYER_MAINNET.contracts.xeth }),
      { now: () => NOW },
    ).readPool(BLOCK, NOW);
    expect(invalid.state).toBeNull();
    expect(invalid.health.status).toBe("INVALID_CONFIGURATION");
  });

  it("reproduces an executable quote and calculates slippage deterministically", async () => {
    const position = supportedPosition();
    const policy = {
      ...replayPolicy(NOW),
      minimumPostHealthFactorWad: "1030000000000000000",
      targetPostHealthFactorWad: "1040000000000000000",
      maximumRepaymentWei: "20000000000000000000",
      maximumCollateralWei: "20000000000000000000",
      maximumCollateralPercentageBps: 4_000,
    };
    const client = quoteClient();
    const provider = new XLayerMarketContextProvider(XLAYER_MAINNET, {
      client,
      now: () => NOW,
      plannerIterations: 80,
    });
    const adapter = new UniswapReadAdapter(client, {
      now: () => NOW,
      marketProvider: provider,
    });
    const result = await adapter.read(
      position,
      policy,
      BLOCK,
      NOW,
      { state: poolState(), health: adapterHealth("uniswap-pool") },
    );

    expect(result.health.status).toBe("AVAILABLE");
    expect(result.market?.plan.executable).toBe(true);
    expect(result.market?.liquidity.executable).toBe(true);
    expect(result.market?.liquidity.estimatedSlippageBps).toBe(50);
    expect(result.market?.liquidity.priceImpactBps).toBe(50);
    expect(result.market?.liquidity.oraclePoolDeviationBps).toBe(0);
    expect(BigInt(result.market!.plan.minimumSwapOutWei)).toBe(
      (BigInt(result.market!.plan.expectedSwapOutWei) * 9_900n) / 10_000n,
    );
    expect(BigInt(result.market!.plan.projectedPostHealthFactorWad)).toBeGreaterThanOrEqual(
      BigInt(policy.targetPostHealthFactorWad),
    );
  });

  it("fails protocol verification when the address provider resolves a different pool", async () => {
    const wrongPool = "0x9999999999999999999999999999999999999999" as Address;
    const client = {
      readContract: async (request: { address: Address; functionName: string }) => {
        if (request.functionName === "getPool") {
          return request.address === XLAYER_MAINNET.contracts.addressesProvider
            ? wrongPool
            : XLAYER_MAINNET.contracts.swapPool;
        }
        if (request.functionName === "getPriceOracle") return XLAYER_MAINNET.contracts.aaveOracle;
        if (request.functionName === "decimals") return 18;
        throw new Error(`Unexpected configuration read ${request.functionName}`);
      },
      getBytecode: async () => "0x6000",
    } as unknown as PublicClient;
    const result = await new ProtocolConfigurationReadAdapter(client, { now: () => NOW })
      .read(BLOCK);
    expect(result.verified).toBe(false);
    expect(result.health.status).toBe("INVALID_CONFIGURATION");
    expect(result.reasons).toContain(
      "PoolAddressesProvider.getPool() does not match configured Aave Pool.",
    );
  });
});

describe("live OKX evidence adapter", () => {
  it("parses evidence and creates a new semantic revision only when content changes", async () => {
    const store = new InMemoryStore();
    const fixtures = sourceFixtures(NOW.toISOString());
    const fetcher = new InMemorySourceFetcher(fixtures);
    const adapter = new OkxRwaReadAdapter(store, {
      fetcher: fetcher as never,
      now: () => NOW,
      sources: AUTHORITATIVE_OKX_SOURCES,
      riskEventId: "risk_live_fixture",
    });

    const baseline = await adapter.read();
    expect(baseline.health.status).toBe("AVAILABLE");
    expect(baseline.evidence.status).toBe("AVAILABLE");
    expect(baseline.evidence.riskLevel).toBe("NORMAL");
    expect(baseline.evidence.sourceStates).toHaveLength(2);
    expect(baseline.verdict?.riskEventId).toBe("risk_live_fixture");

    fixtures.set("okx-x-rwa-deposit-withdrawal", {
      rawContent: REPLAY_REVISIONS.B,
      retrievedAt: NOW.toISOString(),
    });
    const changed = await adapter.read();
    const primary = changed.evidence.sourceStates.find(
      (source) => source.sourceId === "okx-x-rwa-deposit-withdrawal",
    );
    expect(changed.evidence.status).toBe("AVAILABLE");
    expect(changed.evidence.riskLevel).toBe("MEDIUM");
    expect(primary?.changed).toBe(true);
    expect(primary?.sourceVersion).toBe(2);
    expect(primary?.diff.cosmeticOnly).toBe(false);
  });

  it("emits no risk level when the oldest authoritative source is stale", async () => {
    const staleTime = new Date(NOW.getTime() - 3_601_000).toISOString();
    const adapter = new OkxRwaReadAdapter(new InMemoryStore(), {
      fetcher: new InMemorySourceFetcher(sourceFixtures(staleTime)) as never,
      now: () => NOW,
      maxAgeSeconds: 3_600,
      sources: AUTHORITATIVE_OKX_SOURCES,
    });
    const result = await adapter.read();
    expect(result.verdict).toBeNull();
    expect(result.evidence.status).toBe("LIVE_DATA_UNAVAILABLE");
    expect(result.evidence.riskLevel).toBeNull();
    expect(result.health.status).toBe("STALE");
  });
});

function supportedPosition() {
  const position = replayMarketContext(NOW).position;
  return {
    ...position,
    blockNumber: BLOCK.toString(),
    observedAt: NOW.toISOString(),
    totalCollateralBase: "15000000000000",
    totalDebtBase: "13215000000000",
    healthFactorWad: "1021566401816118047",
  };
}

function reserveWord(input: {
  ltvBps: number;
  liquidationThresholdBps: number;
  liquidationBonusBps: number;
  decimals: number;
  active: boolean;
  borrowingEnabled: boolean;
}): bigint {
  return BigInt(input.ltvBps) |
    (BigInt(input.liquidationThresholdBps) << 16n) |
    (BigInt(input.liquidationBonusBps) << 32n) |
    (BigInt(input.decimals) << 48n) |
    (BigInt(input.active ? 1 : 0) << 56n) |
    (BigInt(input.borrowingEnabled ? 1 : 0) << 58n);
}

function oracleClient(
  updatedAt: bigint,
  overrides: { xbEthSource?: Address; xethSource?: Address } = {},
): PublicClient {
  const xbEthSource = overrides.xbEthSource ?? XBETH_SOURCE;
  const xethSource = overrides.xethSource ?? XETH_SOURCE;
  return {
    readContract: async (request: {
      address: Address;
      functionName: string;
      args?: readonly unknown[];
    }) => {
      if (request.functionName === "getAssetPrice") return PRICE;
      if (request.functionName === "getSourceOfAsset") {
        return request.args?.[0] === XLAYER_MAINNET.contracts.xbEth
          ? xbEthSource
          : xethSource;
      }
      if (request.functionName === "BASE_TO_USD_AGGREGATOR") return BASE_SOURCE;
      if (request.functionName === "RATIO_PROVIDER") return XLAYER_MAINNET.contracts.xbEth;
      if (request.functionName === "getRatio" || request.functionName === "getSnapshotRatio") {
        return 1_000_000_000_000_000_000n;
      }
      if (request.functionName === "getSnapshotTimestamp") return updatedAt;
      if (request.functionName === "latestRoundData") {
        return [1n, PRICE, updatedAt, updatedAt, 1n] as const;
      }
      if (request.functionName === "decimals") return 8;
      if (request.functionName === "description") return "ETH / USD";
      throw new Error(`Unexpected oracle read ${request.functionName}`);
    },
  } as unknown as PublicClient;
}

function uniswapPoolClient(overrides: { token0?: Address } = {}): PublicClient {
  return {
    readContract: async (request: { address: Address; functionName: string }) => {
      if (request.functionName === "getPool") return XLAYER_MAINNET.contracts.swapPool;
      if (request.functionName === "factory") return XLAYER_MAINNET.contracts.uniswapFactory;
      if (request.functionName === "token0") return overrides.token0 ?? XLAYER_MAINNET.contracts.xbEth;
      if (request.functionName === "token1") return XLAYER_MAINNET.contracts.xeth;
      if (request.functionName === "fee") return XLAYER_MAINNET.poolFee;
      if (request.functionName === "slot0") {
        return [2n ** 96n, 0, 0, 0, 0, 0, true] as const;
      }
      if (request.functionName === "liquidity") return 100_000n * 10n ** 18n;
      if (request.functionName === "balanceOf") {
        return request.address === XLAYER_MAINNET.contracts.xbEth
          ? 500n * 10n ** 18n
          : 510n * 10n ** 18n;
      }
      throw new Error(`Unexpected Uniswap read ${request.functionName}`);
    },
  } as unknown as PublicClient;
}

function quoteClient(): PublicClient {
  return {
    readContract: async (request: { address: Address; functionName: string }) => {
      if (request.functionName === "slot0") {
        return [2n ** 96n, 0, 0, 0, 0, 0, true] as const;
      }
      if (request.functionName === "liquidity") return 100_000n * 10n ** 18n;
      if (request.functionName === "balanceOf") {
        return request.address === XLAYER_MAINNET.contracts.xbEth
          ? 500n * 10n ** 18n
          : 510n * 10n ** 18n;
      }
      throw new Error(`Unexpected quote read ${request.functionName}`);
    },
    simulateContract: async (request: { args: readonly [{ amountIn: bigint }] }) => {
      const amountIn = request.args[0].amountIn;
      return {
        result: [amountIn * 9_950n / 10_000n, 2n ** 96n, 0, 150_000n] as const,
        request,
      };
    },
    getGasPrice: async () => 100_000_000n,
  } as unknown as PublicClient;
}

function poolState(): UniswapPoolLiveState {
  return {
    factory: XLAYER_MAINNET.contracts.uniswapFactory,
    pool: XLAYER_MAINNET.contracts.swapPool,
    token0: XLAYER_MAINNET.contracts.xbEth,
    token1: XLAYER_MAINNET.contracts.xeth,
    feeTier: XLAYER_MAINNET.poolFee,
    sqrtPriceX96: (2n ** 96n).toString(),
    tick: "0",
    activeLiquidity: (100_000n * 10n ** 18n).toString(),
    poolTokenInBalanceWei: (500n * 10n ** 18n).toString(),
    poolTokenOutBalanceWei: (510n * 10n ** 18n).toString(),
    unlocked: true,
    configurationVerified: true,
  };
}

function adapterHealth(adapter: string) {
  return availableHealth({
    adapter,
    message: `${adapter} available`,
    now: NOW,
    blockNumber: BLOCK,
    sourceTimestamp: NOW,
    maxAgeSeconds: 120,
    provenance: [adapter],
  });
}

function sourceFixtures(retrievedAt: string) {
  return new Map<string, { rawContent: string; retrievedAt?: string }>([
    [
      "okx-x-rwa-overview",
      {
        rawContent: "<html><body><article><h1>X-RWA</h1><p>Each X-RWA, including xBETH, is fully backed by the corresponding underlying asset held in OKX custody.</p></article></body></html>",
        retrievedAt,
      },
    ],
    [
      "okx-x-rwa-deposit-withdrawal",
      { rawContent: REPLAY_REVISIONS.A, retrievedAt },
    ],
  ]);
}
