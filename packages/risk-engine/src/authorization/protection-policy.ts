import {
  hashTypedData,
  verifyTypedData,
  type Address,
  type Hex,
  type PrivateKeyAccount,
  type TypedDataDomain,
} from "viem";
import type { RiskVerdict, UserProtectionPolicy } from "../domain/schemas.js";
import { objectHash } from "../domain/hash.js";
import {
  autonomousRiskAttestationSchema,
  onchainProtectionPolicySchema,
  type AutonomousRiskAttestation,
  type OnchainProtectionPolicy,
} from "../autonomy/schemas.js";

export const EGRESS_PROTECTION_POLICY_TYPES = {
  ProtectionPolicy: [
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
  ],
} as const;

export const EGRESS_AUTONOMOUS_RISK_TYPES = {
  RiskAttestation: [
    { name: "policyId", type: "bytes32" },
    { name: "riskEventId", type: "bytes32" },
    { name: "verdictHash", type: "bytes32" },
    { name: "evidenceHash", type: "bytes32" },
    { name: "riskLevel", type: "uint8" },
    { name: "issuedAt", type: "uint256" },
    { name: "expiresAt", type: "uint256" },
  ],
} as const;

export function egressProtectionPolicyDomain(input: {
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

export function egressAutonomousRiskDomain(input: {
  chainId: number;
  egressContract: Address;
}): TypedDataDomain {
  return {
    name: "Egress Risk Attestor",
    version: "1",
    chainId: input.chainId,
    verifyingContract: input.egressContract,
  };
}

export function protectionPolicyMessage(policy: OnchainProtectionPolicy) {
  const parsed = onchainProtectionPolicySchema.parse(policy);
  return {
    user: parsed.user as Address,
    keeper: parsed.keeper as Address,
    riskAttestor: parsed.riskAttestor as Address,
    protocolConfigHash: parsed.protocolConfigHash as Hex,
    minimumRiskLevel: parsed.minimumRiskLevel,
    maxRepaymentPerExecution: BigInt(parsed.maxRepaymentPerExecution),
    maxCollateralPerExecution: BigInt(parsed.maxCollateralPerExecution),
    maxCumulativeRepayment: BigInt(parsed.maxCumulativeRepayment),
    maxCumulativeCollateral: BigInt(parsed.maxCumulativeCollateral),
    maxCollateralPercentageBps: BigInt(parsed.maxCollateralPercentageBps),
    maxPositionDebt: BigInt(parsed.maxPositionDebt),
    maxSlippageBps: BigInt(parsed.maxSlippageBps),
    maxOracleDeviationBps: BigInt(parsed.maxOracleDeviationBps),
    maxFlashLoanPremiumBps: BigInt(parsed.maxFlashLoanPremiumBps),
    maxPreHealthFactor: BigInt(parsed.maxPreHealthFactor),
    minPostHealthFactor: BigInt(parsed.minPostHealthFactor),
    cooldownSeconds: BigInt(parsed.cooldownSeconds),
    maxExecutions: BigInt(parsed.maxExecutions),
    maxRiskAgeSeconds: BigInt(parsed.maxRiskAgeSeconds),
    maxClockSkewSeconds: BigInt(parsed.maxClockSkewSeconds),
    expiresAt: BigInt(parsed.expiresAt),
    nonce: BigInt(parsed.nonce),
    revocationNonce: BigInt(parsed.revocationNonce),
  } as const;
}

export function protectionPolicyId(input: {
  chainId: number;
  egressContract: Address;
  policy: OnchainProtectionPolicy;
}): Hex {
  return hashTypedData({
    domain: egressProtectionPolicyDomain(input),
    types: EGRESS_PROTECTION_POLICY_TYPES,
    primaryType: "ProtectionPolicy",
    message: protectionPolicyMessage(input.policy),
  });
}

export async function signProtectionPolicy(input: {
  account: PrivateKeyAccount;
  chainId: number;
  egressContract: Address;
  policy: OnchainProtectionPolicy;
}): Promise<Hex> {
  return input.account.signTypedData({
    domain: egressProtectionPolicyDomain(input),
    types: EGRESS_PROTECTION_POLICY_TYPES,
    primaryType: "ProtectionPolicy",
    message: protectionPolicyMessage(input.policy),
  });
}

export async function verifyProtectionPolicySignature(input: {
  chainId: number;
  egressContract: Address;
  policy: OnchainProtectionPolicy;
  signature: Hex;
}): Promise<boolean> {
  try {
    return await verifyTypedData({
      address: input.policy.user as Address,
      domain: egressProtectionPolicyDomain(input),
      types: EGRESS_PROTECTION_POLICY_TYPES,
      primaryType: "ProtectionPolicy",
      message: protectionPolicyMessage(input.policy),
      signature: input.signature,
    });
  } catch {
    return false;
  }
}

function unixSeconds(value: Date | string): bigint {
  return BigInt(Math.floor((value instanceof Date ? value : new Date(value)).getTime() / 1_000));
}

export function riskLevelCode(level: RiskVerdict["riskLevel"]): 3 | 4 {
  if (level === "HIGH") return 3;
  if (level === "CRITICAL") return 4;
  throw new Error(`Risk level ${level} cannot authorize autonomous execution`);
}

export function buildOnchainProtectionPolicy(input: {
  policy: UserProtectionPolicy;
  protocolConfigHash: Hex;
  nonce: bigint;
  revocationNonce: bigint;
  maxExecutions: bigint;
  maxCumulativeRepaymentWei: bigint;
  maxCumulativeCollateralWei: bigint;
  maxPositionDebtWei: bigint;
  maxOracleDeviationBps: bigint;
}): OnchainProtectionPolicy {
  if (input.policy.riskTrigger !== "HIGH" && input.policy.riskTrigger !== "CRITICAL") {
    throw new Error("Autonomous protection policies must trigger at HIGH or CRITICAL risk");
  }
  return onchainProtectionPolicySchema.parse({
    user: input.policy.user,
    keeper: input.policy.executor,
    riskAttestor: input.policy.approvedRiskAttestor,
    protocolConfigHash: input.protocolConfigHash,
    minimumRiskLevel: input.policy.riskTrigger === "HIGH" ? 3 : 4,
    maxRepaymentPerExecution: input.policy.maximumRepaymentWei,
    maxCollateralPerExecution: input.policy.maximumCollateralWei,
    maxCumulativeRepayment: input.maxCumulativeRepaymentWei.toString(),
    maxCumulativeCollateral: input.maxCumulativeCollateralWei.toString(),
    maxCollateralPercentageBps: input.policy.maximumCollateralPercentageBps.toString(),
    maxPositionDebt: input.maxPositionDebtWei.toString(),
    maxSlippageBps: input.policy.maximumSlippageBps.toString(),
    maxOracleDeviationBps: input.maxOracleDeviationBps.toString(),
    maxFlashLoanPremiumBps: input.policy.maximumFlashLoanPremiumBps.toString(),
    maxPreHealthFactor: input.policy.triggerHealthFactorWad,
    minPostHealthFactor: input.policy.minimumPostHealthFactorWad,
    cooldownSeconds: input.policy.cooldownSeconds.toString(),
    maxExecutions: input.maxExecutions.toString(),
    maxRiskAgeSeconds: input.policy.verdictMaxAgeSeconds.toString(),
    maxClockSkewSeconds: input.policy.maximumClockSkewSeconds.toString(),
    expiresAt: unixSeconds(input.policy.authorizationExpiresAt).toString(),
    nonce: input.nonce.toString(),
    revocationNonce: input.revocationNonce.toString(),
  });
}

export function autonomousRiskMessage(attestation: AutonomousRiskAttestation) {
  return {
    policyId: attestation.policyId as Hex,
    riskEventId: attestation.riskEventId as Hex,
    verdictHash: attestation.verdictHash as Hex,
    evidenceHash: attestation.evidenceHash as Hex,
    riskLevel: attestation.riskLevel,
    issuedAt: BigInt(attestation.issuedAt),
    expiresAt: BigInt(attestation.expiresAt),
  } as const;
}

export function createAutonomousRiskAttestation(input: {
  verdict: RiskVerdict;
  policyId: Hex;
  chainId: number;
  egressContract: Address;
  issuedAt?: Date;
  expiresAt?: Date;
}): Omit<AutonomousRiskAttestation, "signature"> {
  const issuedAt = input.issuedAt ?? new Date(input.verdict.issuedAt);
  const expiresAt = input.expiresAt ?? new Date(input.verdict.expiresAt);
  return {
    policyId: input.policyId,
    riskEventId: objectHash(input.verdict.riskEventId),
    verdictHash: objectHash(input.verdict),
    evidenceHash: objectHash(input.verdict.claims.flatMap((claim) => claim.evidence)),
    riskLevel: riskLevelCode(input.verdict.riskLevel),
    issuedAt: unixSeconds(issuedAt).toString(),
    expiresAt: unixSeconds(expiresAt).toString(),
  };
}

export async function signAutonomousRiskAttestation(input: {
  account: PrivateKeyAccount;
  verdict: RiskVerdict;
  policyId: Hex;
  chainId: number;
  egressContract: Address;
  issuedAt?: Date;
  expiresAt?: Date;
}): Promise<AutonomousRiskAttestation> {
  const unsigned = createAutonomousRiskAttestation(input);
  const signature = await input.account.signTypedData({
    domain: egressAutonomousRiskDomain(input),
    types: EGRESS_AUTONOMOUS_RISK_TYPES,
    primaryType: "RiskAttestation",
    message: autonomousRiskMessage({ ...unsigned, signature: `0x${"00".repeat(65)}` as Hex }),
  });
  return autonomousRiskAttestationSchema.parse({ ...unsigned, signature });
}

export async function verifyAutonomousRiskAttestation(input: {
  attestation: AutonomousRiskAttestation;
  chainId: number;
  egressContract: Address;
  riskAttestor: Address;
}): Promise<boolean> {
  try {
    return await verifyTypedData({
      address: input.riskAttestor,
      domain: egressAutonomousRiskDomain(input),
      types: EGRESS_AUTONOMOUS_RISK_TYPES,
      primaryType: "RiskAttestation",
      message: autonomousRiskMessage(input.attestation),
      signature: input.attestation.signature as Hex,
    });
  } catch {
    return false;
  }
}
