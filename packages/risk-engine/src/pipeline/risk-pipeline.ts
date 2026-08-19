import type { Address } from "viem";
import type {
  PolicyRuntimeState,
  RiskEventRecord,
  SourceDefinition,
  UserProtectionPolicy,
} from "../domain/schemas.js";
import { shortId } from "../domain/hash.js";
import type { RiskAnalyzer } from "../analysis/analyzer.js";
import { validateEvidence } from "../analysis/evidence-validator.js";
import { createRiskVerdict } from "../analysis/verdict.js";
import type { RiskAttestationSigner } from "../authorization/risk-attestation.js";
import type { MarketContextProvider } from "../market/provider.js";
import { DeterministicPolicyEngine } from "../policy/engine.js";
import type { RiskAuditLogger } from "../audit/logger.js";
import { SourceIngestionService } from "../sources/ingest.js";
import type { RevisionStore } from "../sources/store.js";

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export interface RiskPipelineResult {
  status:
    | "NO_CHANGE"
    | "COSMETIC_CHANGE"
    | "EVALUATED"
    | "ANALYSIS_FAILED"
    | "SOURCE_UNAVAILABLE";
  event: RiskEventRecord | null;
  message: string;
}

export class EgressRiskPipeline {
  constructor(
    private readonly dependencies: {
      ingestion: SourceIngestionService;
      revisionStore: RevisionStore;
      analyzer: RiskAnalyzer;
      attestationSigner: RiskAttestationSigner | null;
      marketProvider: MarketContextProvider;
      policyEngine: DeterministicPolicyEngine;
      auditLogger: RiskAuditLogger;
      now?: () => Date;
    },
  ) {}

  async run(input: {
    source: SourceDefinition;
    corroboratingSources: SourceDefinition[];
    policy: UserProtectionPolicy;
    runtime: PolicyRuntimeState;
    mode: RiskEventRecord["mode"];
    verdictTtlSeconds?: number;
  }): Promise<RiskPipelineResult> {
    const now = this.dependencies.now ?? (() => new Date());
    let ingestion;
    try {
      ingestion = await this.dependencies.ingestion.ingest(input.source);
    } catch (error) {
      return {
        status: "SOURCE_UNAVAILABLE",
        event: null,
        message: errorMessage(error),
      };
    }

    if (ingestion.status === "UNCHANGED") {
      return {
        status: "NO_CHANGE",
        event: null,
        message: `No normalized source change for ${input.source.id}.`,
      };
    }

    if (ingestion.diff.cosmeticOnly) {
      await this.dependencies.ingestion.setExtractionStatus(
        ingestion.snapshot.revisionId,
        "SKIPPED",
      );
      return {
        status: "COSMETIC_CHANGE",
        event: null,
        message: `Only cosmetic source changes were detected for ${input.source.id}.`,
      };
    }

    const previous = ingestion.snapshot.previousRevisionId
      ? await this.dependencies.revisionStore.getRevision(
          ingestion.snapshot.previousRevisionId,
        )
      : null;
    const corroborating = (
      await Promise.all(
        input.corroboratingSources.map((source) =>
          this.dependencies.revisionStore.latest(source.id),
        ),
      )
    ).filter((snapshot): snapshot is NonNullable<typeof snapshot> => snapshot !== null);
    const riskEventId = shortId("risk", {
      revisionId: ingestion.snapshot.revisionId,
      diffId: ingestion.diff.diffId,
      policyId: input.policy.policyId,
    });
    const analysisInput = {
      current: ingestion.snapshot,
      previous,
      diff: ingestion.diff,
      corroborating,
    };
    let analysis;
    let metadata;
    let analysisFailed = false;
    try {
      ({ analysis, metadata } = await this.dependencies.analyzer.analyze(analysisInput));
      await this.dependencies.ingestion.setExtractionStatus(
        ingestion.snapshot.revisionId,
        "ANALYZED",
      );
    } catch (error) {
      analysisFailed = true;
      await this.dependencies.ingestion.setExtractionStatus(
        ingestion.snapshot.revisionId,
        "FAILED",
      );
      analysis = {
        proposedRiskLevel: "INSUFFICIENT_EVIDENCE" as const,
        summary: "Risk analysis failed closed; no supported verdict was produced.",
        rationale: `Analyzer failure: ${errorMessage(error)}`,
        claims: [],
        conflictingEvidence: false,
        conflictExplanation: null,
        confidence: 0,
      };
      metadata = {
        analyzer: "DETERMINISTIC_FILTER" as const,
        provider: "egress",
        model: "fail-closed",
        modelVersion: "1",
        promptVersion: "not-applicable",
        analyzedAt: now().toISOString(),
      };
    }
    const validation = validateEvidence(analysis, analysisInput);
    const verdict = createRiskVerdict({
      riskEventId,
      analysis,
      metadata,
      validation,
      current: ingestion.snapshot,
      diff: ingestion.diff,
      issuedAt: now(),
      ttlSeconds: input.verdictTtlSeconds ?? 300,
    });
    const attestation = this.dependencies.attestationSigner && validation.valid && !analysisFailed
      ? await this.dependencies.attestationSigner.sign(verdict, input.policy)
      : null;

    let marketContext = null;
    let intent = null;
    try {
      marketContext = await this.dependencies.marketProvider.getContext(
        input.policy.user as Address,
        input.policy,
      );
      intent = await this.dependencies.policyEngine.evaluate({
        verdict,
        attestation,
        market: marketContext,
        policy: input.policy,
        runtime: input.runtime,
      });
    } catch (error) {
      verdict.evidenceValidation.warnings.push(
        `Market or policy evaluation failed safely: ${errorMessage(error)}`,
      );
    }

    const event: RiskEventRecord = {
      riskEventId,
      mode: input.mode,
      createdAt: now().toISOString(),
      sourceRevisionIds: verdict.sourceRevisionIds,
      diffIds: verdict.diffIds,
      policy: input.policy,
      policyRuntime: input.runtime,
      analysis,
      verdict,
      attestation,
      marketContext,
      intent,
      executionResult: {
        status: "NOT_SUBMITTED",
        transactionHash: null,
        blockNumber: null,
        gasUsed: null,
        observedAt: now().toISOString(),
        message: "Automatic live execution is disabled in the risk-engine milestone.",
        deleveraged: null,
      },
    };
    await this.dependencies.auditLogger.record(event);
    return {
      status: analysisFailed ? "ANALYSIS_FAILED" : "EVALUATED",
      event,
      message: analysisFailed
        ? "Risk analysis failed closed; no execution intent was authorized."
        : intent?.allowed
        ? "A bounded execution intent was permitted; user authorization is still required."
        : "The source change was evaluated and no executable intent was authorized.",
    };
  }
}
