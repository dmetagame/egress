import {
  createPublicClient,
  defineChain,
  http,
  type Address,
  type Hex,
  type PublicClient,
} from "viem";
import type { PolicyRuntimeState } from "../domain/schemas.js";
import { XLAYER_MAINNET } from "../market/config.js";
import { egressExecutorStateAbi, erc20Abi } from "../market/abis.js";

const xLayer = defineChain({
  id: XLAYER_MAINNET.chainId,
  name: "X Layer",
  nativeCurrency: { name: "OKB", symbol: "OKB", decimals: 18 },
  rpcUrls: { default: { http: [XLAYER_MAINNET.rpcUrl] } },
  blockExplorers: {
    default: { name: "OKLink", url: XLAYER_MAINNET.explorerUrl },
  },
});

export interface ExecutorRuntimeStateInput {
  user: Address;
  egressContract: Address;
  collateralAToken: Address;
  authorizationNonce: bigint;
  requiredCollateralWei: bigint;
  collateralPermitAvailable: boolean;
  lastExecutionAt: string | null;
  userAuthorizationSignature: Hex | null;
  evaluatedAt?: Date;
  blockNumber?: bigint;
}

export class XLayerExecutorStateProvider {
  private readonly client: PublicClient;

  constructor(options: { rpcUrl?: string; client?: PublicClient } = {}) {
    this.client =
      options.client ??
      createPublicClient({
        chain: xLayer,
        transport: http(options.rpcUrl ?? XLAYER_MAINNET.rpcUrl),
      });
  }

  async getRuntimeState(input: ExecutorRuntimeStateInput): Promise<PolicyRuntimeState> {
    const blockNumber = input.blockNumber ?? (await this.client.getBlockNumber());
    const [revocationNonce, nonceAlreadyUsed, paused, allowance] = await Promise.all([
      this.client.readContract({
        address: input.egressContract,
        abi: egressExecutorStateAbi,
        functionName: "revocationNonces",
        args: [input.user],
        blockNumber,
      }),
      this.client.readContract({
        address: input.egressContract,
        abi: egressExecutorStateAbi,
        functionName: "authorizationUsed",
        args: [input.user, input.authorizationNonce],
        blockNumber,
      }),
      this.client.readContract({
        address: input.egressContract,
        abi: egressExecutorStateAbi,
        functionName: "paused",
        blockNumber,
      }),
      this.client.readContract({
        address: input.collateralAToken,
        abi: erc20Abi,
        functionName: "allowance",
        args: [input.user, input.egressContract],
        blockNumber,
      }),
    ]);

    return {
      evaluatedAt: (input.evaluatedAt ?? new Date()).toISOString(),
      lastExecutionAt: input.lastExecutionAt,
      authorizationNonce: input.authorizationNonce.toString(),
      revocationNonce: revocationNonce.toString(),
      nonceAlreadyUsed,
      executorPaused: paused,
      userAuthorizationSignature: input.userAuthorizationSignature,
      collateralAuthorizationAvailable:
        input.collateralPermitAvailable || allowance >= input.requiredCollateralWei,
    };
  }
}
