import { ArrowUpRight, FileDiff, Fingerprint, Quote } from "lucide-react";
import type { ReplayApiResponse } from "@/lib/types";
import { formatDate, shortHash } from "@/lib/format";
import { SectionHeading, StatusPill } from "./primitives";

function riskTone(level: string): "neutral" | "success" | "warning" | "danger" {
  if (level === "HIGH" || level === "CRITICAL") return "danger";
  if (level === "MEDIUM") return "warning";
  if (level === "NORMAL" || level === "LOW") return "success";
  return "neutral";
}

export function RiskEvidencePanel({ response }: { response: ReplayApiResponse }) {
  const verdict = response.event.verdict;
  const primaryClaim = verdict.claims.find(
    (claim) => claim.materiality === "HIGH" || claim.materiality === "CRITICAL",
  ) ?? verdict.claims[0];
  const evidence = primaryClaim?.evidence.find((item) => item.side === "CURRENT") ?? primaryClaim?.evidence[0];

  return (
    <section className="risk-evidence-panel">
      <SectionHeading
        eyebrow="RWA risk intelligence"
        title="Evidence-backed finding"
        description="The verdict links directly to normalized source revisions and exact excerpts."
        action={<StatusPill tone={riskTone(verdict.riskLevel)}>{verdict.riskLevel}</StatusPill>}
      />

      <div className="finding-summary">
        <div className="finding-type">
          <Quote aria-hidden="true" size={18} />
          <span>{primaryClaim?.claimType.replaceAll("_", " ") ?? "NO MATERIAL CLAIM"}</span>
        </div>
        <h3>{primaryClaim?.changeSummary ?? verdict.summary}</h3>
        <p>{primaryClaim?.positionImpact ?? verdict.rationale}</p>
      </div>

      {primaryClaim ? (
        <SourceDiffView
          previous={primaryClaim.previousValue}
          current={primaryClaim.currentValue}
          source={evidence?.sourceUrl ?? response.snapshot.sourceUrl}
          revision={evidence?.revisionId ?? response.snapshot.revisionId}
          section={evidence?.location.section ?? "Source"}
          confidence={primaryClaim.confidence}
        />
      ) : null}

      <div className="evidence-metadata">
        <span>
          <Fingerprint aria-hidden="true" size={14} />
          Event <code>{response.event.riskEventId}</code>
        </span>
        <span>Confidence {(verdict.confidence * 100).toFixed(0)}%</span>
        <span>{formatDate(verdict.issuedAt)}</span>
        <span>{verdict.evidenceValidation.valid ? "Evidence validated" : "Evidence rejected"}</span>
      </div>
    </section>
  );
}

export function SourceDiffView({
  previous,
  current,
  source,
  revision,
  section,
  confidence,
}: {
  previous: string | null;
  current: string | null;
  source: string;
  revision: string;
  section: string;
  confidence: number;
}) {
  return (
    <div className="source-diff">
      <div className="source-diff-header">
        <span>
          <FileDiff aria-hidden="true" size={16} /> Source diff
        </span>
        <a href={source} target="_blank" rel="noreferrer">
          OKX / {section} <ArrowUpRight aria-hidden="true" size={14} />
        </a>
      </div>
      <div className="source-diff-columns">
        <div className="diff-previous">
          <span>Previous</span>
          <p>{previous ?? "No prior statement in the recorded baseline."}</p>
        </div>
        <div className="diff-current">
          <span>Current</span>
          <p>{current ?? "The prior statement was removed."}</p>
        </div>
      </div>
      <div className="source-diff-footer">
        <code title={revision}>{shortHash(revision)}</code>
        <span>{(confidence * 100).toFixed(0)}% claim confidence</span>
      </div>
    </div>
  );
}
