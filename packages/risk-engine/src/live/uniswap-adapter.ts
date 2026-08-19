import type { Address, PublicClient } from "viem";
import type { MarketContext, UserProtectionPolicy } from "../domain/schemas.js";
import { erc20Abi, uniswapFactoryAbi, uniswapPoolAbi } from "../market/abis.js";
import { XLAYER_MAINNET } from "../market/config.js";
import { XLayerMarketContextProvider } from "../market/xlayer-provider.js";
import {
  availableHealth,
  type AdapterHealth,
  type UniswapLiveState,
  type UniswapPoolLiveState,
  unavailableHealth,
} from "./schemas.js";

export interface UniswapPoolAdapterResult {
  state: UniswapPoolLiveState | null;
  health: AdapterHealth;
}

export interface UniswapAdapterResult {
  state: UniswapLiveState | null;
  market: Pick<MarketContext, "liquidity" | "plan"> | null;
  health: AdapterHealth;
}

export class UniswapReadAdapter {
  private readonly marketProvider: XLayerMarketContextProvider;
  private readonly now: () => Date;

  constructor(
    private readonly client: PublicClient,
    options: { now?: () => Date; marketProvider?: XLayerMarketContextProvider } = {},
  ) {
    this.now = options.now ?? (() => new Date());
    this.marketProvider =
      options.marketProvider ??
      new XLayerMarketContextProvider(XLAYER_MAINNET, { client, now: this.now });
  }

  async readPool(
    blockNumber: bigint,
    blockTimestamp: Date,
  ): Promise<UniswapPoolAdapterResult> {
    const now = this.now();
    try {
      const [
        factoryPool,
        poolFactory,
        token0,
        token1,
        fee,
        slot0,
        activeLiquidity,
        poolTokenInBalance,
        poolTokenOutBalance,
      ] = await Promise.all([
        this.client.readContract({
          address: XLAYER_MAINNET.contracts.uniswapFactory,
          abi: uniswapFactoryAbi,
          functionName: "getPool",
          args: [
            XLAYER_MAINNET.contracts.xbEth,
            XLAYER_MAINNET.contracts.xeth,
            XLAYER_MAINNET.poolFee,
          ],
          blockNumber,
        }),
        this.client.readContract({
          address: XLAYER_MAINNET.contracts.swapPool,
          abi: uniswapPoolAbi,
          functionName: "factory",
          blockNumber,
        }),
        this.client.readContract({
          address: XLAYER_MAINNET.contracts.swapPool,
          abi: uniswapPoolAbi,
          functionName: "token0",
          blockNumber,
        }),
        this.client.readContract({
          address: XLAYER_MAINNET.contracts.swapPool,
          abi: uniswapPoolAbi,
          functionName: "token1",
          blockNumber,
        }),
        this.client.readContract({
          address: XLAYER_MAINNET.contracts.swapPool,
          abi: uniswapPoolAbi,
          functionName: "fee",
          blockNumber,
        }),
        this.client.readContract({
          address: XLAYER_MAINNET.contracts.swapPool,
          abi: uniswapPoolAbi,
          functionName: "slot0",
          blockNumber,
        }),
        this.client.readContract({
          address: XLAYER_MAINNET.contracts.swapPool,
          abi: uniswapPoolAbi,
          functionName: "liquidity",
          blockNumber,
        }),
        this.client.readContract({
          address: XLAYER_MAINNET.contracts.xbEth,
          abi: erc20Abi,
          functionName: "balanceOf",
          args: [XLAYER_MAINNET.contracts.swapPool],
          blockNumber,
        }),
        this.client.readContract({
          address: XLAYER_MAINNET.contracts.xeth,
          abi: erc20Abi,
          functionName: "balanceOf",
          args: [XLAYER_MAINNET.contracts.swapPool],
          blockNumber,
        }),
      ]);

      const [sqrtPriceX96, tick, , , , , unlocked] = slot0;
      const configurationVerified =
        addressesEqual(factoryPool, XLAYER_MAINNET.contracts.swapPool) &&
        addressesEqual(poolFactory, XLAYER_MAINNET.contracts.uniswapFactory) &&
        addressesEqual(token0, XLAYER_MAINNET.contracts.xbEth) &&
        addressesEqual(token1, XLAYER_MAINNET.contracts.xeth) &&
        Number(fee) === XLAYER_MAINNET.poolFee;
      if (!configurationVerified) {
        return {
          state: null,
          health: unavailableHealth(
            "uniswap-pool",
            "Factory, pool, token order, or fee tier does not match verified configuration.",
            now,
            { blockNumber, maxAgeSeconds: 120, status: "INVALID_CONFIGURATION" },
          ),
        };
      }

      return {
        state: {
          factory: XLAYER_MAINNET.contracts.uniswapFactory,
          pool: XLAYER_MAINNET.contracts.swapPool,
          token0,
          token1,
          feeTier: Number(fee),
          sqrtPriceX96: sqrtPriceX96.toString(),
          tick: tick.toString(),
          activeLiquidity: activeLiquidity.toString(),
          poolTokenInBalanceWei: poolTokenInBalance.toString(),
          poolTokenOutBalanceWei: poolTokenOutBalance.toString(),
          unlocked,
          configurationVerified,
        },
        health: availableHealth({
          adapter: "uniswap-pool",
          message: "Uniswap V3 pool configuration and current liquidity were read.",
          now,
          blockNumber,
          sourceTimestamp: blockTimestamp,
          maxAgeSeconds: 120,
          provenance: [
            XLAYER_MAINNET.contracts.uniswapFactory,
            XLAYER_MAINNET.contracts.swapPool,
            `block:${blockNumber.toString()}`,
          ],
        }),
      };
    } catch (error) {
      return {
        state: null,
        health: unavailableHealth("uniswap-pool", errorMessage(error), now, {
          blockNumber,
          maxAgeSeconds: 120,
        }),
      };
    }
  }

  async read(
    position: MarketContext["position"],
    policy: UserProtectionPolicy,
    blockNumber: bigint,
    blockTimestamp: Date,
    poolResult?: UniswapPoolAdapterResult,
  ): Promise<UniswapAdapterResult> {
    const now = this.now();
    const pool = poolResult ?? (await this.readPool(blockNumber, blockTimestamp));
    if (!pool.state) return { state: null, market: null, health: pool.health };

    try {
      const { liquidity, plan } = await this.marketProvider.getLiquidityAndPlanAtBlock(
        position,
        policy,
        blockNumber,
      );
      return {
        market: { liquidity, plan },
        state: { ...pool.state, quote: liquidity },
        health: availableHealth({
          adapter: "uniswap",
          message: "A deterministic xBETH/xETH quote was reproduced at the snapshot block.",
          now,
          blockNumber,
          sourceTimestamp: blockTimestamp,
          maxAgeSeconds: 120,
          provenance: [
            XLAYER_MAINNET.contracts.swapPool,
            XLAYER_MAINNET.contracts.quoterV2,
            `block:${blockNumber.toString()}`,
          ],
        }),
      };
    } catch (error) {
      return {
        state: null,
        market: null,
        health: unavailableHealth("uniswap", errorMessage(error), now, {
          blockNumber,
          maxAgeSeconds: 120,
        }),
      };
    }
  }
}

function addressesEqual(left: Address, right: Address): boolean {
  return left.toLowerCase() === right.toLowerCase();
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message.split("\n")[0] ?? error.name : String(error);
}
