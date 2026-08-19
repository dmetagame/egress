import "server-only";

import { privateKeyToAccount } from "viem/accounts";
import {
  DeterministicPolicyEngine,
  DeterministicReplayAnalyzer,
  EgressRiskPipeline,
  InMemorySourceFetcher,
  InMemoryStore,
  RiskAttestationSigner,
  RiskAuditLogger,
  SourceIngestionService,
  StaticMarketContextProvider,
  REPLAY_PRIVATE_KEY,
  REPLAY_REVISIONS,
  REPLAY_SOURCE,
  replayMarketContext,
  replayPolicy,
} from "@egress/risk-engine";
import type { ReplayApiResponse, ReplayRevision } from "../types";
import { loadPhase5Artifact } from "./snapshot";

const REVISIONS: ReplayRevision[] = ["A", "B", "C"];

function assertRevision(value: unknown): asserts value is ReplayRevision {
  if (typeof value !== "string" || !REVISIONS.includes(value as ReplayRevision)) {
    throw new Error("Replay revision must be A, B, or C");
  }
}

export async function runReplayRevision(value: unknown): Promise<ReplayApiResponse> {
  assertRevision(value);
  const now = new Date("2026-08-14T10:00:00.000Z");
  const store = new InMemoryStore();
  const account = privateKeyToAccount(REPLAY_PRIVATE_KEY);
  const policy = replayPolicy(now);
  let selected:
    | Awaited<ReturnType<EgressRiskPipeline["run"]>>
    | null = null;

  for (const revision of REVISIONS) {
    const pipeline = new EgressRiskPipeline({
      ingestion: new SourceIngestionService(
        new InMemorySourceFetcher(
          new Map([[REPLAY_SOURCE.id, { rawContent: REPLAY_REVISIONS[revision], retrievedAt: now.toISOString() }]]),
        ),
        store,
      ),
      revisionStore: store,
      analyzer: new DeterministicReplayAnalyzer(() => now),
      attestationSigner: new RiskAttestationSigner(account),
      marketProvider: new StaticMarketContextProvider(replayMarketContext(now)),
      policyEngine: new DeterministicPolicyEngine(),
      auditLogger: new RiskAuditLogger(store),
      now: () => now,
    });

    selected = await pipeline.run({
      source: REPLAY_SOURCE,
      corroboratingSources: [],
      policy,
      runtime: {
        evaluatedAt: now.toISOString(),
        lastExecutionAt: null,
        authorizationNonce: revision.charCodeAt(0).toString(),
        revocationNonce: "0",
        nonceAlreadyUsed: false,
        executorPaused: false,
        userAuthorizationSignature: null,
        collateralAuthorizationAvailable: false,
      },
      mode: "REPLAY",
      verdictTtlSeconds: 900,
    });

    if (revision === value) break;
  }

  if (!selected?.event) {
    throw new Error(`Replay revision ${value} did not produce an event`);
  }

  const snapshot = await store.getRevision(selected.event.sourceRevisionIds.at(-1) ?? "");
  const diff = await store.getDiff(selected.event.diffIds.at(-1) ?? "");
  if (!snapshot || !diff) throw new Error(`Replay revision ${value} is missing source evidence`);

  const artifact = await loadPhase5Artifact();
  return {
    revision: value,
    pipelineStatus: value === "C" ? "EVALUATED" : "EVALUATED",
    message: selected.message,
    event: selected.event,
    snapshot,
    diff,
    autonomous:
      value === "C"
        ? {
            decision: artifact.shadowDecision,
            execution: artifact.execution,
            environment: artifact.environment,
            label: artifact.label,
          }
        : null,
  };
}
