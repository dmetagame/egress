import { BadgeCheck, Blocks, FileCheck2, Fingerprint, ShieldCheck } from "lucide-react";
import { getPhase11PublicEvidence } from "@/lib/server/phase11-evidence";
import { shortHash } from "@/lib/format";
import { StatusPill } from "./primitives";

export async function Phase11EvidencePanel() {
  const evidence = await getPhase11PublicEvidence();
  return (
    <section className="phase11-evidence-panel" id="phase11-evidence" aria-labelledby="phase11-evidence-title">
      <div className="phase11-evidence-heading">
        <div>
          <p className="eyebrow">Historical deployment proof</p>
          <h2 id="phase11-evidence-title">X Layer testnet / chain 1952</h2>
          <p>
            The compatibility stack is independently verified through finalized provenance. This record is read-only evidence;
            it does not represent a current position or submit a transaction.
          </p>
        </div>
        <StatusPill tone="success" icon={BadgeCheck}>26 / 26 FINALIZED</StatusPill>
      </div>
      <div className="phase11-evidence-grid">
        <EvidenceMetric icon={Blocks} label="Deployment anchor" value={`Block ${Number(evidence.deploymentAnchor.blockNumber).toLocaleString("en-US")}`} detail={shortHash(evidence.deploymentAnchor.transactionHash)} />
        <EvidenceMetric icon={ShieldCheck} label="Finality policy" value={evidence.finalityPolicy.publication} detail={`safe → ${evidence.finalityPolicy.finalizedTag}`} />
        <EvidenceMetric icon={FileCheck2} label="Runtime verification" value={evidence.runtimeVerification.status} detail={`${evidence.runtimeVerification.verificationSource} / 26 records`} />
        <EvidenceMetric icon={Fingerprint} label="Reconciled re-inclusions" value={evidence.reIncludedSequences.join(", ")} detail="unsafe head → canonical finalized history" />
      </div>
      <div className="phase11-evidence-foot">
        <span>Manifest {shortHash(evidence.manifestHash)}</span>
        <span>Journal {shortHash(evidence.originalJournalSha256.replace(/^sha256:/u, ""))}</span>
        <span>Reconciliation {shortHash(evidence.reconciliationArtifactSha256.replace(/^sha256:/u, ""))}</span>
        <a href="/api/deployment/phase11">View machine-readable evidence</a>
      </div>
    </section>
  );
}

function EvidenceMetric({
  icon: Icon,
  label,
  value,
  detail,
}: {
  icon: typeof Blocks;
  label: string;
  value: string;
  detail: string;
}) {
  return (
    <div className="phase11-evidence-metric">
      <Icon aria-hidden="true" size={17} />
      <span>{label}</span>
      <strong>{value}</strong>
      <small>{detail}</small>
    </div>
  );
}
