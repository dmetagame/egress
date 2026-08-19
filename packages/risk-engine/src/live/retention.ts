import { isoTimestampSchema } from "../domain/schemas.js";

export const LIVE_RETENTION_POLICY_VERSION = 1 as const;

export interface LiveRetentionPolicy {
  version: typeof LIVE_RETENTION_POLICY_VERSION;
  canonicalSnapshots: "INDEFINITE";
  observationsDays: number;
  alertsDays: number;
  operationalEventsDays: number;
  deliveryRecordsDays: number;
  automaticPruning: false;
}

export const DEFAULT_LIVE_RETENTION_POLICY: LiveRetentionPolicy = {
  version: LIVE_RETENTION_POLICY_VERSION,
  canonicalSnapshots: "INDEFINITE",
  observationsDays: 3650,
  alertsDays: 730,
  operationalEventsDays: 90,
  deliveryRecordsDays: 90,
  automaticPruning: false,
};

export interface RetentionWindow {
  recordType: "observations" | "alerts" | "operational_events" | "delivery_records";
  cutoffAt: string;
  action: "REVIEW_ONLY";
  policyVersion: number;
}

export function retentionWindows(
  now = new Date(),
  policy = DEFAULT_LIVE_RETENTION_POLICY,
): RetentionWindow[] {
  const records: Array<[RetentionWindow["recordType"], number]> = [
    ["observations", policy.observationsDays],
    ["alerts", policy.alertsDays],
    ["operational_events", policy.operationalEventsDays],
    ["delivery_records", policy.deliveryRecordsDays],
  ];
  return records.map(([recordType, days]) => ({
    recordType,
    cutoffAt: isoTimestampSchema.parse(new Date(now.getTime() - days * 86_400_000).toISOString()),
    action: "REVIEW_ONLY",
    policyVersion: policy.version,
  }));
}
