import { z } from "zod";
import {
  addressSchema,
  executionIntentSchema,
  hex32Schema,
  isoTimestampSchema,
  liquidityQuoteSchema,
  positionStateSchema,
  riskLevelSchema,
  uintStringSchema,
} from "../domain/schemas.js";
import {
  adapterHealthSchema,
  liveExecutionPreviewSchema,
  liveRwaEvidenceSchema,
  liveSnapshotEnvelopeSchema,
  oracleLiveStateSchema,
} from "./schemas.js";

export const liveArchiveStatusSchema = z.enum([
  "COMPLETE",
  "STALE",
  "INVALID",
  "UNAVAILABLE",
]);

export const blockConsistencyStatusSchema = z.enum([
  "CONSISTENT",
  "INCONSISTENT_BLOCK_DATA",
]);

export const archivedLiveSnapshotSchema = z.object({
  schemaVersion: z.literal(1),
  snapshotHash: hex32Schema,
  archiveStatus: liveArchiveStatusSchema,
  consistencyStatus: blockConsistencyStatusSchema,
  consistencyReasons: z.array(z.string()),
  integrityValid: z.boolean(),
  chainId: z.number().int().positive().nullable(),
  account: addressSchema.nullable(),
  observedBlock: uintStringSchema.nullable(),
  blockHash: hex32Schema.nullable(),
  timestamp: isoTimestampSchema,
  position: positionStateSchema.nullable(),
  oracle: oracleLiveStateSchema.nullable(),
  liquidity: liquidityQuoteSchema.nullable(),
  rwaEvidence: liveRwaEvidenceSchema.nullable(),
  freshness: z.object({
    allCriticalFresh: z.boolean(),
    adapters: z.array(adapterHealthSchema),
  }),
  riskClassification: riskLevelSchema.nullable(),
  policyEvaluation: executionIntentSchema.nullable(),
  executionPreview: liveExecutionPreviewSchema.nullable(),
  adapterVersions: z.record(z.string(), z.string()),
  configurationHash: hex32Schema,
  provenance: z.array(z.string()),
  envelope: liveSnapshotEnvelopeSchema,
  broadcastPermitted: z.literal(false),
  transactionSubmitted: z.literal(false),
  createdAt: isoTimestampSchema,
  integrityHash: hex32Schema,
});

export const liveSnapshotObservationSchema = z.object({
  observationId: z.string().min(1),
  snapshotHash: hex32Schema,
  observedAt: isoTimestampSchema,
});

export const liveArchiveHistoryEntrySchema = z.object({
  observation: liveSnapshotObservationSchema,
  snapshot: archivedLiveSnapshotSchema,
});

export const liveAlertSeveritySchema = z.enum(["INFO", "WARNING", "HIGH", "CRITICAL"]);

export const liveAlertTypeSchema = z.enum([
  "HEALTH_FACTOR_APPROACHING_TRIGGER",
  "HEALTH_FACTOR_DETERIORATED",
  "ORACLE_APPROACHING_STALE",
  "ORACLE_STALE",
  "LIQUIDITY_DETERIORATED",
  "SLIPPAGE_DETERIORATED",
  "SOURCE_CHANGED",
  "RISK_CHANGED",
  "SNAPSHOT_UNAVAILABLE",
  "SNAPSHOT_INTEGRITY_FAILURE",
  "POSITION_UNAVAILABLE",
  "POSITION_CLOSED",
  "DEBT_INCREASED",
  "COLLATERAL_REDUCED",
  "POSITION_SCOPE_CHANGED",
  "PROTOCOL_CONFIGURATION_CHANGED",
]);

export const liveAlertEvidenceSchema = z.object({
  code: z.string().min(1),
  message: z.string().min(1),
  source: z.string().min(1),
  provenance: z.array(z.string()),
});

export const liveAlertSchema = z.object({
  schemaVersion: z.literal(1),
  alertId: z.string().min(1),
  deduplicationKey: hex32Schema,
  alertType: liveAlertTypeSchema,
  severity: liveAlertSeveritySchema,
  snapshotHash: hex32Schema,
  previousSnapshotHash: hex32Schema.nullable(),
  block: uintStringSchema.nullable(),
  timestamp: isoTimestampSchema,
  evidence: z.array(liveAlertEvidenceSchema).min(1),
  previousState: z.unknown().nullable(),
  currentState: z.unknown().nullable(),
  thresholdPolicyVersion: z.number().int().positive().default(1),
  createdAt: isoTimestampSchema,
});

export type LiveArchiveStatus = z.infer<typeof liveArchiveStatusSchema>;
export type BlockConsistencyStatus = z.infer<typeof blockConsistencyStatusSchema>;
export type ArchivedLiveSnapshot = z.infer<typeof archivedLiveSnapshotSchema>;
export type LiveSnapshotObservation = z.infer<typeof liveSnapshotObservationSchema>;
export type LiveArchiveHistoryEntry = z.infer<typeof liveArchiveHistoryEntrySchema>;
export type LiveAlertSeverity = z.infer<typeof liveAlertSeveritySchema>;
export type LiveAlertType = z.infer<typeof liveAlertTypeSchema>;
export type LiveAlertEvidence = z.infer<typeof liveAlertEvidenceSchema>;
export type LiveAlert = z.infer<typeof liveAlertSchema>;
