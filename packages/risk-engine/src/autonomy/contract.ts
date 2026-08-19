import { encodeFunctionData, keccak256, type Address, type Hex } from "viem";
import type {
  AutonomousExecution,
  AutonomousRiskAttestation,
  OnchainProtectionPolicy,
} from "./schemas.js";
import { splitEvmSignature, type SignatureParts } from "../execution/contract.js";
import { objectHash } from "../domain/hash.js";

const POLICY_COMPONENTS = [
  { name: "user", type: "address" },
  { name: "keeper", type: "address" },
  { name: "riskAttestor", type: "address" },
  { name: "protocolConfigHash", type: "bytes32" },
  { name: "minimumRiskLevel", type: "uint8" },
  { name: "maxRepaymentPerExecution", type: "uint256" },
  { name: "maxCollateralPerExecution", type: "uint256" },
  { name: "maxCumulativeRepayment", type: "uint256" },
  { name: "maxCumulativeCollateral", type: "uint256" },
  { name: "maxCollateralPercentageBps", type: "uint256" },
  { name: "maxPositionDebt", type: "uint256" },
  { name: "maxSlippageBps", type: "uint256" },
  { name: "maxOracleDeviationBps", type: "uint256" },
  { name: "maxFlashLoanPremiumBps", type: "uint256" },
  { name: "maxPreHealthFactor", type: "uint256" },
  { name: "minPostHealthFactor", type: "uint256" },
  { name: "cooldownSeconds", type: "uint256" },
  { name: "maxExecutions", type: "uint256" },
  { name: "maxRiskAgeSeconds", type: "uint256" },
  { name: "maxClockSkewSeconds", type: "uint256" },
  { name: "expiresAt", type: "uint256" },
  { name: "nonce", type: "uint256" },
  { name: "revocationNonce", type: "uint256" },
] as const;

const SIGNATURE_COMPONENTS = [
  { name: "v", type: "uint8" },
  { name: "r", type: "bytes32" },
  { name: "s", type: "bytes32" },
] as const;

const ATTESTATION_COMPONENTS = [
  { name: "policyId", type: "bytes32" },
  { name: "riskEventId", type: "bytes32" },
  { name: "verdictHash", type: "bytes32" },
  { name: "evidenceHash", type: "bytes32" },
  { name: "riskLevel", type: "uint8" },
  { name: "issuedAt", type: "uint256" },
  { name: "expiresAt", type: "uint256" },
  { name: "signature", type: "tuple", components: SIGNATURE_COMPONENTS },
] as const;

const EXECUTION_COMPONENTS = [
  { name: "repayAmount", type: "uint256" },
  { name: "collateralAmount", type: "uint256" },
  { name: "expectedSwapOut", type: "uint256" },
  { name: "minSwapOut", type: "uint256" },
  { name: "deadline", type: "uint256" },
  { name: "executionNonce", type: "uint256" },
] as const;

export const egressAutonomousAbi = [
  {
    type: "error",
    name: "FlashLoanPremiumExceedsMaximum",
    inputs: [
      { name: "actual", type: "uint256" },
      { name: "maximum", type: "uint256" },
    ],
  },
  {
    type: "error",
    name: "SwapOutputBelowOracleFloor",
    inputs: [
      { name: "minimum", type: "uint256" },
      { name: "floor", type: "uint256" },
    ],
  },
  {
    type: "error",
    name: "UnsafePostHealthFactor",
    inputs: [
      { name: "actual", type: "uint256" },
      { name: "minimum", type: "uint256" },
    ],
  },
  {
    type: "error",
    name: "InsufficientSwapOutput",
    inputs: [
      { name: "actual", type: "uint256" },
      { name: "required", type: "uint256" },
    ],
  },
  {
    type: "function",
    name: "registerProtectionPolicy",
    stateMutability: "nonpayable",
    inputs: [
      { name: "policy", type: "tuple", components: POLICY_COMPONENTS },
      { name: "policySignature", type: "tuple", components: SIGNATURE_COMPONENTS },
      {
        name: "collateralPermit",
        type: "tuple",
        components: [
          { name: "deadline", type: "uint256" },
          ...SIGNATURE_COMPONENTS,
        ],
      },
    ],
    outputs: [{ name: "policyId", type: "bytes32" }],
  },
  {
    type: "function",
    name: "executeAutonomous",
    stateMutability: "nonpayable",
    inputs: [
      {
        name: "request",
        type: "tuple",
        components: [
          { name: "policy", type: "tuple", components: POLICY_COMPONENTS },
          { name: "riskAttestation", type: "tuple", components: ATTESTATION_COMPONENTS },
          { name: "execution", type: "tuple", components: EXECUTION_COMPONENTS },
        ],
      },
    ],
    outputs: [],
  },
  {
    type: "function",
    name: "revokeProtectionPolicy",
    stateMutability: "nonpayable",
    inputs: [{ name: "policyId", type: "bytes32" }],
    outputs: [],
  },
  {
    type: "function",
    name: "policyStates",
    stateMutability: "view",
    inputs: [{ name: "policyId", type: "bytes32" }],
    outputs: [
      { name: "user", type: "address" },
      { name: "active", type: "bool" },
      { name: "executionCount", type: "uint256" },
      { name: "lastExecutionAt", type: "uint256" },
      { name: "cumulativeRepayment", type: "uint256" },
      { name: "cumulativeCollateral", type: "uint256" },
      { name: "enrollmentCollateral", type: "uint256" },
      { name: "enrollmentDebt", type: "uint256" },
    ],
  },
  {
    type: "function",
    name: "riskEventUsed",
    stateMutability: "view",
    inputs: [
      { name: "policyId", type: "bytes32" },
      { name: "riskEventId", type: "bytes32" },
    ],
    outputs: [{ name: "used", type: "bool" }],
  },
  {
    type: "function",
    name: "revocationNonces",
    stateMutability: "view",
    inputs: [{ name: "user", type: "address" }],
    outputs: [{ name: "nonce", type: "uint256" }],
  },
  {
    type: "function",
    name: "paused",
    stateMutability: "view",
    inputs: [],
    outputs: [{ name: "value", type: "bool" }],
  },
  {
    type: "function",
    name: "PROTOCOL_CONFIG_HASH",
    stateMutability: "view",
    inputs: [],
    outputs: [{ name: "value", type: "bytes32" }],
  },
  {
    type: "event",
    name: "ProtectionPolicyRegistered",
    anonymous: false,
    inputs: [
      { name: "policyId", type: "bytes32", indexed: true },
      { name: "user", type: "address", indexed: true },
      { name: "keeper", type: "address", indexed: true },
      { name: "riskAttestor", type: "address", indexed: false },
      { name: "expiresAt", type: "uint256", indexed: false },
      { name: "maximumExecutions", type: "uint256", indexed: false },
      { name: "collateralBudget", type: "uint256", indexed: false },
    ],
  },
  {
    type: "event",
    name: "AutonomousExecutionAccepted",
    anonymous: false,
    inputs: [
      { name: "policyId", type: "bytes32", indexed: true },
      { name: "riskEventId", type: "bytes32", indexed: true },
      { name: "executionNonce", type: "uint256", indexed: true },
      { name: "repayAmount", type: "uint256", indexed: false },
      { name: "collateralAmount", type: "uint256", indexed: false },
      { name: "riskLevel", type: "uint8", indexed: false },
    ],
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

export interface ContractProtectionPolicy {
  user: Address;
  keeper: Address;
  riskAttestor: Address;
  protocolConfigHash: Hex;
  minimumRiskLevel: number;
  maxRepaymentPerExecution: bigint;
  maxCollateralPerExecution: bigint;
  maxCumulativeRepayment: bigint;
  maxCumulativeCollateral: bigint;
  maxCollateralPercentageBps: bigint;
  maxPositionDebt: bigint;
  maxSlippageBps: bigint;
  maxOracleDeviationBps: bigint;
  maxFlashLoanPremiumBps: bigint;
  maxPreHealthFactor: bigint;
  minPostHealthFactor: bigint;
  cooldownSeconds: bigint;
  maxExecutions: bigint;
  maxRiskAgeSeconds: bigint;
  maxClockSkewSeconds: bigint;
  expiresAt: bigint;
  nonce: bigint;
  revocationNonce: bigint;
}

export interface ContractAutonomousRequest {
  policy: ContractProtectionPolicy;
  riskAttestation: {
    policyId: Hex;
    riskEventId: Hex;
    verdictHash: Hex;
    evidenceHash: Hex;
    riskLevel: number;
    issuedAt: bigint;
    expiresAt: bigint;
    signature: SignatureParts;
  };
  execution: {
    repayAmount: bigint;
    collateralAmount: bigint;
    expectedSwapOut: bigint;
    minSwapOut: bigint;
    deadline: bigint;
    executionNonce: bigint;
  };
}

export interface PreparedAutonomousWriteRequest {
  address: Address;
  functionName: "executeAutonomous";
  args: readonly [ContractAutonomousRequest];
  gas: bigint | null;
}

export interface PreparedAutonomousTransactionEnvelope {
  contractAddress: Address;
  functionName: "executeAutonomous";
  functionSelector: Hex;
  calldataHash: Hex;
  contractRequestHash: Hex;
  gas: bigint | null;
}

export function autonomousContractRequestHash(request: ContractAutonomousRequest): Hex {
  return objectHash(bigIntsToStrings(request));
}

export function preparedAutonomousWriteMatches(input: {
  prepared: PreparedAutonomousWriteRequest;
  egressContract: Address;
  contractRequestHash: Hex;
}): boolean {
  try {
    const prepared = input.prepared as Partial<PreparedAutonomousWriteRequest>;
    return typeof prepared.address === "string" &&
      prepared.address.toLowerCase() === input.egressContract.toLowerCase() &&
      prepared.functionName === "executeAutonomous" &&
      Array.isArray(prepared.args) &&
      prepared.args.length === 1 &&
      autonomousContractRequestHash(prepared.args[0] as ContractAutonomousRequest).toLowerCase() ===
        input.contractRequestHash.toLowerCase() &&
      (prepared.gas === null || typeof prepared.gas === "bigint");
  } catch {
    return false;
  }
}

export function preparedAutonomousTransactionEnvelope(
  prepared: PreparedAutonomousWriteRequest,
): PreparedAutonomousTransactionEnvelope {
  const data = encodeFunctionData({
    abi: egressAutonomousAbi,
    functionName: prepared.functionName,
    args: prepared.args,
  });
  return {
    contractAddress: prepared.address,
    functionName: prepared.functionName,
    functionSelector: data.slice(0, 10) as Hex,
    calldataHash: keccak256(data),
    contractRequestHash: autonomousContractRequestHash(prepared.args[0]),
    gas: prepared.gas,
  };
}

export function protectionPolicyToContract(policy: OnchainProtectionPolicy): ContractProtectionPolicy {
  return {
    user: policy.user as Address,
    keeper: policy.keeper as Address,
    riskAttestor: policy.riskAttestor as Address,
    protocolConfigHash: policy.protocolConfigHash as Hex,
    minimumRiskLevel: policy.minimumRiskLevel,
    maxRepaymentPerExecution: BigInt(policy.maxRepaymentPerExecution),
    maxCollateralPerExecution: BigInt(policy.maxCollateralPerExecution),
    maxCumulativeRepayment: BigInt(policy.maxCumulativeRepayment),
    maxCumulativeCollateral: BigInt(policy.maxCumulativeCollateral),
    maxCollateralPercentageBps: BigInt(policy.maxCollateralPercentageBps),
    maxPositionDebt: BigInt(policy.maxPositionDebt),
    maxSlippageBps: BigInt(policy.maxSlippageBps),
    maxOracleDeviationBps: BigInt(policy.maxOracleDeviationBps),
    maxFlashLoanPremiumBps: BigInt(policy.maxFlashLoanPremiumBps),
    maxPreHealthFactor: BigInt(policy.maxPreHealthFactor),
    minPostHealthFactor: BigInt(policy.minPostHealthFactor),
    cooldownSeconds: BigInt(policy.cooldownSeconds),
    maxExecutions: BigInt(policy.maxExecutions),
    maxRiskAgeSeconds: BigInt(policy.maxRiskAgeSeconds),
    maxClockSkewSeconds: BigInt(policy.maxClockSkewSeconds),
    expiresAt: BigInt(policy.expiresAt),
    nonce: BigInt(policy.nonce),
    revocationNonce: BigInt(policy.revocationNonce),
  };
}

export function buildAutonomousContractRequest(input: {
  policy: OnchainProtectionPolicy;
  attestation: AutonomousRiskAttestation;
  execution: AutonomousExecution;
}): ContractAutonomousRequest {
  return {
    policy: protectionPolicyToContract(input.policy),
    riskAttestation: {
      policyId: input.attestation.policyId as Hex,
      riskEventId: input.attestation.riskEventId as Hex,
      verdictHash: input.attestation.verdictHash as Hex,
      evidenceHash: input.attestation.evidenceHash as Hex,
      riskLevel: input.attestation.riskLevel,
      issuedAt: BigInt(input.attestation.issuedAt),
      expiresAt: BigInt(input.attestation.expiresAt),
      signature: splitEvmSignature(input.attestation.signature as Hex),
    },
    execution: {
      repayAmount: BigInt(input.execution.repayAmount),
      collateralAmount: BigInt(input.execution.collateralAmount),
      expectedSwapOut: BigInt(input.execution.expectedSwapOut),
      minSwapOut: BigInt(input.execution.minSwapOut),
      deadline: BigInt(input.execution.deadline),
      executionNonce: BigInt(input.execution.executionNonce),
    },
  };
}

function bigIntsToStrings(value: unknown): unknown {
  if (typeof value === "bigint") return value.toString();
  if (Array.isArray(value)) return value.map(bigIntsToStrings);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => [key, bigIntsToStrings(item)]),
    );
  }
  return value;
}

export function buildPolicyRegistrationRequest(input: {
  policy: OnchainProtectionPolicy;
  policySignature: Hex;
  permitDeadline: bigint;
  permitSignature: Hex;
}) {
  return {
    policy: protectionPolicyToContract(input.policy),
    policySignature: splitEvmSignature(input.policySignature),
    collateralPermit: {
      deadline: input.permitDeadline,
      ...splitEvmSignature(input.permitSignature),
    },
  } as const;
}
