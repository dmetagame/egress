import type { Metadata } from "next";
import { ArrowDown, BrainCircuit, Database, FileDiff, ShieldAlert } from "lucide-react";
import { PageHeader, SectionHeading, StatusPill } from "@/components/primitives";
import { SourceDiffView } from "@/components/risk-evidence";
import { getProductSnapshot } from "@/lib/server/snapshot";
import { formatDate, shortHash } from "@/lib/format";

export const metadata: Metadata = { title: "Risk intelligence" };

export default async function RiskPage() {
  const snapshot = await getProductSnapshot();
  const revision = snapshot.revisions.find((candidate) => candidate.revision === "C")!;
  const materialClaims = revision.evidence.filter((claim) => claim.materiality === "HIGH" || claim.materiality === "CRITICAL");
  return (
    <div className="page-stack">
      <PageHeader
        eyebrow="Evidence, not intuition"
        title="Risk intelligence"
        description="Trace every verdict from materiality classification back to an exact authoritative source revision."
        status={<StatusPill tone="danger" icon={ShieldAlert}>HIGH REPLAY EVENT</StatusPill>}
      />

      <section className="risk-architecture">
        <SectionHeading
          eyebrow="Interpretation boundary"
          title="Source to verdict"
          description="Only structured, evidence-validated fields leave the AI boundary."
        />
        <div className="risk-architecture-flow">
          {[
            { icon: Database, label: "OKX source", detail: "Allowlisted" },
            { icon: FileDiff, label: "Revision diff", detail: revision.diffIds[0] },
            { icon: BrainCircuit, label: "AI extraction", detail: `${materialClaims.length} material claims` },
            { icon: ShieldAlert, label: "Risk verdict", detail: "HIGH / 94%" },
          ].map(({ icon: Icon, label, detail }, index, array) => (
            <div className="risk-flow-segment" key={label}>
              <div>
                <Icon aria-hidden="true" size={19} />
                <strong>{label}</strong>
                <span>{detail}</span>
              </div>
              {index < array.length - 1 ? <ArrowDown aria-hidden="true" size={16} /> : null}
            </div>
          ))}
        </div>
      </section>

      <section className="risk-claims">
        <SectionHeading
          eyebrow="Material findings"
          title="What changed"
          description={`Revision ${revision.sourceRevisionIds[0]} changed two exit-relevant conditions.`}
          action={<StatusPill tone="danger">HIGH</StatusPill>}
        />
        <div className="claim-stack">
          {materialClaims.map((claim) => {
            const currentEvidence = claim.evidence.find((evidence) => evidence.side === "CURRENT") ?? claim.evidence[0];
            return (
              <article className="claim-record" key={claim.claimId}>
                <div className="claim-record-heading">
                  <div>
                    <span>{claim.claimType.replaceAll("_", " ")}</span>
                    <h3>{claim.changeSummary}</h3>
                  </div>
                  <StatusPill tone="danger" compact>{claim.materiality}</StatusPill>
                </div>
                <p>{claim.positionImpact}</p>
                <SourceDiffView
                  previous={claim.previousValue}
                  current={claim.currentValue}
                  source={currentEvidence.sourceUrl}
                  revision={currentEvidence.revisionId}
                  section={currentEvidence.location.section}
                  confidence={claim.confidence}
                />
              </article>
            );
          })}
        </div>
      </section>

      <section className="risk-audit-line">
        <span>Risk event <code>{revision.riskEventId}</code></span>
        <span>Diff <code>{shortHash(revision.diffIds[0])}</code></span>
        <span>Observed {formatDate(snapshot.market.position.observedAt)}</span>
        <span>Evidence status VALID</span>
      </section>
    </div>
  );
}
