import type {
  AnalyzerMetadata,
  ModelRiskAnalysis,
  SourceDefinition,
  SourceDiff,
  SourceSnapshot,
  RiskVerdict,
} from "../domain/schemas.js";
import { shortId } from "../domain/hash.js";
import { validateEvidence } from "../analysis/evidence-validator.js";
import type { RiskAnalyzer } from "../analysis/analyzer.js";
import { DeterministicReplayAnalyzer } from "../analysis/replay-analyzer.js";
import { createRiskVerdict } from "../analysis/verdict.js";
import { AUTHORITATIVE_OKX_SOURCES } from "../sources/registry.js";
import { SourceIngestionService } from "../sources/ingest.js";
import { AllowlistedHttpSourceFetcher } from "../sources/fetcher.js";
import type { RevisionStore } from "../sources/store.js";
import {
  availableHealth,
  type AdapterHealth,
  type LiveRwaEvidence,
  type RwaSourceState,
  unavailableHealth,
} from "./schemas.js";

export interface RwaAdapterResult {
  evidence: LiveRwaEvidence;
  verdict: RiskVerdict | null;
  health: AdapterHealth;
}

export class OkxRwaReadAdapter {
  private readonly ingestion: SourceIngestionService;
  private readonly analyzer: RiskAnalyzer;
  private readonly now: () => Date;
  private readonly maxAgeSeconds: number;
  private readonly sources: SourceDefinition[];
  private readonly riskEventId: string | null;

  constructor(
    private readonly store: RevisionStore,
    options: {
      fetcher?: AllowlistedHttpSourceFetcher;
      analyzer?: RiskAnalyzer;
      now?: () => Date;
      maxAgeSeconds?: number;
      sources?: readonly SourceDefinition[];
      riskEventId?: string;
    } = {},
  ) {
    this.ingestion = new SourceIngestionService(
      options.fetcher ?? new AllowlistedHttpSourceFetcher(),
      store,
    );
    // A deterministic evidence-pattern analyzer is the safe local fallback.
    // Deployments may inject the structured AI analyzer; both pass through the
    // same evidence validator before a verdict is exposed.
    this.analyzer = options.analyzer ?? new DeterministicReplayAnalyzer(() => this.now());
    this.now = options.now ?? (() => new Date());
    this.maxAgeSeconds = options.maxAgeSeconds ?? 86_400;
    this.sources = [...(options.sources ?? AUTHORITATIVE_OKX_SOURCES)];
    this.riskEventId = options.riskEventId?.trim() || null;
  }

  async read(): Promise<RwaAdapterResult> {
    const now = this.now();
    const ingestions: Array<{
      source: SourceDefinition;
      result: Awaited<ReturnType<SourceIngestionService["ingest"]>>;
    }> = [];
    try {
      for (const source of this.sources) {
        ingestions.push({ source, result: await this.ingestion.ingest(source) });
      }
    } catch (error) {
      const message = errorMessage(error);
      return {
        verdict: null,
        evidence: {
          status: "LIVE_DATA_UNAVAILABLE",
          riskLevel: null,
          verdictId: null,
          summary: "Official OKX RWA evidence could not be verified.",
          confidence: null,
          claims: [],
          evidenceValid: false,
          latestRetrievedAt: null,
          sourceStates: [],
          reasons: [message],
          analyzer: null,
        },
        health: unavailableHealth("rwa", message, now, {
          maxAgeSeconds: this.maxAgeSeconds,
        }),
      };
    }

    const sourceStates: RwaSourceState[] = [];
    for (const item of ingestions) {
      const snapshot = item.result.snapshot;
      const diff =
        item.result.status === "CREATED"
          ? item.result.diff
          : snapshot.diffId
            ? await this.store.getDiff(snapshot.diffId)
            : null;
      if (!diff) {
        return unavailableRwaResult(
          "The latest OKX revision has no retrievable semantic diff.",
          now,
          this.maxAgeSeconds,
        );
      }
      const retrievedAt =
        item.result.status === "UNCHANGED" ? item.result.retrievedAt : snapshot.retrievedAt;
      sourceStates.push({
        sourceId: snapshot.sourceId,
        sourceUrl: snapshot.sourceUrl,
        revisionId: snapshot.revisionId,
        sourceVersion: snapshot.sourceVersion,
        contentHash: snapshot.contentHash,
        retrievedAt,
        changed: item.result.status === "CREATED",
        diff,
        snapshot,
      });
    }

    const primary =
      sourceStates.find((source) => source.sourceId === "okx-x-rwa-deposit-withdrawal") ??
      sourceStates[0];
    if (!primary) {
      return unavailableRwaResult("No configured OKX source was available.", now, this.maxAgeSeconds);
    }
    const previous = primary.snapshot.previousRevisionId
      ? await this.store.getRevision(primary.snapshot.previousRevisionId)
      : null;
    const corroborating: SourceSnapshot[] = [];
    for (const source of sourceStates) {
      if (source.sourceId === primary.sourceId) continue;
      const latest = await this.store.latest(source.sourceId);
      if (latest) corroborating.push(latest);
    }

    let analysis: ModelRiskAnalysis;
    let metadata: AnalyzerMetadata;
    try {
      ({ analysis, metadata } = await this.analyzer.analyze({
        current: primary.snapshot,
        previous,
        diff: primary.diff,
        corroborating,
      }));
    } catch (error) {
      return unavailableRwaResult(`Risk analysis failed closed: ${errorMessage(error)}`, now, this.maxAgeSeconds, sourceStates);
    }
    const validation = validateEvidence(
      analysis,
      { current: primary.snapshot, previous, diff: primary.diff, corroborating },
    );
    await this.ingestion.setExtractionStatus(
      primary.snapshot.revisionId,
      validation.valid ? "ANALYZED" : "FAILED",
    );
    const riskEventId = this.riskEventId ?? shortId("risk_live", {
      sourceRevisionIds: sourceStates.map((source) => source.revisionId),
      diffIds: sourceStates.map((source) => source.diff.diffId),
    });
    const verdict = createRiskVerdict({
      riskEventId,
      analysis,
      metadata,
      validation,
      current: primary.snapshot,
      diff: primary.diff,
      issuedAt: now,
      ttlSeconds: 300,
    });

    const retrievedTimes = sourceStates.map((source) => new Date(source.retrievedAt));
    const latestRetrievedAt = retrievedTimes
      .reduce((latest, value) => (value > latest ? value : latest));
    const oldestRetrievedAt = retrievedTimes
      .reduce((oldest, value) => (value < oldest ? value : oldest));
    const ageSeconds = (now.getTime() - oldestRetrievedAt.getTime()) / 1000;
    const sourceFresh = ageSeconds >= -5 && ageSeconds <= this.maxAgeSeconds;
    const health = availableHealth({
      adapter: "rwa",
      message: sourceFresh
        ? "Official OKX RWA revisions and evidence were retrieved and validated."
        : "Official OKX RWA evidence is stale.",
      now,
      blockNumber: 0n,
      sourceTimestamp: oldestRetrievedAt,
      maxAgeSeconds: this.maxAgeSeconds,
      provenance: sourceStates.flatMap((source) => [
        source.sourceUrl,
        source.revisionId,
        source.contentHash,
      ]),
    });
    if (!sourceFresh) {
      return {
        verdict: null,
        evidence: {
          status: "LIVE_DATA_UNAVAILABLE",
          riskLevel: null,
          verdictId: null,
          summary: "Official OKX RWA evidence is stale; no risk level is emitted.",
          confidence: null,
          claims: [],
          evidenceValid: false,
          latestRetrievedAt: latestRetrievedAt.toISOString(),
          sourceStates,
          reasons: [`Evidence is ${ageSeconds.toFixed(0)} seconds old.`],
          analyzer: metadata.analyzer,
        },
        health: { ...health, status: "STALE" },
      };
    }

    return {
      verdict,
      evidence: {
        status: "AVAILABLE",
        riskLevel: verdict.riskLevel,
        verdictId: verdict.verdictId,
        summary: verdict.summary,
        confidence: verdict.confidence,
        claims: verdict.claims,
        evidenceValid: verdict.evidenceValidation.valid,
        latestRetrievedAt: latestRetrievedAt.toISOString(),
        sourceStates,
        reasons: verdict.evidenceValidation.errors,
        analyzer: metadata.analyzer,
      },
      health,
    };
  }
}

function unavailableRwaResult(
  reason: string,
  now: Date,
  maxAgeSeconds: number,
  sourceStates: RwaSourceState[] = [],
): RwaAdapterResult {
  return {
    verdict: null,
    evidence: {
      status: "LIVE_DATA_UNAVAILABLE",
      riskLevel: null,
      verdictId: null,
      summary: "Official OKX RWA evidence is unavailable.",
      confidence: null,
      claims: [],
      evidenceValid: false,
      latestRetrievedAt: null,
      sourceStates,
      reasons: [reason],
      analyzer: null,
    },
    health: unavailableHealth("rwa", reason, now, { maxAgeSeconds }),
  };
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message.split("\n")[0] ?? error.name : String(error);
}
