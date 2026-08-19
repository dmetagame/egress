import type {
  EvidenceReference,
  ExtractedClaim,
  ModelRiskAnalysis,
  SourceSnapshot,
} from "../domain/schemas.js";
import { RISK_RANK, type RankedRiskLevel } from "../domain/risk.js";
import { shortId } from "../domain/hash.js";
import type { AnalysisInput, AnalysisResult, RiskAnalyzer } from "./analyzer.js";

const MATERIAL_PATTERNS: Array<{
  pattern: RegExp;
  level: RankedRiskLevel;
}> = [
  {
    pattern:
      /(?:not|no longer) (?:fully )?backed|backing (?:shortfall|below 1:1)|insufficient reserves|unable to redeem|not redeemable|redemptions? (?:are |is )?suspended indefinitely/i,
    level: "CRITICAL",
  },
  {
    pattern:
      /redemptions? (?:may be |can be |are |is )?(?:suspended|restricted)|withdrawals? (?:may be |can be |are |is )?(?:suspended|restricted)|conversion (?:may be |can be |is )?(?:suspended|restricted)|subject to (?:liquidity|reserve) availability|material delay/i,
    level: "HIGH",
  },
  {
    pattern:
      /maintenance window|processing (?:time|delay)|temporary delay|new fee|fees? (?:apply|increase)|eligibility (?:change|restriction)|operational change/i,
    level: "MEDIUM",
  },
];

const CLAIM_PATTERNS: Array<{
  pattern: RegExp;
  type: ExtractedClaim["claimType"];
}> = [
  { pattern: /1:1|fully backed|backing|underlying asset/i, type: "BACKING" },
  { pattern: /reserve/i, type: "RESERVE_ASSETS" },
  { pattern: /custod/i, type: "CUSTODY" },
  { pattern: /redeem/i, type: "REDEMPTION" },
  { pattern: /convert/i, type: "CONVERSION" },
  { pattern: /withdraw/i, type: "WITHDRAWAL" },
  { pattern: /stak/i, type: "STAKING" },
  { pattern: /audit/i, type: "AUDIT" },
  { pattern: /proof of reserves/i, type: "PROOF_OF_RESERVES" },
  { pattern: /suspend/i, type: "SUSPENSION" },
  { pattern: /delay|processing time/i, type: "DELAY" },
  { pattern: /fee/i, type: "FEE" },
  { pattern: /eligib/i, type: "ELIGIBILITY" },
  { pattern: /term/i, type: "TERMS" },
];

function lineForText(snapshot: SourceSnapshot, text: string) {
  return snapshot.normalized.lines.find((line) => line.text === text);
}

function evidence(
  snapshot: SourceSnapshot,
  text: string,
  side: EvidenceReference["side"],
): EvidenceReference | null {
  const line = lineForText(snapshot, text);
  if (!line) return null;
  const base = {
    sourceId: snapshot.sourceId,
    revisionId: snapshot.revisionId,
    side,
    excerpt: text,
    line: line.line,
  };
  return {
    evidenceId: shortId("evidence", base),
    sourceId: snapshot.sourceId,
    sourceUrl: snapshot.sourceUrl,
    revisionId: snapshot.revisionId,
    contentHash: snapshot.contentHash,
    side,
    excerpt: text,
    location: { section: line.section, startLine: line.line, endLine: line.line },
  };
}

function classifyClaimType(text: string): ExtractedClaim["claimType"] {
  return CLAIM_PATTERNS.find((candidate) => candidate.pattern.test(text))?.type ?? "OTHER";
}

function deteriorationLevel(text: string): RankedRiskLevel {
  return MATERIAL_PATTERNS.find((candidate) => candidate.pattern.test(text))?.level ?? "LOW";
}

function maxLevel(levels: RankedRiskLevel[]): RankedRiskLevel {
  return levels.reduce(
    (highest, candidate) =>
      RISK_RANK[candidate] > RISK_RANK[highest] ? candidate : highest,
    "NORMAL",
  );
}

export class DeterministicReplayAnalyzer implements RiskAnalyzer {
  constructor(private readonly now: () => Date = () => new Date()) {}

  async analyze(input: AnalysisInput): Promise<AnalysisResult> {
    const claims: ExtractedClaim[] = [];

    if (!input.previous) {
      const baseline = input.current.normalized.lines.find((line) =>
        /fully backed|1:1 backed|securely held in .*custody/i.test(line.text),
      );
      if (baseline) {
        const currentEvidence = evidence(input.current, baseline.text, "CURRENT");
        if (currentEvidence) {
          const claimBase = {
            type: classifyClaimType(baseline.text),
            current: baseline.text,
            revision: input.current.revisionId,
          };
          claims.push({
            claimId: shortId("claim", claimBase),
            claimType: classifyClaimType(baseline.text),
            subject: /xbeth/i.test(baseline.text) ? "XBETH" : "X_RWA",
            statement: baseline.text,
            previousValue: null,
            currentValue: baseline.text,
            changeKind: "ADDED",
            changeSummary: "Initial authoritative baseline was recorded.",
            materiality: "NORMAL",
            positionImpact: "No deterioration is evidenced by the initial baseline alone.",
            evidence: [currentEvidence],
            confidence: 0.98,
          });
        }
      }
    } else {
      for (const hunk of input.diff.hunks) {
        const pairCount = Math.max(hunk.removedLines.length, hunk.addedLines.length);
        for (let pairIndex = 0; pairIndex < pairCount; pairIndex += 1) {
          const removed = hunk.removedLines[pairIndex];
          const added = hunk.addedLines[pairIndex];
          const combined = `${removed ?? ""} ${added ?? ""}`;
          if (!CLAIM_PATTERNS.some((candidate) => candidate.pattern.test(combined))) continue;

          const level = deteriorationLevel(added ?? "");
          const references: EvidenceReference[] = [];
          if (removed) {
            const reference = evidence(input.previous, removed, "PREVIOUS");
            if (reference) references.push(reference);
          }
          if (added) {
            const reference = evidence(input.current, added, "CURRENT");
            if (reference) references.push(reference);
          }
          if (references.length === 0) continue;

          const claimBase = {
            type: classifyClaimType(combined),
            previous: removed ?? null,
            current: added ?? null,
            diff: input.diff.diffId,
            pairIndex,
          };
          claims.push({
            claimId: shortId("claim", claimBase),
            claimType: classifyClaimType(combined),
            subject: /xbeth/i.test(combined) ? "XBETH" : "X_RWA",
            statement: added ?? removed ?? "A source statement changed.",
            previousValue: removed ?? null,
            currentValue: added ?? null,
            changeKind: removed && added ? "MODIFIED" : added ? "ADDED" : "REMOVED",
            changeSummary:
              removed && added
                ? "Authoritative wording changed."
                : added
                  ? "A new condition was added."
                  : "A prior assurance was removed.",
            materiality: level,
            positionImpact:
              level === "HIGH" || level === "CRITICAL"
                ? "The changed condition may impair timely exit from an xBETH-backed leveraged position."
                : level === "MEDIUM"
                  ? "The changed condition warrants monitoring but does not itself prove exit impairment."
                  : "No material impairment is evidenced by this change.",
            evidence: references,
            confidence: 0.94,
          });
        }
      }
    }

    const proposedRiskLevel = maxLevel(claims.map((claim) => claim.materiality));
    const analysis: ModelRiskAnalysis = {
      proposedRiskLevel,
      summary:
        claims.length === 0
          ? "No risk-relevant authoritative change was found."
          : `${claims.length} evidence-backed risk-relevant claim${claims.length === 1 ? "" : "s"} found.`,
      rationale:
        proposedRiskLevel === "HIGH" || proposedRiskLevel === "CRITICAL"
          ? "The changed source language explicitly deteriorates redemption, withdrawal, conversion, custody, or backing conditions."
          : "The observed source changes do not establish a material exit impairment.",
      claims,
      conflictingEvidence: false,
      conflictExplanation: null,
      confidence: claims.length === 0 ? 0.9 : Math.min(...claims.map((claim) => claim.confidence)),
    };

    return {
      analysis,
      metadata: {
        analyzer: "DETERMINISTIC_REPLAY",
        provider: "egress",
        model: "evidence-pattern-reference-analyzer",
        modelVersion: "1",
        promptVersion: "not-applicable",
        analyzedAt: this.now().toISOString(),
      },
    };
  }
}
