import type { Address, PublicClient } from "viem";
import { erc20Abi } from "../market/abis.js";
import { XLAYER_MAINNET } from "../market/config.js";
import {
  availableHealth,
  type AdapterHealth,
  type TokenLiveState,
  unavailableHealth,
} from "./schemas.js";

export interface TokenAdapterResult {
  xbEth: TokenLiveState | null;
  xeth: TokenLiveState | null;
  health: AdapterHealth;
}

export class XbEthReadAdapter {
  private readonly now: () => Date;

  constructor(
    private readonly client: PublicClient,
    options: { now?: () => Date; allowanceSpender?: Address } = {},
  ) {
    this.now = options.now ?? (() => new Date());
    this.allowanceSpender = options.allowanceSpender;
  }

  private readonly allowanceSpender?: Address;

  async read(user: Address, blockNumber: bigint, blockTimestamp: Date): Promise<TokenAdapterResult> {
    const now = this.now();
    try {
      const [xbEth, xeth] = await Promise.all([
        this.readToken(XLAYER_MAINNET.contracts.xbEth, user, blockNumber, true),
        this.readToken(XLAYER_MAINNET.contracts.xeth, user, blockNumber, false),
      ]);
      return {
        xbEth,
        xeth,
        health: availableHealth({
          adapter: "xbeth",
          message: "xBETH and xETH token metadata and balances were read.",
          now,
          blockNumber,
          sourceTimestamp: blockTimestamp,
          maxAgeSeconds: 120,
          provenance: [
            XLAYER_MAINNET.contracts.xbEth,
            XLAYER_MAINNET.contracts.xeth,
            `account:${user}`,
          ],
        }),
      };
    } catch (error) {
      return {
        xbEth: null,
        xeth: null,
        health: unavailableHealth("xbeth", errorMessage(error), now, {
          blockNumber,
          maxAgeSeconds: 120,
        }),
      };
    }
  }

  private async readToken(
    address: Address,
    user: Address,
    blockNumber: bigint,
    readATokenAllowance: boolean,
  ): Promise<TokenLiveState> {
    const [symbol, name, decimals, walletBalanceWei, allowance] = await Promise.all([
      this.client.readContract({ address, abi: erc20Abi, functionName: "symbol", blockNumber }),
      this.client.readContract({ address, abi: erc20Abi, functionName: "name", blockNumber }),
      this.client.readContract({ address, abi: erc20Abi, functionName: "decimals", blockNumber }),
      this.client.readContract({
        address,
        abi: erc20Abi,
        functionName: "balanceOf",
        args: [user],
        blockNumber,
      }),
      readATokenAllowance && this.allowanceSpender
        ? this.client.readContract({
            address: XLAYER_MAINNET.contracts.aXbEth,
            abi: erc20Abi,
            functionName: "allowance",
            args: [user, this.allowanceSpender],
            blockNumber,
          })
        : Promise.resolve(null),
    ]);
    return {
      address,
      symbol,
      name,
      decimals: Number(decimals),
      walletBalanceWei: walletBalanceWei.toString(),
      aTokenAllowanceWei: allowance === null ? null : allowance.toString(),
    };
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message.split("\n")[0] ?? error.name : String(error);
}
