import type {
  AnalyzerMetadata,
  EvidenceValidation,
  ModelRiskAnalysis,
  RiskVerdict,
  SourceDiff,
  SourceSnapshot,
} from "../domain/schemas.js";
import { isMaterialRisk } from "../domain/risk.js";
import { shortId } from "../domain/hash.js";

export function createRiskVerdict(input: {
  riskEventId: string;
  analysis: ModelRiskAnalysis;
  metadata: AnalyzerMetadata;
  validation: EvidenceValidation;
  current: SourceSnapshot;
  diff: SourceDiff;
  issuedAt: Date;
  ttlSeconds: number;
}): RiskVerdict {
  const riskLevel = input.validation.valid
    ? input.analysis.proposedRiskLevel
    : "INSUFFICIENT_EVIDENCE";
  const issuedAt = input.issuedAt.toISOString();
  const expiresAt = new Date(input.issuedAt.getTime() + input.ttlSeconds * 1_000).toISOString();
  const trigger =
    [...input.analysis.claims]
      .sort((a, b) => b.confidence - a.confidence)[0]
      ?.changeSummary.trim() ?? "No evidence-backed material trigger.";
  const verdictBase = {
    riskEventId: input.riskEventId,
    riskLevel,
    revisionId: input.current.revisionId,
    diffId: input.diff.diffId,
    issuedAt,
  };

  return {
    verdictId: shortId("verdict", verdictBase),
    riskEventId: input.riskEventId,
    riskLevel,
    material: input.validation.valid && isMaterialRisk(riskLevel),
    trigger,
    summary: input.validation.valid
      ? input.analysis.summary
      : "Evidence validation failed; no execution may be authorized.",
    rationale: input.validation.valid
      ? input.analysis.rationale
      : input.validation.errors.join(" ") || "Evidence was insufficient or conflicting.",
    sourceRevisionIds: [
      input.current.revisionId,
      ...new Set(input.analysis.claims.flatMap((claim) => claim.evidence.map((item) => item.revisionId))),
    ].filter((value, index, values) => values.indexOf(value) === index),
    diffIds: [input.diff.diffId],
    claims: input.analysis.claims,
    evidenceValidation: input.validation,
    confidence: input.validation.valid ? input.analysis.confidence : 0,
    issuedAt,
    expiresAt,
    analyzer: input.metadata,
  };
}
