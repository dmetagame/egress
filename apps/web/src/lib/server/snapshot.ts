import "server-only";

import { cache } from "react";
import type { Phase5Artifact, ProductSnapshot, ActivityEntry } from "../types";
import { bps, formatDate, healthFactor, shortHash, tokenAmount } from "../format";
import phase5ArtifactJson from "../../../../../reports/phase5/autonomous-control-loop.json";

export const loadPhase5Artifact = cache(async (): Promise<Phase5Artifact> => {
  const parsed = phase5ArtifactJson as Phase5Artifact;
  if (parsed.environment.liveMainnetBroadcast) {
    throw new Error("Phase 5 artifact is unexpectedly marked as a live broadcast");
  }
  return structuredClone(parsed);
});

function activityFor(artifact: Phase5Artifact): ActivityEntry[] {
  const evaluatedAt = artifact.shadowDecision.evaluatedAt;
  const executionAt = artifact.generatedAt;
  const highRevision = artifact.revisions.find((revision) => revision.revision === "C");
  return [
    {
      id: "source-revision-c",
      timestamp: evaluatedAt,
      type: "SOURCE",
      title: "OKX source revision detected",
      detail: `${highRevision?.sourceRevisionIds[0] ?? "revision"} changed redemption and withdrawal language.`,
      status: "warning",
      reference: highRevision?.diffIds[0],
    },
    {
      id: "risk-high",
      timestamp: evaluatedAt,
      type: "RISK",
      title: "HIGH RWA risk classified",
      detail: "Evidence-backed deterioration was found in conversion and withdrawal conditions.",
      status: "danger",
      reference: artifact.shadowDecision.riskEventId,
    },
    {
      id: "policy-match",
      timestamp: evaluatedAt,
      type: "POLICY",
      title: "Pre-authorized policy matched",
      detail: `${artifact.shadowDecision.checks.filter((check) => check.passed).length} deterministic checks passed.`,
      status: "success",
      reference: artifact.authorization.policyId,
    },
    {
      id: "simulation-passed",
      timestamp: evaluatedAt,
      type: "SIMULATION",
      title: "Contract simulation passed",
      detail: "The exact bounded autonomous calldata passed the Egress contract boundary.",
      status: "success",
      reference: artifact.shadowDecision.decisionId,
    },
    {
      id: "execution-confirmed",
      timestamp: executionAt,
      type: "EXECUTION",
      title: "Deleveraging confirmed",
      detail: `${tokenAmount(artifact.execution.deleveraged.debtRepaidWei)} xETH debt repaid on the pinned fork.`,
      status: "success",
      reference: artifact.execution.transactionHash,
    },
    {
      id: "position-protected",
      timestamp: executionAt,
      type: "POSITION",
      title: "Position health improved",
      detail: `${healthFactor(artifact.positionBefore.healthFactorWad)} -> ${healthFactor(artifact.positionAfter.healthFactorWad)} health factor.`,
      status: "success",
    },
  ];
}

export const getProductSnapshot = cache(async (): Promise<ProductSnapshot> => {
  const artifact = await loadPhase5Artifact();
  const market = artifact.shadowDecision.market;
  return {
    label: artifact.label,
    generatedAt: artifact.generatedAt,
    environment: artifact.environment,
    contracts: artifact.contracts,
    actors: artifact.actors,
    authorization: artifact.authorization,
    position: {
      before: artifact.positionBefore,
      after: artifact.positionAfter,
    },
    market,
    policyState: artifact.shadowDecision.policyState,
    policyChecks: artifact.shadowDecision.checks,
    shadowStatus: artifact.shadowDecision.status,
    revisions: artifact.revisions,
    execution: artifact.execution,
    assertions: artifact.assertions,
    activity: activityFor(artifact),
  };
});

export function environmentLabel(artifact: Phase5Artifact): string {
  return `${artifact.label} / chain ${artifact.environment.chainId} / block ${artifact.environment.forkBlock.toLocaleString("en-US")}`;
}

export function snapshotSummary(snapshot: ProductSnapshot): string {
  return [
    `${tokenAmount(snapshot.position.before.collateralWei)} xBETH collateral`,
    `${tokenAmount(snapshot.position.before.debtWei)} xETH debt`,
    `HF ${healthFactor(snapshot.position.before.healthFactorWad)}`,
    `slippage ${bps(snapshot.market.liquidity.estimatedSlippageBps)}`,
    `updated ${formatDate(snapshot.generatedAt)}`,
    `tx ${shortHash(snapshot.execution.transactionHash)}`,
  ].join(" | ");
}
