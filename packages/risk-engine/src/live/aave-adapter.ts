import type { Address, PublicClient } from "viem";
import type { MarketContext, PositionState } from "../domain/schemas.js";
import { aavePoolAbi, erc20Abi } from "../market/abis.js";
import { XLAYER_MAINNET } from "../market/config.js";
import { XLayerMarketContextProvider } from "../market/xlayer-provider.js";
import {
  availableHealth,
  type AaveLiveState,
  type AdapterHealth,
  type ReserveConfiguration,
  unavailableHealth,
} from "./schemas.js";

export interface AaveAdapterResult {
  state: AaveLiveState | null;
  health: AdapterHealth;
}

export class AaveReadAdapter {
  private readonly marketProvider: XLayerMarketContextProvider;
  private readonly now: () => Date;

  constructor(
    private readonly client: PublicClient,
    options: { now?: () => Date; marketProvider?: XLayerMarketContextProvider } = {},
  ) {
    this.now = options.now ?? (() => new Date());
    this.marketProvider =
      options.marketProvider ??
      new XLayerMarketContextProvider(XLAYER_MAINNET, {
        client,
        now: this.now,
      });
  }

  async read(user: Address, blockNumber: bigint, blockTimestamp: Date): Promise<AaveAdapterResult> {
    const now = this.now();
    try {
      const [position, collateralRaw, debtRaw, premiumRaw] = await Promise.all([
        this.marketProvider.getPositionAtBlock(user, blockNumber),
        this.client.readContract({
          address: XLAYER_MAINNET.contracts.aavePool,
          abi: aavePoolAbi,
          functionName: "getConfiguration",
          args: [XLAYER_MAINNET.contracts.xbEth],
          blockNumber,
        }),
        this.client.readContract({
          address: XLAYER_MAINNET.contracts.aavePool,
          abi: aavePoolAbi,
          functionName: "getConfiguration",
          args: [XLAYER_MAINNET.contracts.xeth],
          blockNumber,
        }),
        this.client.readContract({
          address: XLAYER_MAINNET.contracts.aavePool,
          abi: aavePoolAbi,
          functionName: "FLASHLOAN_PREMIUM_TOTAL",
          blockNumber,
        }),
      ]);

      const collateralReserve = decodeReserveConfiguration(
        XLAYER_MAINNET.contracts.xbEth,
        collateralRaw,
      );
      const debtReserve = decodeReserveConfiguration(XLAYER_MAINNET.contracts.xeth, debtRaw);
      const health = availableHealth({
        adapter: "aave",
        message: "Aave position and reserve configuration were read at one block.",
        now,
        blockNumber,
        sourceTimestamp: blockTimestamp,
        maxAgeSeconds: 120,
        provenance: [
          XLAYER_MAINNET.contracts.aavePool,
          `position:${user}`,
          `block:${blockNumber.toString()}`,
        ],
      });
      const state: AaveLiveState = {
        position,
        collateralReserve,
        debtReserve,
        flashLoanPremiumBps: Number(premiumRaw),
        addressesProviderVerified: false,
        oracleAddressVerified: false,
      };
      return { state, health };
    } catch (error) {
      return {
        state: null,
        health: unavailableHealth("aave", errorMessage(error), now, {
          blockNumber,
          maxAgeSeconds: 120,
        }),
      };
    }
  }

  /** Used by the snapshot builder after address-book validation. */
  withConfigurationVerification(
    state: AaveLiveState,
    verification: { addressesProviderVerified: boolean; oracleAddressVerified: boolean },
  ): AaveLiveState {
    return { ...state, ...verification };
  }

  async readTokenBalances(user: Address, blockNumber: bigint): Promise<{
    xbEthBalanceWei: bigint;
    aXbEthBalanceWei: bigint;
    debtBalanceWei: bigint;
  }> {
    const [xbEthBalanceWei, aXbEthBalanceWei, debtBalanceWei] = await Promise.all([
      this.client.readContract({
        address: XLAYER_MAINNET.contracts.xbEth,
        abi: erc20Abi,
        functionName: "balanceOf",
        args: [user],
        blockNumber,
      }),
      this.client.readContract({
        address: XLAYER_MAINNET.contracts.aXbEth,
        abi: erc20Abi,
        functionName: "balanceOf",
        args: [user],
        blockNumber,
      }),
      this.client.readContract({
        address: XLAYER_MAINNET.contracts.variableDebtXeth,
        abi: erc20Abi,
        functionName: "balanceOf",
        args: [user],
        blockNumber,
      }),
    ]);
    return { xbEthBalanceWei, aXbEthBalanceWei, debtBalanceWei };
  }
}

function decodeReserveConfiguration(asset: Address, raw: bigint): ReserveConfiguration {
  return {
    asset,
    rawData: raw.toString(),
    ltvBps: Number(raw & 0xffffn),
    liquidationThresholdBps: Number((raw >> 16n) & 0xffffn),
    liquidationBonusBps: Number((raw >> 32n) & 0xffffn),
    decimals: Number((raw >> 48n) & 0xffn),
    active: ((raw >> 56n) & 1n) === 1n,
    frozen: ((raw >> 57n) & 1n) === 1n,
    borrowingEnabled: ((raw >> 58n) & 1n) === 1n,
    paused: ((raw >> 60n) & 1n) === 1n,
  };
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message.split("\n")[0] ?? error.name : String(error);
}
