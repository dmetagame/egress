import {
  verifyTypedData,
  type Address,
  type Hex,
  type TypedDataDomain,
} from "viem";
import type { ExecutorAuthorization } from "../domain/types.js";

export const EGRESS_AUTHORIZATION_TYPES = {
  Authorization: [
    { name: "user", type: "address" },
    { name: "executor", type: "address" },
    { name: "repayAmount", type: "uint256" },
    { name: "collateralAmount", type: "uint256" },
    { name: "maxRepayment", type: "uint256" },
    { name: "maxCollateral", type: "uint256" },
    { name: "expectedSwapOut", type: "uint256" },
    { name: "minSwapOut", type: "uint256" },
    { name: "maxSlippageBps", type: "uint256" },
    { name: "maxFlashLoanPremiumBps", type: "uint256" },
    { name: "minPostHealthFactor", type: "uint256" },
    { name: "deadline", type: "uint256" },
    { name: "nonce", type: "uint256" },
    { name: "revocationNonce", type: "uint256" },
  ],
} as const;

export function egressAuthorizationDomain(input: {
  chainId: number;
  egressContract: Address;
}): TypedDataDomain {
  return {
    name: "Egress",
    version: "1",
    chainId: input.chainId,
    verifyingContract: input.egressContract,
  };
}

export function executorAuthorizationMessage(authorization: ExecutorAuthorization) {
  return {
    user: authorization.user as Address,
    executor: authorization.executor as Address,
    repayAmount: BigInt(authorization.repayAmount),
    collateralAmount: BigInt(authorization.collateralAmount),
    maxRepayment: BigInt(authorization.maxRepayment),
    maxCollateral: BigInt(authorization.maxCollateral),
    expectedSwapOut: BigInt(authorization.expectedSwapOut),
    minSwapOut: BigInt(authorization.minSwapOut),
    maxSlippageBps: BigInt(authorization.maxSlippageBps),
    maxFlashLoanPremiumBps: BigInt(authorization.maxFlashLoanPremiumBps),
    minPostHealthFactor: BigInt(authorization.minPostHealthFactor),
    deadline: BigInt(authorization.deadline),
    nonce: BigInt(authorization.nonce),
    revocationNonce: BigInt(authorization.revocationNonce),
  };
}

export async function verifyExecutorAuthorizationSignature(input: {
  chainId: number;
  egressContract: Address;
  authorization: ExecutorAuthorization;
  signature: Hex;
}): Promise<boolean> {
  try {
    return await verifyTypedData({
      address: input.authorization.user as Address,
      domain: egressAuthorizationDomain(input),
      types: EGRESS_AUTHORIZATION_TYPES,
      primaryType: "Authorization",
      message: executorAuthorizationMessage(input.authorization),
      signature: input.signature,
    });
  } catch {
    return false;
  }
}
