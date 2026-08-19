import { Check, LockKeyhole, X } from "lucide-react";
import type { PolicyCheck } from "@egress/risk-engine";
import { SectionHeading, StatusPill } from "./primitives";

const CHECK_ORDER = [
  "risk_threshold",
  "health_factor_trigger",
  "liquidity",
  "market_limits",
  "post_health_factor",
  "bounded_amounts",
  "policy_registered",
  "contract_simulation",
];

const labels: Record<string, string> = {
  risk_threshold: "Risk trigger",
  health_factor_trigger: "Position vulnerable",
  liquidity: "Liquidity sufficient",
  market_limits: "Slippage and price limits",
  post_health_factor: "Post-action health factor",
  bounded_amounts: "Policy amount limits",
  policy_registered: "Authorization valid",
  contract_simulation: "Simulation",
  evidence_valid: "Evidence validation",
  risk_attestation: "Risk attestation",
};

function orderedChecks(checks: PolicyCheck[]): PolicyCheck[] {
  const index = new Map(checks.map((check) => [check.check, check]));
  const selected = CHECK_ORDER.flatMap((key) => {
    const check = index.get(key);
    return check ? [check] : [];
  });
  if (selected.length >= 5) return selected;
  for (const check of checks) {
    if (!selected.includes(check) && selected.length < 8) selected.push(check);
  }
  return selected;
}

export function PolicyEvaluation({
  checks,
  allowed,
}: {
  checks: PolicyCheck[];
  allowed: boolean;
}) {
  const visibleChecks = orderedChecks(checks);
  return (
    <section className="policy-evaluation">
      <SectionHeading
        eyebrow="Deterministic policy"
        title="Why the action is allowed"
        description="Each gate is ordinary code and is revalidated immediately before submission."
        action={
          <StatusPill tone={allowed ? "success" : "warning"} icon={allowed ? LockKeyhole : X}>
            {allowed ? "EXECUTE" : "DO NOT EXECUTE"}
          </StatusPill>
        }
      />
      <div className="policy-check-grid">
        {visibleChecks.map((check) => (
          <article className={check.passed ? "check-passed" : "check-failed"} key={check.check}>
            <span className="check-icon" aria-hidden="true">
              {check.passed ? <Check size={15} /> : <X size={15} />}
            </span>
            <div>
              <strong>{labels[check.check] ?? check.check.replaceAll("_", " ")}</strong>
              <span>{check.actual}</span>
              <small>{check.reason}</small>
            </div>
          </article>
        ))}
      </div>
    </section>
  );
}
