import type { Metadata } from "next";
import {
  Activity,
  BrainCircuit,
  Check,
  FileDiff,
  FlaskConical,
  Gavel,
  ShieldCheck,
  Zap,
} from "lucide-react";
import { PageHeader, SectionHeading, StatusPill } from "@/components/primitives";
import { getProductSnapshot } from "@/lib/server/snapshot";
import { formatDate, shortHash } from "@/lib/format";

export const metadata: Metadata = { title: "Activity" };

const icons = {
  SOURCE: FileDiff,
  RISK: BrainCircuit,
  POLICY: Gavel,
  SIMULATION: FlaskConical,
  EXECUTION: Zap,
  POSITION: ShieldCheck,
};

export default async function ActivityPage() {
  const snapshot = await getProductSnapshot();
  return (
    <div className="page-stack">
      <PageHeader
        eyebrow="Complete trace"
        title="Activity"
        description="Source, inference, policy, simulation, and transaction records remain linked by one risk event."
        status={<StatusPill tone="success" icon={Activity}>AUDIT COMPLETE</StatusPill>}
      />
      <section className="activity-ledger">
        <SectionHeading
          eyebrow="Recorded control loop"
          title="Event history"
          description="All timestamps and identifiers below come from the pinned Phase 5 artifact."
        />
        <div className="activity-list">
          {snapshot.activity.map((entry, index) => {
            const Icon = icons[entry.type];
            return (
              <article className={`activity-entry activity-${entry.status}`} key={entry.id}>
                <span className="activity-node" aria-hidden="true"><Icon size={16} /></span>
                <time>{formatDate(entry.timestamp)}</time>
                <div>
                  <span>{entry.type}</span>
                  <h3>{entry.title}</h3>
                  <p>{entry.detail}</p>
                  {entry.reference ? <code title={entry.reference}>{shortHash(entry.reference)}</code> : null}
                </div>
                <span className="activity-result"><Check size={14} /> {index === snapshot.activity.length - 1 ? "PROTECTED" : "RECORDED"}</span>
              </article>
            );
          })}
        </div>
      </section>
    </div>
  );
}
