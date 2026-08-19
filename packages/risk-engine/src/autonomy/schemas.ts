import { z } from "zod";
import {
  addressSchema,
  hex32Schema,
  isoTimestampSchema,
  marketContextSchema,
  policyCheckSchema,
  riskEventRecordSchema,
  signatureSchema,
  uintStringSchema,
} from "../domain/schemas.js";

export const onchainRiskLevelSchema = z.union([z.literal(3), z.literal(4)]);

export const onchainProtectionPolicySchema = z.object({
  user: addressSchema,
  keeper: addressSchema,
  riskAttestor: addressSchema,
  protocolConfigHash: hex32Schema,
  minimumRiskLevel: onchainRiskLevelSchema,
  maxRepaymentPerExecution: uintStringSchema,
  maxCollateralPerExecution: uintStringSchema,
  maxCumulativeRepayment: uintStringSchema,
  maxCumulativeCollateral: uintStringSchema,
  maxCollateralPercentageBps: uintStringSchema,
  maxPositionDebt: uintStringSchema,
  maxSlippageBps: uintStringSchema,
  maxOracleDeviationBps: uintStringSchema,
  maxFlashLoanPremiumBps: uintStringSchema,
  maxPreHealthFactor: uintStringSchema,
  minPostHealthFactor: uintStringSchema,
  cooldownSeconds: uintStringSchema,
  maxExecutions: uintStringSchema,
  maxRiskAgeSeconds: uintStringSchema,
  maxClockSkewSeconds: uintStringSchema,
  expiresAt: uintStringSchema,
  nonce: uintStringSchema,
  revocationNonce: uintStringSchema,
});

export const autonomousRiskAttestationSchema = z.object({
  policyId: hex32Schema,
  riskEventId: hex32Schema,
  verdictHash: hex32Schema,
  evidenceHash: hex32Schema,
  riskLevel: onchainRiskLevelSchema,
  issuedAt: uintStringSchema,
  expiresAt: uintStringSchema,
  signature: signatureSchema,
});

export const autonomousExecutionSchema = z.object({
  repayAmount: uintStringSchema,
  collateralAmount: uintStringSchema,
  expectedSwapOut: uintStringSchema,
  minSwapOut: uintStringSchema,
  deadline: uintStringSchema,
  executionNonce: uintStringSchema,
});

export const onchainPolicyStateSchema = z.object({
  user: addressSchema,
  active: z.boolean(),
  executionCount: uintStringSchema,
  lastExecutionAt: uintStringSchema,
  cumulativeRepayment: uintStringSchema,
  cumulativeCollateral: uintStringSchema,
  enrollmentCollateral: uintStringSchema,
  enrollmentDebt: uintStringSchema,
  currentRevocationNonce: uintStringSchema,
  paused: z.boolean(),
  riskEventUsed: z.boolean(),
  collateralAllowance: uintStringSchema,
});

export const shadowSimulationSchema = z.object({
  attempted: z.boolean(),
  success: z.boolean(),
  gasEstimate: uintStringSchema.nullable(),
  error: z.string().nullable(),
});

export const shadowKeeperDecisionSchema = z.object({
  decisionId: z.string().min(1),
  status: z.enum(["WOULD_EXECUTE", "WOULD_NOT_EXECUTE"]),
  evaluatedAt: isoTimestampSchema,
  riskEventId: z.string().min(1),
  riskEventIdHash: hex32Schema,
  policyId: hex32Schema,
  checks: z.array(policyCheckSchema),
  reasons: z.array(z.string()),
  market: marketContextSchema,
  policyState: onchainPolicyStateSchema,
  attestation: autonomousRiskAttestationSchema,
  execution: autonomousExecutionSchema.nullable(),
  simulation: shadowSimulationSchema,
});

export const autonomousExecutionResultSchema = z.object({
  status: z.enum(["NOT_BROADCAST", "CONFIRMED", "REVERTED"]),
  transactionHash: hex32Schema.nullable(),
  blockNumber: uintStringSchema.nullable(),
  gasUsed: uintStringSchema.nullable(),
  observedAt: isoTimestampSchema,
});

export const autonomousControlLoopRecordSchema = z.object({
  schemaVersion: z.literal(1),
  label: z.string().min(1),
  riskEvent: riskEventRecordSchema,
  policy: onchainProtectionPolicySchema,
  policyId: hex32Schema,
  policyAuthorizationSignature: signatureSchema,
  decision: shadowKeeperDecisionSchema,
  executionResult: autonomousExecutionResultSchema,
});

export type OnchainProtectionPolicy = z.infer<typeof onchainProtectionPolicySchema>;
export type AutonomousRiskAttestation = z.infer<typeof autonomousRiskAttestationSchema>;
export type AutonomousExecution = z.infer<typeof autonomousExecutionSchema>;
export type OnchainPolicyState = z.infer<typeof onchainPolicyStateSchema>;
export type ShadowKeeperDecision = z.infer<typeof shadowKeeperDecisionSchema>;
export type AutonomousControlLoopRecord = z.infer<typeof autonomousControlLoopRecordSchema>;
