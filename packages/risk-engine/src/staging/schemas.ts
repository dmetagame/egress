import { z } from "zod";
import {
  addressSchema,
  hex32Schema,
  isoTimestampSchema,
  riskEventRecordSchema,
  signatureSchema,
  uintStringSchema,
} from "../domain/schemas.js";
import { objectHash } from "../domain/hash.js";
import {
  autonomousExecutionSchema,
  autonomousRiskAttestationSchema,
  onchainProtectionPolicySchema,
  shadowKeeperDecisionSchema,
  type AutonomousExecution,
  type AutonomousRiskAttestation,
  type OnchainProtectionPolicy,
  type ShadowKeeperDecision,
} from "../autonomy/schemas.js";
import {
  preparedAutonomousTransactionEnvelope,
  preparedAutonomousWriteMatches,
  type PreparedAutonomousWriteRequest,
} from "../autonomy/contract.js";

export const executionStagingEnvironmentSchema = z.enum([
  "DISABLED",
  "FORK_WRITE",
  "TESTNET_WRITE",
]);

export const executionWriteEnvironmentSchema = z.enum(["FORK_WRITE", "TESTNET_WRITE"]);

export const executionActionTypeSchema = z.literal("AAVE_XBETH_XETH_DELEVERAGE");

export const executionProtocolIdentitySchema = z.object({
  addressesProvider: addressSchema,
  aavePool: addressSchema,
  aaveOracle: addressSchema,
  xbEth: addressSchema,
  xeth: addressSchema,
  aXbEth: addressSchema,
  variableDebtXeth: addressSchema,
  uniswapFactory: addressSchema,
  swapRouter: addressSchema,
  quoterV2: addressSchema,
  swapPool: addressSchema,
  poolFee: z.number().int().min(0).max(1_000_000),
});

export const executionStagingRequestSchema = z.object({
  schemaVersion: z.literal(1),
  actionType: executionActionTypeSchema,
  snapshotHash: hex32Schema,
  riskEvent: riskEventRecordSchema,
  policy: onchainProtectionPolicySchema,
  policyAuthorizationSignature: signatureSchema,
  riskAttestation: autonomousRiskAttestationSchema,
  environment: executionWriteEnvironmentSchema,
  requestedAt: isoTimestampSchema,
});

export const executionBoundsSchema = z.object({
  maxRepaymentPerExecution: uintStringSchema,
  maxCollateralPerExecution: uintStringSchema,
  maxSlippageBps: uintStringSchema,
  maxOracleDeviationBps: uintStringSchema,
  maxFlashLoanPremiumBps: uintStringSchema,
  minPostHealthFactor: uintStringSchema,
});

export const executionStagingIntentSchema = z.object({
  schemaVersion: z.literal(1),
  intentHash: hex32Schema,
  requestHash: hex32Schema,
  actionType: executionActionTypeSchema,
  environment: executionWriteEnvironmentSchema,
  snapshotHash: hex32Schema,
  snapshotIntegrityHash: hex32Schema,
  chainId: z.number().int().positive(),
  observedBlock: uintStringSchema,
  riskEventId: z.string().min(1),
  riskEventIdHash: hex32Schema,
  verdictId: z.string().min(1),
  verdictHash: hex32Schema,
  evidenceHash: hex32Schema,
  riskLevel: z.enum(["HIGH", "CRITICAL"]),
  policyId: hex32Schema,
  policyNonce: uintStringSchema,
  revocationNonce: uintStringSchema,
  policyAuthorizationSignatureHash: hex32Schema,
  riskAttestationSignatureHash: hex32Schema,
  user: addressSchema,
  keeper: addressSchema,
  riskAttestor: addressSchema,
  egressContract: addressSchema,
  protocol: executionProtocolIdentitySchema,
  marketStateHash: hex32Schema,
  contractRequestHash: hex32Schema,
  execution: autonomousExecutionSchema,
  bounds: executionBoundsSchema,
  requestedAt: isoTimestampSchema,
  createdAt: isoTimestampSchema,
  integrityHash: hex32Schema,
});

export const executionSimulationSchema = z.object({
  schemaVersion: z.literal(1),
  simulationHash: hex32Schema,
  intentHash: hex32Schema,
  snapshotHash: hex32Schema,
  environment: executionWriteEnvironmentSchema,
  status: z.enum(["PASSED", "FAILED"]),
  attempted: z.boolean(),
  gasEstimate: uintStringSchema.nullable(),
  error: z.string().nullable(),
  decision: shadowKeeperDecisionSchema,
  createdAt: isoTimestampSchema,
  integrityHash: hex32Schema,
});

export const executionTransactionBindingSchema = z.object({
  schemaVersion: z.literal(1),
  chainId: z.number().int().positive(),
  environment: executionWriteEnvironmentSchema,
  contractAddress: addressSchema,
  functionName: z.literal("executeAutonomous"),
  functionSelector: z.string().regex(/^0x[0-9a-fA-F]{8}$/),
  calldataHash: hex32Schema,
  contractRequestHash: hex32Schema,
  keeper: addressSchema,
  gas: uintStringSchema.nullable(),
});

const executionSubmissionBaseSchema = z.object({
  submissionHash: hex32Schema,
  intentHash: hex32Schema,
  environment: executionWriteEnvironmentSchema,
  status: z.enum(["CONFIRMED", "REVERTED", "FAILED"]),
  transactionHash: hex32Schema.nullable(),
  blockNumber: uintStringSchema.nullable(),
  gasUsed: uintStringSchema.nullable(),
  error: z.string().nullable(),
  createdAt: isoTimestampSchema,
  integrityHash: hex32Schema,
});

export const executionSubmissionSchema = z.discriminatedUnion("schemaVersion", [
  executionSubmissionBaseSchema.extend({ schemaVersion: z.literal(1) }),
  executionSubmissionBaseSchema.extend({
    schemaVersion: z.literal(2),
    simulationHash: hex32Schema,
    executionFingerprint: hex32Schema,
    transactionBinding: executionTransactionBindingSchema,
  }),
]);

const executionSubmissionReservationBaseSchema = z.object({
  reservationId: z.string().uuid(),
  intentHash: hex32Schema,
  environment: executionWriteEnvironmentSchema,
  createdAt: isoTimestampSchema,
  integrityHash: hex32Schema,
});

export const executionSubmissionReservationSchema = z.discriminatedUnion("schemaVersion", [
  executionSubmissionReservationBaseSchema.extend({ schemaVersion: z.literal(1) }),
  executionSubmissionReservationBaseSchema.extend({
    schemaVersion: z.literal(2),
    simulationHash: hex32Schema,
    executionFingerprint: hex32Schema,
    transactionBinding: executionTransactionBindingSchema,
  }),
]);

export const executionWorkerEventSchema = z.object({
  schemaVersion: z.literal(1),
  eventHash: hex32Schema,
  eventType: z.enum([
    "WORKER_STARTED",
    "REQUEST_REJECTED",
    "SIMULATION_PASSED",
    "SIMULATION_FAILED",
    "SUBMISSION_CONFIRMED",
    "SUBMISSION_REVERTED",
    "WORKER_UNAVAILABLE",
  ]),
  environment: executionStagingEnvironmentSchema,
  state: z.enum(["HEALTHY", "DEGRADED", "UNAVAILABLE"]),
  intentHash: hex32Schema.nullable(),
  snapshotHash: hex32Schema.nullable(),
  code: z.string().nullable(),
  message: z.string().min(1),
  payload: z.record(z.string(), z.unknown()),
  createdAt: isoTimestampSchema,
  integrityHash: hex32Schema,
});

const latestIntentSummarySchema = z.object({
  intentHash: hex32Schema,
  snapshotHash: hex32Schema,
  environment: executionWriteEnvironmentSchema,
  chainId: z.number().int().positive(),
  observedBlock: uintStringSchema,
  createdAt: isoTimestampSchema,
});

const latestSimulationSummarySchema = z.object({
  simulationHash: hex32Schema,
  intentHash: hex32Schema,
  status: z.enum(["PASSED", "FAILED"]),
  createdAt: isoTimestampSchema,
});

const latestSubmissionSummarySchema = z.object({
  submissionHash: hex32Schema,
  intentHash: hex32Schema,
  environment: executionWriteEnvironmentSchema,
  status: z.enum(["CONFIRMED", "REVERTED", "FAILED"]),
  transactionHash: hex32Schema.nullable(),
  createdAt: isoTimestampSchema,
});

const latestReservationSummarySchema = z.object({
  reservationId: z.string().uuid(),
  intentHash: hex32Schema,
  environment: executionWriteEnvironmentSchema,
  simulationHash: hex32Schema.nullable(),
  executionFingerprint: hex32Schema.nullable(),
  createdAt: isoTimestampSchema,
});

export const executionStagingHealthSchema = z.object({
  schemaVersion: z.literal(1),
  configured: z.boolean(),
  environment: executionStagingEnvironmentSchema,
  state: z.enum(["HEALTHY", "DEGRADED", "UNAVAILABLE"]),
  submissionPermitted: z.boolean(),
  latestIntent: latestIntentSummarySchema.nullable(),
  latestSimulation: latestSimulationSummarySchema.nullable(),
  latestReservation: latestReservationSummarySchema.nullable(),
  latestSubmission: latestSubmissionSummarySchema.nullable(),
  lastError: z.string().nullable(),
  lastEventAt: isoTimestampSchema.nullable(),
  generatedAt: isoTimestampSchema,
});

export type ExecutionStagingEnvironment = z.infer<typeof executionStagingEnvironmentSchema>;
export type ExecutionWriteEnvironment = z.infer<typeof executionWriteEnvironmentSchema>;
export type ExecutionProtocolIdentity = z.infer<typeof executionProtocolIdentitySchema>;
export type ExecutionStagingRequest = z.infer<typeof executionStagingRequestSchema>;
export type ExecutionBounds = z.infer<typeof executionBoundsSchema>;
export type ExecutionStagingIntent = z.infer<typeof executionStagingIntentSchema>;
export type ExecutionSimulation = z.infer<typeof executionSimulationSchema>;
export type ExecutionTransactionBinding = z.infer<typeof executionTransactionBindingSchema>;
export type ExecutionSubmission = z.infer<typeof executionSubmissionSchema>;
export type ExecutionSubmissionReservation = z.infer<typeof executionSubmissionReservationSchema>;
export type ExecutionWorkerEvent = z.infer<typeof executionWorkerEventSchema>;
export type ExecutionStagingHealth = z.infer<typeof executionStagingHealthSchema>;
export type LatestIntentSummary = z.infer<typeof latestIntentSummarySchema>;
export type LatestSimulationSummary = z.infer<typeof latestSimulationSummarySchema>;
export type LatestReservationSummary = z.infer<typeof latestReservationSummarySchema>;
export type LatestSubmissionSummary = z.infer<typeof latestSubmissionSummarySchema>;

export interface ExecutionIntentInput {
  requestHash: `0x${string}`;
  actionType: "AAVE_XBETH_XETH_DELEVERAGE";
  environment: ExecutionWriteEnvironment;
  snapshotHash: `0x${string}`;
  snapshotIntegrityHash: `0x${string}`;
  chainId: number;
  observedBlock: string;
  riskEventId: string;
  riskEventIdHash: `0x${string}`;
  verdictId: string;
  verdictHash: `0x${string}`;
  evidenceHash: `0x${string}`;
  riskLevel: "HIGH" | "CRITICAL";
  policyId: `0x${string}`;
  policy: OnchainProtectionPolicy;
  policyAuthorizationSignatureHash: `0x${string}`;
  riskAttestationSignatureHash: `0x${string}`;
  user: string;
  keeper: string;
  riskAttestor: string;
  egressContract: string;
  protocol: ExecutionProtocolIdentity;
  marketStateHash: `0x${string}`;
  contractRequestHash: `0x${string}`;
  execution: AutonomousExecution;
  requestedAt: string;
  createdAt: string;
}

export function createExecutionStagingIntent(input: ExecutionIntentInput): ExecutionStagingIntent {
  const state = {
    schemaVersion: 1 as const,
    requestHash: input.requestHash,
    actionType: input.actionType,
    environment: input.environment,
    snapshotHash: input.snapshotHash,
    snapshotIntegrityHash: input.snapshotIntegrityHash,
    chainId: input.chainId,
    observedBlock: input.observedBlock,
    riskEventId: input.riskEventId,
    riskEventIdHash: input.riskEventIdHash,
    verdictId: input.verdictId,
    verdictHash: input.verdictHash,
    evidenceHash: input.evidenceHash,
    riskLevel: input.riskLevel,
    policyId: input.policyId,
    policyNonce: input.policy.nonce,
    revocationNonce: input.policy.revocationNonce,
    policyAuthorizationSignatureHash: input.policyAuthorizationSignatureHash,
    riskAttestationSignatureHash: input.riskAttestationSignatureHash,
    user: input.user,
    keeper: input.keeper,
    riskAttestor: input.riskAttestor,
    egressContract: input.egressContract,
    protocol: input.protocol,
    marketStateHash: input.marketStateHash,
    contractRequestHash: input.contractRequestHash,
    execution: input.execution,
    bounds: {
      maxRepaymentPerExecution: input.policy.maxRepaymentPerExecution,
      maxCollateralPerExecution: input.policy.maxCollateralPerExecution,
      maxSlippageBps: input.policy.maxSlippageBps,
      maxOracleDeviationBps: input.policy.maxOracleDeviationBps,
      maxFlashLoanPremiumBps: input.policy.maxFlashLoanPremiumBps,
      minPostHealthFactor: input.policy.minPostHealthFactor,
    },
    requestedAt: input.requestedAt,
  };
  const intentHash = objectHash(state);
  return executionStagingIntentSchema.parse({
    ...state,
    intentHash,
    createdAt: input.createdAt,
    integrityHash: objectHash({ ...state, intentHash, createdAt: input.createdAt }),
  });
}

export function verifyExecutionStagingIntent(intent: ExecutionStagingIntent): boolean {
  const parsed = executionStagingIntentSchema.safeParse(intent);
  if (!parsed.success) return false;
  const { intentHash, integrityHash, createdAt: _createdAt, ...state } = parsed.data;
  if (intentHash.toLowerCase() !== objectHash(state).toLowerCase()) return false;
  return integrityHash.toLowerCase() === objectHash({ ...state, intentHash, createdAt: parsed.data.createdAt }).toLowerCase();
}

export function createExecutionSimulation(input: {
  intent: ExecutionStagingIntent;
  decision: ShadowKeeperDecision;
  createdAt: string;
}): ExecutionSimulation {
  const state = {
    schemaVersion: 1 as const,
    intentHash: input.intent.intentHash,
    snapshotHash: input.intent.snapshotHash,
    environment: input.intent.environment,
    status: input.decision.simulation.success ? "PASSED" as const : "FAILED" as const,
    attempted: input.decision.simulation.attempted,
    gasEstimate: input.decision.simulation.gasEstimate,
    error: input.decision.simulation.error,
    decision: input.decision,
  };
  const simulationHash = objectHash(state);
  return executionSimulationSchema.parse({
    ...state,
    simulationHash,
    createdAt: input.createdAt,
    integrityHash: objectHash({ ...state, simulationHash, createdAt: input.createdAt }),
  });
}

export function createExecutionTransactionBinding(input: {
  intent: ExecutionStagingIntent;
  simulationRequest: PreparedAutonomousWriteRequest;
}): ExecutionTransactionBinding {
  if (!verifyExecutionStagingIntent(input.intent)) {
    throw new Error("Cannot bind a transaction to an invalid execution intent.");
  }
  if (!preparedAutonomousWriteMatches({
    prepared: input.simulationRequest,
    egressContract: input.intent.egressContract as `0x${string}`,
    contractRequestHash: input.intent.contractRequestHash as `0x${string}`,
  })) {
    throw new Error("Typed simulated request does not match the immutable execution intent.");
  }
  const envelope = preparedAutonomousTransactionEnvelope(input.simulationRequest);
  return executionTransactionBindingSchema.parse({
    schemaVersion: 1,
    chainId: input.intent.chainId,
    environment: input.intent.environment,
    contractAddress: envelope.contractAddress,
    functionName: envelope.functionName,
    functionSelector: envelope.functionSelector,
    calldataHash: envelope.calldataHash,
    contractRequestHash: envelope.contractRequestHash,
    keeper: input.intent.keeper,
    gas: envelope.gas?.toString() ?? null,
  });
}

/**
 * Binds a passed simulation to the one typed Egress write encoded by an
 * immutable intent. The submitter recomputes this immediately before writing.
 */
export function createExecutionFingerprint(input: {
  intent: ExecutionStagingIntent;
  simulation: ExecutionSimulation;
  transactionBinding: ExecutionTransactionBinding;
}): `0x${string}` {
  if (!verifyExecutionStagingIntent(input.intent)) {
    throw new Error("Cannot fingerprint an invalid execution intent.");
  }
  if (!verifyExecutionSimulation(input.simulation)) {
    throw new Error("Cannot fingerprint an invalid execution simulation.");
  }
  if (input.simulation.status !== "PASSED" || input.simulation.intentHash.toLowerCase() !== input.intent.intentHash.toLowerCase()) {
    throw new Error("Only a passed simulation for the exact immutable intent may be fingerprinted.");
  }
  const binding = executionTransactionBindingSchema.parse(input.transactionBinding);
  if (
    binding.chainId !== input.intent.chainId ||
    binding.environment !== input.intent.environment ||
    binding.contractAddress.toLowerCase() !== input.intent.egressContract.toLowerCase() ||
    binding.keeper.toLowerCase() !== input.intent.keeper.toLowerCase() ||
    binding.contractRequestHash.toLowerCase() !== input.intent.contractRequestHash.toLowerCase()
  ) {
    throw new Error("Execution transaction binding does not match the immutable intent.");
  }
  return objectHash({
    schemaVersion: 1,
    intentHash: input.intent.intentHash,
    intentIntegrityHash: input.intent.integrityHash,
    simulationHash: input.simulation.simulationHash,
    simulationIntegrityHash: input.simulation.integrityHash,
    chainId: input.intent.chainId,
    environment: input.intent.environment,
    egressContract: input.intent.egressContract,
    keeper: input.intent.keeper,
    functionName: "executeAutonomous",
    contractRequestHash: input.intent.contractRequestHash,
    transactionBinding: binding,
    execution: input.intent.execution,
    bounds: input.intent.bounds,
  });
}

export function verifyExecutionFingerprint(input: {
  fingerprint: `0x${string}`;
  intent: ExecutionStagingIntent;
  simulation: ExecutionSimulation;
  transactionBinding: ExecutionTransactionBinding;
}): boolean {
  try {
    return createExecutionFingerprint({
      intent: input.intent,
      simulation: input.simulation,
      transactionBinding: input.transactionBinding,
    }).toLowerCase() ===
      input.fingerprint.toLowerCase();
  } catch {
    return false;
  }
}

export function verifyExecutionSimulation(simulation: ExecutionSimulation): boolean {
  const parsed = executionSimulationSchema.safeParse(simulation);
  if (!parsed.success) return false;
  const { simulationHash, integrityHash, createdAt: _createdAt, ...state } = parsed.data;
  return simulationHash.toLowerCase() === objectHash(state).toLowerCase() &&
    integrityHash.toLowerCase() === objectHash({ ...state, simulationHash, createdAt: parsed.data.createdAt }).toLowerCase();
}

export function createExecutionSubmission(input: {
  intent: ExecutionStagingIntent;
  simulation?: ExecutionSimulation;
  executionFingerprint?: `0x${string}`;
  transactionBinding?: ExecutionTransactionBinding;
  status: "CONFIRMED" | "REVERTED" | "FAILED";
  transactionHash: `0x${string}` | null;
  blockNumber: string | null;
  gasUsed: string | null;
  error?: string | null;
  createdAt: string;
}): ExecutionSubmission {
  const hasSimulationBinding = input.simulation !== undefined ||
    input.executionFingerprint !== undefined ||
    input.transactionBinding !== undefined;
  if (hasSimulationBinding && (!input.simulation || !input.executionFingerprint || !input.transactionBinding)) {
    throw new Error("Execution submission simulation binding requires simulation, transaction binding, and fingerprint.");
  }
  if (input.simulation && input.executionFingerprint && input.transactionBinding && !verifyExecutionFingerprint({
    fingerprint: input.executionFingerprint,
    intent: input.intent,
    simulation: input.simulation,
    transactionBinding: input.transactionBinding,
  })) {
    throw new Error("Execution submission fingerprint does not bind the exact passed simulation and intent.");
  }
  const base = {
    intentHash: input.intent.intentHash,
    environment: input.intent.environment,
    status: input.status,
    transactionHash: input.transactionHash,
    blockNumber: input.blockNumber,
    gasUsed: input.gasUsed,
    error: input.error ?? null,
  };
  const state = input.simulation && input.executionFingerprint && input.transactionBinding
    ? {
      schemaVersion: 2 as const,
      ...base,
      simulationHash: input.simulation.simulationHash,
      executionFingerprint: input.executionFingerprint,
      transactionBinding: input.transactionBinding,
    }
    : { schemaVersion: 1 as const, ...base };
  const submissionHash = objectHash(state);
  return executionSubmissionSchema.parse({
    ...state,
    submissionHash,
    createdAt: input.createdAt,
    integrityHash: objectHash({ ...state, submissionHash, createdAt: input.createdAt }),
  });
}

export function verifyExecutionSubmission(submission: ExecutionSubmission): boolean {
  const parsed = executionSubmissionSchema.safeParse(submission);
  if (!parsed.success) return false;
  const { submissionHash, integrityHash, createdAt: _createdAt, ...state } = parsed.data;
  return submissionHash.toLowerCase() === objectHash(state).toLowerCase() &&
    integrityHash.toLowerCase() === objectHash({ ...state, submissionHash, createdAt: parsed.data.createdAt }).toLowerCase();
}

export function createExecutionSubmissionReservation(input: {
  reservationId: string;
  intent: ExecutionStagingIntent;
  simulation?: ExecutionSimulation;
  executionFingerprint?: `0x${string}`;
  transactionBinding?: ExecutionTransactionBinding;
  createdAt: string;
}): ExecutionSubmissionReservation {
  const hasSimulationBinding = input.simulation !== undefined ||
    input.executionFingerprint !== undefined ||
    input.transactionBinding !== undefined;
  if (hasSimulationBinding && (!input.simulation || !input.executionFingerprint || !input.transactionBinding)) {
    throw new Error("Execution reservation simulation binding requires simulation, transaction binding, and fingerprint.");
  }
  if (input.simulation && input.executionFingerprint && input.transactionBinding && !verifyExecutionFingerprint({
    fingerprint: input.executionFingerprint,
    intent: input.intent,
    simulation: input.simulation,
    transactionBinding: input.transactionBinding,
  })) {
    throw new Error("Execution reservation fingerprint does not bind the exact passed simulation and intent.");
  }
  const base = {
    reservationId: input.reservationId,
    intentHash: input.intent.intentHash,
    environment: input.intent.environment,
    createdAt: input.createdAt,
  };
  const state = input.simulation && input.executionFingerprint && input.transactionBinding
    ? {
      schemaVersion: 2 as const,
      ...base,
      simulationHash: input.simulation.simulationHash,
      executionFingerprint: input.executionFingerprint,
      transactionBinding: input.transactionBinding,
    }
    : { schemaVersion: 1 as const, ...base };
  return executionSubmissionReservationSchema.parse({
    ...state,
    integrityHash: objectHash(state),
  });
}

export function verifyExecutionSubmissionReservation(
  reservation: ExecutionSubmissionReservation,
): boolean {
  const parsed = executionSubmissionReservationSchema.safeParse(reservation);
  if (!parsed.success) return false;
  const { integrityHash, ...state } = parsed.data;
  return integrityHash.toLowerCase() === objectHash(state).toLowerCase();
}

export function createExecutionWorkerEvent(input: {
  eventType: ExecutionWorkerEvent["eventType"];
  environment: ExecutionStagingEnvironment;
  state: ExecutionWorkerEvent["state"];
  intentHash?: `0x${string}` | null;
  snapshotHash?: `0x${string}` | null;
  code?: string | null;
  message: string;
  payload?: Record<string, unknown>;
  createdAt: string;
}): ExecutionWorkerEvent {
  const state = {
    schemaVersion: 1 as const,
    eventType: input.eventType,
    environment: input.environment,
    state: input.state,
    intentHash: input.intentHash ?? null,
    snapshotHash: input.snapshotHash ?? null,
    code: input.code ?? null,
    message: input.message,
    payload: input.payload ?? {},
  };
  const eventHash = objectHash(state);
  return executionWorkerEventSchema.parse({
    ...state,
    eventHash,
    createdAt: input.createdAt,
    integrityHash: objectHash({ ...state, eventHash, createdAt: input.createdAt }),
  });
}

export function verifyExecutionWorkerEvent(event: ExecutionWorkerEvent): boolean {
  const parsed = executionWorkerEventSchema.safeParse(event);
  if (!parsed.success) return false;
  const { eventHash, integrityHash, createdAt: _createdAt, ...state } = parsed.data;
  return eventHash.toLowerCase() === objectHash(state).toLowerCase() &&
    integrityHash.toLowerCase() ===
      objectHash({ ...state, eventHash, createdAt: parsed.data.createdAt }).toLowerCase();
}
