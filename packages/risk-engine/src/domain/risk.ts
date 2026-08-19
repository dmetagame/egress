import type { RiskVerdict } from "./schemas.js";

export const RISK_RANK = {
  NORMAL: 0,
  LOW: 1,
  MEDIUM: 2,
  HIGH: 3,
  CRITICAL: 4,
} as const;

export type RankedRiskLevel = keyof typeof RISK_RANK;

export function isRankedRiskLevel(
  level: RiskVerdict["riskLevel"],
): level is RankedRiskLevel {
  return level !== "INSUFFICIENT_EVIDENCE";
}

export function meetsRiskThreshold(
  actual: RiskVerdict["riskLevel"],
  required: RankedRiskLevel,
): boolean {
  return isRankedRiskLevel(actual) && RISK_RANK[actual] >= RISK_RANK[required];
}

export function isMaterialRisk(level: RiskVerdict["riskLevel"]): boolean {
  return level === "HIGH" || level === "CRITICAL";
}
