import type { Address, Hex } from "viem";
import {
  buildOnchainProtectionPolicy,
  protectionPolicyId,
  XLAYER_TESTNET_CHAIN_ID,
  type OnchainProtectionPolicy,
  type TestnetExecutionBounds,
  type UserProtectionPolicy,
} from "../packages/risk-engine/src/index.js";
import { REPLAY_SOURCE } from "../packages/risk-engine/src/replay/fixtures.js";

export interface Phase11ScenarioPolicyInput {
  borrower: Address;
  keeper: Address;
  riskAttestor: Address;
  egressContract: Address;
  protocolConfigHash: Hex;
  bounds: TestnetExecutionBounds;
  policyNonce: string;
  policyExpiresAt: string;
  revocationNonce: bigint;
}

export interface Phase11ScenarioPolicy {
  userPolicy: UserProtectionPolicy;
  onchainPolicy: OnchainProtectionPolicy;
  policyId: Hex;
}

export function buildPhase11ScenarioPolicy(input: Phase11ScenarioPolicyInput): Phase11ScenarioPolicy {
  const expiresAtSeconds = BigInt(input.policyExpiresAt);
  const expiresAtMilliseconds = Number(expiresAtSeconds) * 1_000;
  if (!Number.isSafeInteger(expiresAtMilliseconds)) {
    throw new Error("Phase 11 policy expiry is outside the supported timestamp range.");
  }
  const expiresAt = new Date(expiresAtMilliseconds);
  const minPostHealthFactor = BigInt(input.bounds.minPostHealthFactor);
  const userPolicy: UserProtectionPolicy = {
    policyId: "policy_phase11_xlayer_testnet_v1",
    policyVersion: 1,
    user: input.borrower,
    executor: input.keeper,
    chainId: XLAYER_TESTNET_CHAIN_ID,
    egressContract: input.egressContract,
    approvedRiskAttestor: input.riskAttestor,
    riskTrigger: input.bounds.minimumRiskLevel === 4 ? "CRITICAL" : "HIGH",
    minimumConfidence: 0.8,
    triggerHealthFactorWad: input.bounds.maxPreHealthFactor,
    minimumPostHealthFactorWad: input.bounds.minPostHealthFactor,
    targetPostHealthFactorWad: (minPostHealthFactor + 10_000_000_000_000_000n).toString(),
    maximumRepaymentWei: input.bounds.maxRepaymentPerExecution,
    maximumCollateralWei: input.bounds.maxCollateralPerExecution,
    maximumCollateralPercentageBps: Number(input.bounds.maxCollateralPercentageBps),
    maximumSlippageBps: Number(input.bounds.maxSlippageBps),
    maximumPriceImpactBps: Number(input.bounds.maxSlippageBps),
    maximumOraclePoolDeviationBps: Number(input.bounds.maxOracleDeviationBps),
    maximumFlashLoanPremiumBps: Number(input.bounds.maxFlashLoanPremiumBps),
    cooldownSeconds: Number(input.bounds.minCooldownSeconds),
    authorizationExpiresAt: expiresAt.toISOString(),
    intentTtlSeconds: 600,
    verdictMaxAgeSeconds: Number(input.bounds.maxRiskAgeSeconds),
    marketMaxAgeSeconds: 120,
    maximumClockSkewSeconds: Number(input.bounds.maxClockSkewSeconds),
    automaticExecutionEnabled: true,
    approvedSourceIds: [REPLAY_SOURCE.id],
  };
  const onchainPolicy = buildOnchainProtectionPolicy({
    policy: userPolicy,
    protocolConfigHash: input.protocolConfigHash,
    nonce: BigInt(input.policyNonce),
    revocationNonce: input.revocationNonce,
    maxExecutions: BigInt(input.bounds.maxExecutions),
    maxCumulativeRepaymentWei: BigInt(input.bounds.maxCumulativeRepayment),
    maxCumulativeCollateralWei: BigInt(input.bounds.maxCumulativeCollateral),
    maxPositionDebtWei: BigInt(input.bounds.maxPositionDebt),
    maxOracleDeviationBps: BigInt(input.bounds.maxOracleDeviationBps),
  });
  return {
    userPolicy,
    onchainPolicy,
    policyId: protectionPolicyId({
      chainId: XLAYER_TESTNET_CHAIN_ID,
      egressContract: input.egressContract,
      policy: onchainPolicy,
    }),
  };
}
