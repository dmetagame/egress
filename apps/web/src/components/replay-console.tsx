"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { Play, RotateCcw, ShieldCheck, TriangleAlert } from "lucide-react";
import type { ProductSnapshot, ReplayApiResponse, ReplayRevision } from "@/lib/types";
import { EgressControlLoop, type LoopStageState } from "./control-loop";
import { RiskEvidencePanel } from "./risk-evidence";
import { PolicyEvaluation } from "./policy-evaluation";
import { ExecutionPreview, ExecutionResult } from "./execution-details";
import { SectionHeading, StatusPill } from "./primitives";
import { StateTransition } from "./motion-primitives";

const sequence: ReplayRevision[] = ["A", "B", "C"];

const pause = (milliseconds: number) => new Promise((resolve) => setTimeout(resolve, milliseconds));

function initialStages(): LoopStageState[] {
  return [
    { status: "normal", detail: "Baseline monitored" },
    { status: "passed", detail: "Evidence validated" },
    { status: "normal", detail: "Trigger not met" },
    { status: "normal", detail: "Liquidity available" },
    { status: "pending", detail: "Not required" },
    { status: "pending", detail: "Standing by" },
  ];
}

function settledStages(response: ReplayApiResponse): LoopStageState[] {
  const level = response.event.verdict.riskLevel;
  if (level === "NORMAL" || level === "LOW") {
    return [
      { status: "normal", detail: `Revision ${response.revision}` },
      { status: "passed", detail: level },
      { status: "blocked", detail: "Below HIGH" },
      { status: "normal", detail: "No action needed" },
      { status: "pending", detail: "Not required" },
      { status: "pending", detail: "Monitoring" },
    ];
  }
  if (level === "MEDIUM") {
    return [
      { status: "warning", detail: `Revision ${response.revision}` },
      { status: "warning", detail: "MEDIUM" },
      { status: "blocked", detail: "Below HIGH" },
      { status: "normal", detail: "No action needed" },
      { status: "pending", detail: "Not required" },
      { status: "pending", detail: "Monitoring" },
    ];
  }
  const autonomousDecision = response.autonomous?.decision;
  if (!autonomousDecision || autonomousDecision.status !== "WOULD_EXECUTE" || !autonomousDecision.simulation.success) {
    return [
      { status: "passed", detail: `Revision ${response.revision}` },
      { status: "passed", detail: level },
      { status: "passed", detail: "Policy evaluated" },
      { status: "blocked", detail: autonomousDecision?.simulation.success === false ? "Simulation failed" : "Not executable" },
      { status: "pending", detail: "Not submitted" },
      { status: "pending", detail: "Position unchanged" },
    ];
  }
  const checks = response.autonomous?.decision.checks ?? [];
  const check = (name: string, fallback: string) => checks.find((item) => item.check === name)?.actual ?? fallback;
  const priceImpact = response.autonomous?.decision.market.liquidity.priceImpactBps ?? "unknown";
  return [
    { status: "passed", detail: `Revision ${response.revision}` },
    { status: "passed", detail: level },
    { status: "passed", detail: check("risk_threshold", "Policy matched") },
    { status: "passed", detail: `${priceImpact} bps impact` },
    { status: "passed", detail: check("contract_simulation", "Contract passed") },
    { status: "executed", detail: "HF improved" },
  ];
}

function runningStages(stage: number): LoopStageState[] {
  const details = ["Change detected", "Classifying evidence", "Evaluating limits", "Refreshing state", "Calling contract", "Submitting fork tx"];
  return details.map((detail, index) => ({
    status: index < stage ? "passed" : index === stage ? "active" : "pending",
    detail: index < stage ? "Passed" : detail,
  }));
}

async function fetchRevision(revision: ReplayRevision): Promise<ReplayApiResponse> {
  const request = await fetch("/api/replay", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ revision }),
  });
  const body = (await request.json()) as ReplayApiResponse | { error: string };
  if (!request.ok || "error" in body) {
    throw new Error("error" in body ? body.error : "Replay failed safely");
  }
  return body;
}

export function ReplayConsole({ snapshot }: { snapshot: ProductSnapshot }) {
  const [response, setResponse] = useState<ReplayApiResponse | null>(null);
  const [selectedRevision, setSelectedRevision] = useState<ReplayRevision>("A");
  const [running, setRunning] = useState(false);
  const [activeStage, setActiveStage] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);
  const autoStarted = useRef(false);

  const runRevision = useCallback(async (revision: ReplayRevision, animateAll = false) => {
    setRunning(true);
    setError(null);
    setSelectedRevision(revision);
    setActiveStage(0);
    try {
      const result = await fetchRevision(revision);
      setResponse(result);
      const finalStage = animateAll && revision === "C" ? 5 : 2;
      for (let stage = 0; stage <= finalStage; stage += 1) {
        setActiveStage(stage);
        await pause(revision === "C" ? 320 : 180);
      }
      setActiveStage(null);
      return result;
    } catch (caught) {
      setActiveStage(null);
      setError(caught instanceof Error ? caught.message : "Replay failed safely");
      return null;
    } finally {
      setRunning(false);
    }
  }, []);

  const runSequence = useCallback(async () => {
    setRunning(true);
    setError(null);
    try {
      for (const revision of sequence) {
        setSelectedRevision(revision);
        setActiveStage(0);
        const result = await fetchRevision(revision);
        setResponse(result);
        const finalStage = revision === "C" ? 5 : 2;
        for (let stage = 0; stage <= finalStage; stage += 1) {
          setActiveStage(stage);
          await pause(revision === "C" ? 320 : 180);
        }
        setActiveStage(null);
        if (revision !== "C") await pause(220);
      }
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Replay failed safely");
      setActiveStage(null);
    } finally {
      setRunning(false);
    }
  }, []);

  useEffect(() => {
    if (autoStarted.current || !window.location.search.includes("replay=1")) return;
    autoStarted.current = true;
    void runSequence();
  }, [runSequence]);

  const stages = activeStage === null
    ? response ? settledStages(response) : initialStages()
    : runningStages(activeStage);
  const currentRisk = response?.event.verdict.riskLevel ?? "NORMAL";
  const highExecution = response?.autonomous?.decision.status === "WOULD_EXECUTE";

  return (
    <section className="replay-workspace" id="replay">
      <SectionHeading
        eyebrow="Risk event replay"
        title="Egress control loop"
        description="Pre-recorded OKX revisions pass through the production ingestion, evidence, policy, and fork-execution path."
        action={
          <div className="replay-labels">
            <StatusPill tone="warning" icon={RotateCcw}>REPLAY MODE</StatusPill>
            <StatusPill tone="info">PINNED FORK</StatusPill>
          </div>
        }
      />

      <div className="replay-toolbar">
        <div className="segmented-control" aria-label="Replay revision">
          {sequence.map((revision) => (
            <button
              aria-pressed={selectedRevision === revision}
              className={selectedRevision === revision ? "is-selected" : undefined}
              disabled={running}
              key={revision}
              onClick={() => void runRevision(revision, revision === "C")}
              type="button"
            >
              <span>Revision {revision}</span>
              <small>{revision === "A" ? "Normal" : revision === "B" ? "Minor" : "Material"}</small>
            </button>
          ))}
        </div>
        <button className="button button-primary" disabled={running} onClick={() => void runSequence()} type="button">
          {running ? <RotateCcw className="spin" aria-hidden="true" size={16} /> : <Play aria-hidden="true" size={16} />}
          {running ? "Running pipeline" : "Run full replay"}
        </button>
      </div>

      <div className="replay-state-line" aria-live="polite">
        <span>Current RWA risk</span>
        <strong className={`risk-text risk-${currentRisk.toLowerCase()}`}>{currentRisk}</strong>
        <span className="state-divider" />
        <span>Policy</span>
        <strong>{highExecution ? "MATCHED" : "MONITORING"}</strong>
        <span className="state-divider" />
        <span>Autonomy</span>
        <strong>PRE-AUTHORIZED</strong>
      </div>

      <StateTransition stateKey={`${selectedRevision}-${activeStage ?? currentRisk}`}>
        <EgressControlLoop states={stages} />
      </StateTransition>

      {error ? (
        <div className="inline-alert alert-danger" role="alert">
          <TriangleAlert aria-hidden="true" size={17} />
          <span>{error}. No transaction was submitted.</span>
        </div>
      ) : null}

      {!response ? (
        <div className="replay-empty">
          <ShieldCheck aria-hidden="true" size={22} />
          <div>
            <strong>Position monitoring is active</strong>
            <p>Run the replay to move from the recorded normal baseline through a material risk event.</p>
          </div>
          <span>HF {Number(BigInt(snapshot.position.before.healthFactorWad)) / 1e18}</span>
        </div>
      ) : (
        <div className="replay-results" aria-live="polite">
          <RiskEvidencePanel response={response} />
          <PolicyEvaluation
            allowed={Boolean(response.autonomous?.decision.status === "WOULD_EXECUTE")}
            checks={response.autonomous?.decision.checks ?? response.event.intent?.checks ?? []}
          />
          <ExecutionPreview response={response} />
          <ExecutionResult response={response} />
        </div>
      )}
    </section>
  );
}
