import Link from "next/link";
import {
  Activity,
  ArrowRight,
  BadgeCheck,
  Blocks,
  BrainCircuit,
  Check,
  ChevronDown,
  CircleGauge,
  Clock3,
  Droplets,
  FileCheck2,
  FlaskConical,
  Gauge,
  LockKeyhole,
  Radio,
  ShieldAlert,
  ShieldCheck,
  Waves,
} from "lucide-react";
import type { LucideIcon } from "lucide-react";
import type { LiveApiResponse, LiveCurrentApiResponse } from "@/lib/types";
import { bps, formatDate, healthFactor, shortHash, tokenAmount } from "@/lib/format";
import { HealthBoundary } from "./health-boundary";
import { Reveal, Stagger, StateTransition } from "./motion-primitives";
import { StatusPill, type Tone } from "./primitives";

type ProtectionState = {
  key: string;
  label: string;
  headline: string;
  description: string;
  tone: Tone;
  stage: number;
};

type Signal = {
  title: string;
  status: string;
  description: string;
  evidence: string;
  tone: Tone;
  icon: LucideIcon;
};

export function ProtectionDashboard({
  live,
  current,
}: {
  live: LiveApiResponse;
  current: LiveCurrentApiResponse | null;
}) {
  const snapshot = live.snapshot;
  const available = Boolean(snapshot && live.status === "AVAILABLE" && (!current || current.status === "COMPLETE"));
  const state = resolveProtectionState(live, available);
  const health = snapshot ? Number(healthFactor(snapshot.aave.position.healthFactorWad, 6)) : null;
  const trigger = snapshot?.policy.policy ? Number(healthFactor(snapshot.policy.policy.triggerHealthFactorWad, 6)) : null;
  const target = snapshot?.policy.policy ? Number(healthFactor(snapshot.policy.policy.targetPostHealthFactorWad, 6)) : null;
  const signals = signalRecords(live, available);

  return (
    <section className={`protection-dashboard protection-tone-${state.tone}`} aria-labelledby="protection-state-title">
      <div className="protection-dashboard-glow" aria-hidden="true" />
      <StateTransition className="protection-state-hero" stateKey={state.key}>
        <div className="protection-state-copy" data-state-item>
          <div className="protection-state-label">
            <span className="state-beacon" aria-hidden="true"><span /></span>
            <span>Current protection state</span>
            <StatusPill tone={state.tone}>{state.label}</StatusPill>
          </div>
          <h2 id="protection-state-title">{state.headline}</h2>
          <p>{state.description}</p>
          <div className="protection-state-actions">
            <a className="button button-primary" href="#live-evidence">Inspect verified evidence <ArrowRight aria-hidden="true" size={15} /></a>
            <Link className="button button-quiet" href="/protection">Review protection policy</Link>
          </div>
        </div>

        <div className="protection-summary" data-state-item>
          <span className="summary-eyebrow">POSITION SNAPSHOT</span>
          <div className="summary-metrics">
            <div>
              <span>Collateral</span>
              <strong>{snapshot ? `${tokenAmount(snapshot.aave.position.collateralBalanceWei, 3)} xBETH` : "Unavailable"}</strong>
            </div>
            <div>
              <span>Debt</span>
              <strong>{snapshot ? `${tokenAmount(snapshot.aave.position.debtBalanceWei, 3)} xETH` : "Unavailable"}</strong>
            </div>
            <div>
              <span>Risk</span>
              <strong>{snapshot?.rwa.riskLevel ?? "Unavailable"}</strong>
            </div>
          </div>
          <div className="summary-provenance">
            <span><Blocks aria-hidden="true" size={13} /> {snapshot ? `Block ${Number(snapshot.chain.blockNumber).toLocaleString("en-US")}` : "Block unavailable"}</span>
            <span><Clock3 aria-hidden="true" size={13} /> {snapshot ? formatDate(snapshot.generatedAt) : "Observation unavailable"}</span>
            {snapshot ? <code>{shortHash(snapshot.snapshotHash)}</code> : null}
          </div>
        </div>
      </StateTransition>

      <Reveal className="dashboard-health-panel">
        <HealthBoundary value={health} trigger={trigger} target={target} observedLabel="Observed position" />
      </Reveal>

      <div className="protection-state-machine" aria-label="Egress protection state machine">
        {[
          ["Monitor", Radio],
          ["Detect", BrainCircuit],
          ["Validate", FileCheck2],
          ["Simulate", FlaskConical],
          ["Protect", ShieldCheck],
        ].map(([label, Icon], index) => {
          const StateIcon = Icon as LucideIcon;
          const completed = index < state.stage;
          const active = index === state.stage;
          return (
            <div className={completed ? "is-complete" : active ? "is-active" : "is-pending"} key={String(label)}>
              <span className="state-machine-node" aria-hidden="true">
                {completed ? <Check size={14} /> : <StateIcon size={15} />}
              </span>
              <strong>{String(label)}</strong>
              <small>{stageDetail(String(label), state, snapshot)}</small>
            </div>
          );
        })}
      </div>

      <section className="risk-signal-section" aria-labelledby="risk-signals-title">
        <header className="risk-signal-heading">
          <div>
            <p className="eyebrow">Independent checks</p>
            <h2 id="risk-signals-title">What Egress is watching</h2>
            <p>Each signal is derived from the current verified snapshot. Expand a signal to inspect the evidence basis.</p>
          </div>
          <StatusPill tone={available ? "success" : "warning"} icon={available ? BadgeCheck : ShieldAlert}>
            {available ? "SNAPSHOT COMPLETE" : "INCOMPLETE DATA"}
          </StatusPill>
        </header>
        <Stagger className="risk-signal-grid">
          {signals.map((signal) => (
            <details className={`risk-signal-card signal-tone-${signal.tone}`} data-stagger-item key={signal.title}>
              <summary>
                <span className="signal-icon" aria-hidden="true"><signal.icon size={17} /></span>
                <span className="signal-copy"><b>{signal.title}</b><strong>{signal.status}</strong></span>
                <ChevronDown className="signal-chevron" aria-hidden="true" size={15} />
              </summary>
              <div className="signal-detail">
                <p>{signal.description}</p>
                <span>{signal.evidence}</span>
              </div>
            </details>
          ))}
        </Stagger>
      </section>
    </section>
  );
}

function resolveProtectionState(live: LiveApiResponse, available: boolean): ProtectionState {
  const snapshot = live.snapshot;
  if (!available || !snapshot) {
    return {
      key: "unavailable",
      label: "STATUS UNAVAILABLE",
      headline: "Egress cannot determine whether this position is safe.",
      description: "A complete current snapshot is required before Egress presents a risk, readiness, or protection state. Partial data remains visible as evidence only.",
      tone: "warning",
      stage: 0,
    };
  }
  const risk = snapshot.rwa.riskLevel;
  const executable = snapshot.executionPreview.plan.executable;
  const allowed = snapshot.executionPreview.policyEvaluation.allowed;
  const healthBoundaryActive = snapshot.policy.policy
    ? BigInt(snapshot.aave.position.healthFactorWad) <= BigInt(snapshot.policy.policy.triggerHealthFactorWad)
    : false;
  if (risk === "HIGH" || risk === "CRITICAL") {
    if (executable && allowed) {
      return {
        key: `armed-${risk}`,
        label: "PROTECTION ARMED",
        headline: "Risk is present. A bounded protection path has passed validation.",
        description: "The current read-only preview is executable and policy-permitted. No transaction has been submitted from this interface.",
        tone: "danger",
        stage: 4,
      };
    }
    return {
      key: `blocked-${risk}`,
      label: "AT RISK / BLOCKED",
      headline: "Risk is present, but Egress cannot establish a safe protection path.",
      description: "At least one policy, market, evidence, or simulation condition is blocking readiness. No action is presented as executable.",
      tone: "danger",
      stage: 2,
    };
  }
  if (healthBoundaryActive) {
    return {
      key: `health-boundary-${risk ?? "unknown"}`,
      label: "HEALTH BOUNDARY ACTIVE",
      headline: "Health is inside the protection boundary.",
      description: "The observed health factor is below the configured trigger. Egress keeps the response blocked until every deterministic risk, policy, liquidity, and post-action check passes.",
      tone: "danger",
      stage: 2,
    };
  }
  if (risk === "MEDIUM") {
    return {
      key: "aware-medium",
      label: "AWARE",
      headline: "The position is being watched more closely.",
      description: "A material warning is present, but the configured protection trigger has not been met. Monitoring continues without an execution claim.",
      tone: "warning",
      stage: 1,
    };
  }
  return {
    key: `safe-${risk ?? "unknown"}`,
    label: "SAFE / MONITORING",
    headline: "No material protection trigger is active.",
    description: "Egress is observing position health, xBETH evidence, oracle state, and executable liquidity. The system remains ready to validate a bounded route if conditions deteriorate.",
    tone: "success",
    stage: 0,
  };
}

function signalRecords(live: LiveApiResponse, available: boolean): Signal[] {
  const snapshot = live.snapshot;
  if (!available || !snapshot) {
    const reason = live.reasons[0] ?? "A complete current snapshot is unavailable.";
    return [
      signal("xBETH backing / redemption", "Unavailable", "No backing-risk state is inferred from incomplete data.", reason, "neutral", Waves),
      signal("Aave position health", "Unavailable", "No health-factor safety claim is made without a complete account snapshot.", reason, "neutral", CircleGauge),
      signal("Executable liquidity", "Unavailable", "No swap or deleveraging route is inferred.", reason, "neutral", Droplets),
      signal("Oracle freshness", "Unavailable", "Required oracle evidence is incomplete.", reason, "neutral", Activity),
      signal("Policy readiness", "Unavailable", "Policy eligibility cannot be established from partial state.", reason, "neutral", LockKeyhole),
      signal("Simulation", "Not available", "A protection preview is not presented until all required inputs exist.", "No transaction submitted.", "neutral", FlaskConical),
    ];
  }

  const risk = snapshot.rwa.riskLevel ?? "UNAVAILABLE";
  const healthValue = healthFactor(snapshot.aave.position.healthFactorWad);
  const policy = snapshot.policy.policy;
  const trigger = policy ? healthFactor(policy.triggerHealthFactorWad) : null;
  const healthTone: Tone = policy && BigInt(snapshot.aave.position.healthFactorWad) <= BigInt(policy.triggerHealthFactorWad)
    ? "danger"
    : "success";
  const oracleFresh = snapshot.oracle.xbEth.fresh && snapshot.oracle.xeth.fresh;
  const planAllowed = snapshot.executionPreview.plan.executable && snapshot.executionPreview.policyEvaluation.allowed;

  return [
    signal(
      "xBETH backing / redemption",
      risk,
      snapshot.rwa.summary,
      snapshot.rwa.latestRetrievedAt ? `Evidence retrieved ${formatDate(snapshot.rwa.latestRetrievedAt)}` : "Evidence timestamp unavailable",
      riskTone(risk),
      Waves,
    ),
    signal(
      "Aave position health",
      `HF ${healthValue}`,
      trigger ? `The current health factor is measured against the configured policy trigger of ${trigger}.` : "Current Aave account health is verified; no policy trigger is configured in this snapshot.",
      `Observed at block ${snapshot.aave.position.blockNumber}`,
      healthTone,
      CircleGauge,
    ),
    signal(
      "Executable liquidity",
      snapshot.marketContext.liquidity.executable ? "AVAILABLE" : "BLOCKED",
      snapshot.marketContext.liquidity.executable ? "A deterministic xBETH to xETH quote is available for the proposed route." : snapshot.marketContext.liquidity.failureReason ?? "The proposed route is not executable.",
      `${bps(snapshot.marketContext.liquidity.estimatedSlippageBps)} estimated slippage · ${bps(snapshot.marketContext.liquidity.priceImpactBps)} price impact`,
      snapshot.marketContext.liquidity.executable ? "success" : "danger",
      Droplets,
    ),
    signal(
      "Oracle freshness",
      oracleFresh ? "FRESH" : "STALE",
      oracleFresh ? "Both xBETH and xETH oracle observations meet the configured freshness requirement." : "At least one required oracle observation is stale.",
      `${bps(snapshot.marketContext.liquidity.oraclePoolDeviationBps)} oracle / pool deviation`,
      oracleFresh ? "success" : "danger",
      Activity,
    ),
    signal(
      "Policy readiness",
      snapshot.policy.status,
      snapshot.policy.reason,
      policy ? `Policy v${policy.policyVersion} · trigger ${policy.riskTrigger}` : "No policy configured",
      snapshot.policy.status === "REGISTERED" ? "success" : snapshot.policy.status === "PREVIEW_ONLY" ? "info" : "warning",
      LockKeyhole,
    ),
    signal(
      "Protection simulation",
      planAllowed ? "READY" : "BLOCKED",
      snapshot.executionPreview.reason,
      `Projected HF ${healthFactor(snapshot.executionPreview.plan.projectedPostHealthFactorWad)} · no transaction submitted`,
      planAllowed ? "success" : "danger",
      FlaskConical,
    ),
  ];
}

function signal(
  title: string,
  status: string,
  description: string,
  evidence: string,
  tone: Tone,
  icon: LucideIcon,
): Signal {
  return { title, status, description, evidence, tone, icon };
}

function riskTone(level: string): Tone {
  if (level === "HIGH" || level === "CRITICAL") return "danger";
  if (level === "MEDIUM") return "warning";
  if (level === "NORMAL" || level === "LOW") return "success";
  return "neutral";
}

function stageDetail(label: string, state: ProtectionState, snapshot: LiveApiResponse["snapshot"]): string {
  if (label === "Monitor") return snapshot ? "Snapshot observed" : "Awaiting complete data";
  if (label === "Detect") return state.stage >= 1 ? "Signal evaluated" : "Standing by";
  if (label === "Validate") return state.stage >= 2 ? "Bounds checked" : "On trigger";
  if (label === "Simulate") return state.stage >= 3 ? "Route previewed" : "After validation";
  return state.stage >= 4 ? "Ready for bounded action" : "No action required";
}
