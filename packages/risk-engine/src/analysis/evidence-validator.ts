import type { AnalysisInput } from "./analyzer.js";
import type {
  EvidenceReference,
  EvidenceValidation,
  ModelRiskAnalysis,
  SourceSnapshot,
} from "../domain/schemas.js";
import { RISK_RANK } from "../domain/risk.js";

function normalizeText(value: string): string {
  return value.replace(/\s+/g, " ").trim().toLowerCase();
}

const NON_CONTENT_WORDS = new Set([
  "a",
  "an",
  "and",
  "are",
  "as",
  "at",
  "be",
  "by",
  "for",
  "from",
  "in",
  "into",
  "is",
  "it",
  "may",
  "of",
  "on",
  "or",
  "that",
  "the",
  "their",
  "this",
  "to",
  "under",
  "was",
  "were",
  "with",
]);

function contentTokens(value: string): string[] {
  return (normalizeText(value).match(/[\p{L}\p{N}]{3,}/gu) ?? []).filter(
    (token) => !NON_CONTENT_WORDS.has(token),
  );
}

function isGroundedInEvidence(statement: string, evidenceText: string): boolean {
  const statementTokens = contentTokens(statement);
  if (statementTokens.length === 0) return false;
  const evidenceTokens = new Set(contentTokens(evidenceText));
  return statementTokens.every((token) => evidenceTokens.has(token));
}

function textContainsRiskMeaning(value: string): boolean {
  return /back|reserve|custod|redeem|convert|withdraw|stake|audit|proof|suspend|restrict|settle|delay|fee|eligib|term/i.test(
    value,
  );
}

function valueIsSupported(value: string, evidenceText: string): boolean {
  const normalizedValue = normalizeText(value);
  const normalizedEvidence = normalizeText(evidenceText);
  if (normalizedEvidence.includes(normalizedValue)) return true;
  return isGroundedInEvidence(value, evidenceText);
}

function polarity(value: string): "POSITIVE" | "NEGATIVE" | "NEUTRAL" {
  const text = normalizeText(value);
  const positive =
    /fully backed|1:1|securely held|normal operating|available for redemption|redemptions? (?:remain|are) available|can redeem|redeemable|no restriction/.test(
      text,
    );
  const negative =
    /not fully backed|not backed|backing shortfall|insufficient reserve|unable to redeem|not redeemable|suspend|restricted|unavailable|subject to reserve|subject to liquidity|material delay|stressed market/.test(
      text,
    );
  if (positive && !negative) return "POSITIVE";
  if (negative) return "NEGATIVE";
  return "NEUTRAL";
}

function currentClaimText(claim: ModelRiskAnalysis["claims"][number]): string {
  const currentEvidence = claim.evidence
    .filter((reference) => reference.side === "CURRENT" || reference.side === "CORROBORATING")
    .map((reference) => reference.excerpt);
  return [claim.statement, claim.currentValue ?? "", ...currentEvidence].join(" ");
}

function resolveSnapshot(
  reference: EvidenceReference,
  input: AnalysisInput,
): SourceSnapshot | null {
  const candidates = [input.current, input.previous, ...input.corroborating].filter(
    (snapshot): snapshot is SourceSnapshot => snapshot !== null,
  );
  return candidates.find((snapshot) => snapshot.revisionId === reference.revisionId) ?? null;
}

function referenceMatchesSide(
  reference: EvidenceReference,
  input: AnalysisInput,
): boolean {
  if (reference.side === "PREVIOUS") {
    return reference.revisionId === input.previous?.revisionId;
  }
  if (reference.side === "CURRENT") {
    return reference.revisionId === input.current.revisionId;
  }
  return reference.revisionId !== input.current.revisionId && reference.revisionId !== input.previous?.revisionId;
}

function evidenceIntersectsDiff(reference: EvidenceReference, input: AnalysisInput): boolean {
  return input.diff.hunks.some((hunk) => {
    if (reference.revisionId === input.current.revisionId) {
      return (
        hunk.newStartLine > 0 &&
        reference.location.endLine >= hunk.newStartLine &&
        reference.location.startLine <= hunk.newEndLine
      );
    }
    if (reference.revisionId === input.previous?.revisionId) {
      return (
        hunk.oldStartLine > 0 &&
        reference.location.endLine >= hunk.oldStartLine &&
        reference.location.startLine <= hunk.oldEndLine
      );
    }
    return false;
  });
}

export function validateEvidence(
  analysis: ModelRiskAnalysis,
  input: AnalysisInput,
): EvidenceValidation {
  const errors: string[] = [];
  const warnings: string[] = [];
  const validatedEvidenceIds: string[] = [];
  const rejectedEvidenceIds: string[] = [];
  const seenEvidenceIds = new Set<string>();
  const validatedReferences = new Map<string, EvidenceReference>();

  for (const claim of analysis.claims) {
    let hasChangedEvidence = claim.changeKind === "UNCHANGED" || input.diff.kind === "INITIAL";
    let hasPrevious = false;
    let hasCurrent = false;

    for (const reference of claim.evidence) {
      if (seenEvidenceIds.has(reference.evidenceId)) {
        errors.push(`Duplicate evidence id ${reference.evidenceId}.`);
        rejectedEvidenceIds.push(reference.evidenceId);
        continue;
      }
      seenEvidenceIds.add(reference.evidenceId);
      const snapshot = resolveSnapshot(reference, input);
      if (!snapshot) {
        errors.push(`Evidence ${reference.evidenceId} references an unavailable revision.`);
        rejectedEvidenceIds.push(reference.evidenceId);
        continue;
      }
      if (
        reference.sourceId !== snapshot.sourceId ||
        reference.sourceUrl !== snapshot.sourceUrl ||
        reference.contentHash !== snapshot.contentHash
      ) {
        errors.push(`Evidence ${reference.evidenceId} source metadata does not match its revision.`);
        rejectedEvidenceIds.push(reference.evidenceId);
        continue;
      }
      if (!referenceMatchesSide(reference, input)) {
        errors.push(`Evidence ${reference.evidenceId} side does not match its cited revision.`);
        rejectedEvidenceIds.push(reference.evidenceId);
        continue;
      }
      if (
        reference.location.startLine < 1 ||
        reference.location.endLine < reference.location.startLine ||
        reference.location.endLine > snapshot.normalized.lines.length
      ) {
        errors.push(`Evidence ${reference.evidenceId} has an invalid line range.`);
        rejectedEvidenceIds.push(reference.evidenceId);
        continue;
      }

      const lines = snapshot.normalized.lines.slice(
        reference.location.startLine - 1,
        reference.location.endLine,
      );
      const excerpt = normalizeText(lines.map((line) => line.text).join(" "));
      if (excerpt !== normalizeText(reference.excerpt)) {
        errors.push(`Evidence ${reference.evidenceId} excerpt is not verbatim at the cited location.`);
        rejectedEvidenceIds.push(reference.evidenceId);
        continue;
      }
      if (!lines.every((line) => line.section === reference.location.section)) {
        errors.push(`Evidence ${reference.evidenceId} section does not match the cited lines.`);
        rejectedEvidenceIds.push(reference.evidenceId);
        continue;
      }

      hasPrevious ||= reference.revisionId === input.previous?.revisionId;
      hasCurrent ||= reference.revisionId === input.current.revisionId;
      hasChangedEvidence ||= evidenceIntersectsDiff(reference, input);
      validatedEvidenceIds.push(reference.evidenceId);
      validatedReferences.set(reference.evidenceId, reference);
    }

    if (!hasChangedEvidence) {
      errors.push(`Claim ${claim.claimId} does not cite a changed line.`);
    }
    if ((claim.changeKind === "ADDED" || claim.changeKind === "MODIFIED") && claim.currentValue === null) {
      errors.push(`Claim ${claim.claimId} must provide a current value for ${claim.changeKind.toLowerCase()} evidence.`);
    }
    if ((claim.changeKind === "REMOVED" || claim.changeKind === "MODIFIED") && claim.previousValue === null) {
      errors.push(`Claim ${claim.claimId} must provide a previous value for ${claim.changeKind.toLowerCase()} evidence.`);
    }
    if (claim.changeKind === "MODIFIED" && (!hasPrevious || !hasCurrent)) {
      errors.push(`Modified claim ${claim.claimId} must cite previous and current revisions.`);
    }
    const claimEvidence = claim.evidence
      .map((item) => validatedReferences.get(item.evidenceId))
      .filter((item): item is EvidenceReference => item !== undefined);
    const evidenceText = claimEvidence.map((item) => item.excerpt).join(" ");
    if (claim.previousValue && !valueIsSupported(claim.previousValue, evidenceText)) {
      errors.push(`Claim ${claim.claimId} previous value is unsupported by its evidence.`);
    }
    if (claim.currentValue && !valueIsSupported(claim.currentValue, evidenceText)) {
      errors.push(`Claim ${claim.claimId} current value is unsupported by its evidence.`);
    }
    if (!isGroundedInEvidence(claim.statement, evidenceText)) {
      errors.push(`Claim ${claim.claimId} statement contains facts not present in its cited evidence.`);
    }
  }

  if ((analysis.proposedRiskLevel === "HIGH" || analysis.proposedRiskLevel === "CRITICAL") && analysis.claims.length === 0) {
    errors.push("A material verdict requires at least one evidence-backed claim.");
  }

  const rankedClaims = analysis.claims.filter(
    (claim) => claim.materiality !== "NORMAL" || analysis.proposedRiskLevel === "NORMAL",
  );
  const maximumClaimRank = rankedClaims.reduce(
    (rank, claim) => Math.max(rank, RISK_RANK[claim.materiality]),
    0,
  );
  if (
    analysis.proposedRiskLevel !== "INSUFFICIENT_EVIDENCE" &&
    RISK_RANK[analysis.proposedRiskLevel] > maximumClaimRank
  ) {
    errors.push("Proposed risk level exceeds the materiality of supported claims.");
  }

  const diffContainsRiskMeaning = input.diff.hunks.some((hunk) =>
    [...hunk.removedLines, ...hunk.addedLines].some(textContainsRiskMeaning),
  );
  if (
    input.diff.kind === "CHANGED" &&
    !input.diff.cosmeticOnly &&
    diffContainsRiskMeaning &&
    analysis.claims.length === 0
  ) {
    errors.push("A risk-relevant semantic diff cannot be dismissed without an evidence-backed claim.");
  }

  if (analysis.conflictingEvidence) {
    errors.push(analysis.conflictExplanation ?? "The analyzer reported conflicting evidence.");
  }

  const corroboratingPolarityByTopic = new Map<
    string,
    Array<{ sourceId: string; polarity: "POSITIVE" | "NEGATIVE" }>
  >();
  for (const snapshot of input.corroborating) {
    for (const line of snapshot.normalized.lines) {
      const linePolarity = polarity(line.text);
      if (linePolarity === "NEUTRAL") continue;
      const topics: string[] = [];
      if (/back|reserve/i.test(line.text)) topics.push("BACKING");
      if (/redeem|redemption|convert|withdraw|suspend|delay/i.test(line.text)) topics.push("EXIT");
      if (/custod/i.test(line.text)) topics.push("CUSTODY");
      for (const topic of topics) {
        const values = corroboratingPolarityByTopic.get(topic) ?? [];
        values.push({ sourceId: snapshot.sourceId, polarity: linePolarity });
        corroboratingPolarityByTopic.set(topic, values);
      }
    }
  }

  for (const claim of analysis.claims) {
    const claimPolarity = polarity(currentClaimText(claim));
    if (claimPolarity === "NEUTRAL") continue;
    const topic =
      claim.claimType === "BACKING" || claim.claimType === "RESERVE_ASSETS"
        ? "BACKING"
        : claim.claimType === "CUSTODY"
          ? "CUSTODY"
          : ["REDEMPTION", "CONVERSION", "WITHDRAWAL", "SUSPENSION", "DELAY"].includes(
                claim.claimType,
              )
            ? "EXIT"
            : null;
    if (!topic) continue;
    const contradiction = (corroboratingPolarityByTopic.get(topic) ?? []).find(
      (candidate) =>
        candidate.polarity !== claimPolarity &&
        !claim.evidence.some((reference) => reference.sourceId === candidate.sourceId),
    );
    if (contradiction) {
      errors.push(
        `Claim ${claim.claimId} conflicts with ${topic.toLowerCase()} language in corroborating source ${contradiction.sourceId}.`,
      );
    }
  }

  const currentClaims = analysis.claims.filter((claim) =>
    claim.evidence.some((reference) =>
      validatedReferences.has(reference.evidenceId) &&
      (reference.side === "CURRENT" || reference.side === "CORROBORATING"),
    ),
  );
  for (let leftIndex = 0; leftIndex < currentClaims.length; leftIndex += 1) {
    const left = currentClaims[leftIndex]!;
    const leftText = currentClaimText(left);
    const leftPolarity = polarity(leftText);
    if (leftPolarity === "NEUTRAL") continue;
    for (let rightIndex = leftIndex + 1; rightIndex < currentClaims.length; rightIndex += 1) {
      const right = currentClaims[rightIndex]!;
      if (left.claimType !== right.claimType || left.subject !== right.subject) continue;
      const leftSources = new Set(
        left.evidence
          .filter((item) => validatedReferences.has(item.evidenceId))
          .map((item) => item.sourceId),
      );
      const rightSources = new Set(
        right.evidence
          .filter((item) => validatedReferences.has(item.evidenceId))
          .map((item) => item.sourceId),
      );
      if ([...leftSources].some((sourceId) => rightSources.has(sourceId))) continue;
      const rightText = currentClaimText(right);
      const rightPolarity = polarity(rightText);
      if (rightPolarity !== "NEUTRAL" && leftPolarity !== rightPolarity) {
        errors.push(
          `Claims ${left.claimId} and ${right.claimId} contain contradictory ${left.claimType.toLowerCase()} evidence from independent sources.`,
        );
      }
    }
  }

  return {
    valid: errors.length === 0 && !analysis.conflictingEvidence,
    validatedEvidenceIds,
    rejectedEvidenceIds,
    errors,
    warnings,
  };
}
