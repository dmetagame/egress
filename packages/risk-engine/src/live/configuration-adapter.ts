import type { Address, PublicClient } from "viem";
import {
  aaveAddressesProviderAbi,
  erc20Abi,
  uniswapFactoryAbi,
} from "../market/abis.js";
import { XLAYER_MAINNET } from "../market/config.js";
import {
  availableHealth,
  type AdapterHealth,
  unavailableHealth,
} from "./schemas.js";

export interface ProtocolConfigurationResult {
  verified: boolean;
  reasons: string[];
  health: AdapterHealth;
}

export class ProtocolConfigurationReadAdapter {
  private readonly now: () => Date;

  constructor(private readonly client: PublicClient, options: { now?: () => Date } = {}) {
    this.now = options.now ?? (() => new Date());
  }

  async read(blockNumber: bigint): Promise<ProtocolConfigurationResult> {
    const now = this.now();
    const contracts = XLAYER_MAINNET.contracts;
    try {
      const addresses = Object.values(contracts).filter(
        (value): value is Address => typeof value === "string" && value.startsWith("0x"),
      );
      const [poolFromProvider, oracleFromProvider, poolFromFactory, decimals, bytecodes] =
        await Promise.all([
          this.client.readContract({
            address: contracts.addressesProvider,
            abi: aaveAddressesProviderAbi,
            functionName: "getPool",
            blockNumber,
          }),
          this.client.readContract({
            address: contracts.addressesProvider,
            abi: aaveAddressesProviderAbi,
            functionName: "getPriceOracle",
            blockNumber,
          }),
          this.client.readContract({
            address: contracts.uniswapFactory,
            abi: uniswapFactoryAbi,
            functionName: "getPool",
            args: [contracts.xbEth, contracts.xeth, XLAYER_MAINNET.poolFee],
            blockNumber,
          }),
          Promise.all(
            [contracts.xbEth, contracts.xeth, contracts.aXbEth, contracts.variableDebtXeth].map(
              (address) =>
                this.client.readContract({
                  address,
                  abi: erc20Abi,
                  functionName: "decimals",
                  blockNumber,
                }),
            ),
          ),
          Promise.all(
            addresses.map(async (address) => ({
              address,
              code: await this.client.getBytecode({ address, blockNumber }),
            })),
          ),
        ]);
      const reasons: string[] = [];
      if (!addressesEqual(poolFromProvider, contracts.aavePool)) {
        reasons.push("PoolAddressesProvider.getPool() does not match configured Aave Pool.");
      }
      if (!addressesEqual(oracleFromProvider, contracts.aaveOracle)) {
        reasons.push("PoolAddressesProvider.getPriceOracle() does not match configured oracle.");
      }
      if (!addressesEqual(poolFromFactory, contracts.swapPool)) {
        reasons.push("Uniswap factory does not resolve the configured xBETH/xETH pool.");
      }
      if (decimals.some((value) => Number(value) !== XLAYER_MAINNET.tokenDecimals)) {
        reasons.push("A configured token does not use the verified 18 decimals.");
      }
      for (const item of bytecodes) {
        if (!item.code || item.code === "0x") reasons.push(`Missing bytecode at ${item.address}.`);
      }
      const verified = reasons.length === 0;
      const health = availableHealth({
        adapter: "configuration",
        message: verified
          ? "Aave, Uniswap, token, and bytecode configuration matches the verified X Layer address book."
          : "Protocol configuration validation failed.",
        now,
        blockNumber,
        sourceTimestamp: now,
        maxAgeSeconds: 120,
        provenance: [
          contracts.addressesProvider,
          contracts.uniswapFactory,
          contracts.swapPool,
          `block:${blockNumber.toString()}`,
        ],
      });
      return {
        verified,
        reasons,
        health: verified
          ? health
          : { ...health, status: "INVALID_CONFIGURATION", message: reasons.join(" ") },
      };
    } catch (error) {
      return {
        verified: false,
        reasons: [errorMessage(error)],
        health: unavailableHealth("configuration", errorMessage(error), now, {
          blockNumber,
          maxAgeSeconds: 120,
          status: "INVALID_CONFIGURATION",
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
