import type { Address, Hex } from "viem";
import type { ExecutorAuthorization } from "../domain/types.js";

export const egressExecutorExecutionAbi = [
  {
    type: "function",
    name: "execute",
    stateMutability: "nonpayable",
    inputs: [
      {
        name: "request",
        type: "tuple",
        components: [
          {
            name: "authorization",
            type: "tuple",
            components: [
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
          },
          {
            name: "authorizationSignature",
            type: "tuple",
            components: [
              { name: "v", type: "uint8" },
              { name: "r", type: "bytes32" },
              { name: "s", type: "bytes32" },
            ],
          },
          {
            name: "collateralPermit",
            type: "tuple",
            components: [
              { name: "deadline", type: "uint256" },
              { name: "v", type: "uint8" },
              { name: "r", type: "bytes32" },
              { name: "s", type: "bytes32" },
            ],
          },
        ],
      },
    ],
    outputs: [],
  },
  {
    type: "event",
    name: "Deleveraged",
    anonymous: false,
    inputs: [
      { name: "user", type: "address", indexed: true },
      { name: "executor", type: "address", indexed: true },
      { name: "nonce", type: "uint256", indexed: true },
      { name: "authorizationHash", type: "bytes32", indexed: false },
      { name: "debtRepaid", type: "uint256", indexed: false },
      { name: "collateralSold", type: "uint256", indexed: false },
      { name: "swapOutput", type: "uint256", indexed: false },
      { name: "flashPremium", type: "uint256", indexed: false },
      { name: "surplusReturned", type: "uint256", indexed: false },
      { name: "healthFactorBefore", type: "uint256", indexed: false },
      { name: "healthFactorAfter", type: "uint256", indexed: false },
    ],
  },
] as const;

export interface SignatureParts {
  v: number;
  r: Hex;
  s: Hex;
}

export interface CollateralPermitAuthorization {
  deadline: bigint;
  signature: Hex | null;
}

export interface ContractAuthorization {
  user: Address;
  executor: Address;
  repayAmount: bigint;
  collateralAmount: bigint;
  maxRepayment: bigint;
  maxCollateral: bigint;
  expectedSwapOut: bigint;
  minSwapOut: bigint;
  maxSlippageBps: bigint;
  maxFlashLoanPremiumBps: bigint;
  minPostHealthFactor: bigint;
  deadline: bigint;
  nonce: bigint;
  revocationNonce: bigint;
}

export interface EgressContractExecutionRequest {
  authorization: ContractAuthorization;
  authorizationSignature: SignatureParts;
  collateralPermit: SignatureParts & { deadline: bigint };
}

const ZERO_BYTES32 = `0x${"00".repeat(32)}` as Hex;

export function splitEvmSignature(signature: Hex): SignatureParts {
  if (!/^0x[0-9a-fA-F]{130}$/.test(signature)) {
    throw new Error("Egress requires a canonical 65-byte EVM signature");
  }
  const r = `0x${signature.slice(2, 66)}` as Hex;
  const s = `0x${signature.slice(66, 130)}` as Hex;
  const rawV = Number.parseInt(signature.slice(130, 132), 16);
  const v = rawV < 27 ? rawV + 27 : rawV;
  if (v !== 27 && v !== 28) {
    throw new Error(`Unsupported EVM recovery id ${rawV}`);
  }
  return { v, r, s };
}

export function authorizationToContract(
  authorization: ExecutorAuthorization,
): ContractAuthorization {
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

export function buildEgressExecutionRequest(input: {
  authorization: ExecutorAuthorization;
  userAuthorizationSignature: Hex;
  collateralPermit: CollateralPermitAuthorization;
}): EgressContractExecutionRequest {
  const authorization = authorizationToContract(input.authorization);
  if (input.collateralPermit.deadline < authorization.deadline) {
    throw new Error("Collateral permit expires before the Egress authorization");
  }
  const permitSignature = input.collateralPermit.signature
    ? splitEvmSignature(input.collateralPermit.signature)
    : { v: 27, r: ZERO_BYTES32, s: ZERO_BYTES32 };
  return {
    authorization,
    authorizationSignature: splitEvmSignature(input.userAuthorizationSignature),
    collateralPermit: {
      deadline: input.collateralPermit.deadline,
      ...permitSignature,
    },
  };
}
