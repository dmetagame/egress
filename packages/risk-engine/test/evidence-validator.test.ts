import { describe, expect, it } from "vitest";
import type {
  EvidenceReference,
  ModelRiskAnalysis,
  SourceDefinition,
} from "../src/domain/schemas.js";
import { validateEvidence } from "../src/analysis/evidence-validator.js";
import { DeterministicReplayAnalyzer } from "../src/analysis/replay-analyzer.js";
import { REPLAY_SOURCE } from "../src/replay/fixtures.js";
import { InMemorySourceFetcher } from "../src/sources/fetcher.js";
import { SourceIngestionService } from "../src/sources/ingest.js";
import { InMemoryStore } from "../src/sources/store.js";
import { buildHighRiskFixture, TEST_NOW } from "./helpers.js";

function cloneAnalysis(value: ModelRiskAnalysis): ModelRiskAnalysis {
  return structuredClone(value);
}

function referenceForLine(input: {
  sourceId: string;
  sourceUrl: string;
  revisionId: string;
  contentHash: `sha256:${string}`;
  line: { line: number; section: string; text: string };
}): EvidenceReference {
  return {
    evidenceId: `evidence_${input.sourceId}_${input.line.line}`,
    sourceId: input.sourceId,
    sourceUrl: input.sourceUrl,
    revisionId: input.revisionId,
    contentHash: input.contentHash,
    side: "CORROBORATING",
    excerpt: input.line.text,
    location: {
      section: input.line.section,
      startLine: input.line.line,
      endLine: input.line.line,
    },
  };
}

describe("evidence validation", () => {
  it("accepts the material replay revision with exact evidence", async () => {
    const fixture = await buildHighRiskFixture();
    const analyzer = new DeterministicReplayAnalyzer(() => TEST_NOW);
    const { analysis } = await analyzer.analyze(fixture.analysisInput);

    const validation = validateEvidence(analysis, fixture.analysisInput);

    expect(validation.valid).toBe(true);
    expect(validation.errors).toEqual([]);
  });

  it.each([
    ["excerpt", (analysis: ModelRiskAnalysis) => {
      analysis.claims[0]!.evidence[0]!.excerpt = "Invented evidence excerpt.";
    }],
    ["value", (analysis: ModelRiskAnalysis) => {
      analysis.claims[0]!.currentValue = "Redemptions are permanently disabled.";
    }],
    ["statement", (analysis: ModelRiskAnalysis) => {
      analysis.claims[0]!.statement = "OKX is insolvent and xBETH has no backing.";
    }],
  ])("rejects a hallucinated %s", async (_kind, mutate) => {
    const fixture = await buildHighRiskFixture();
    const analyzer = new DeterministicReplayAnalyzer(() => TEST_NOW);
    const { analysis: original } = await analyzer.analyze(fixture.analysisInput);
    const analysis = cloneAnalysis(original);
    mutate(analysis);

    const validation = validateEvidence(analysis, fixture.analysisInput);

    expect(validation.valid).toBe(false);
    expect(validation.errors.join(" ")).toMatch(/verbatim|unsupported|not present/i);
  });

  it("requires old and new values for a modified claim", async () => {
    const fixture = await buildHighRiskFixture();
    const analyzer = new DeterministicReplayAnalyzer(() => TEST_NOW);
    const { analysis: original } = await analyzer.analyze(fixture.analysisInput);
    const analysis = cloneAnalysis(original);
    const modified = analysis.claims.find((claim) => claim.changeKind === "MODIFIED")!;
    modified.currentValue = null;

    const validation = validateEvidence(analysis, fixture.analysisInput);

    expect(validation.valid).toBe(false);
    expect(validation.errors.join(" ")).toContain("must provide a current value");
  });

  it("detects an uncited contradiction in a corroborating OKX source", async () => {
    const fixture = await buildHighRiskFixture();
    const corroboratingSource: SourceDefinition = {
      id: "okx-x-rwa-overview",
      url: "https://www.okx.com/x-rwa",
      authority: "OKX",
      assetScope: ["X_RWA", "XBETH"],
      enabled: true,
    };
    const corroboratingStore = new InMemoryStore();
    const corroboratingIngestion = new SourceIngestionService(
      new InMemorySourceFetcher(
        new Map([
          [
            corroboratingSource.id,
            {
              rawContent:
                "<html><body><article><h1>X-RWA</h1><p>xBETH redemptions remain available with no restriction under normal and stressed conditions.</p></article></body></html>",
              retrievedAt: TEST_NOW.toISOString(),
            },
          ],
        ]),
      ),
      corroboratingStore,
    );
    const corroborating = await corroboratingIngestion.ingest(corroboratingSource);
    if (corroborating.status !== "CREATED") throw new Error("Expected corroborating revision");
    const analysisInput = {
      ...fixture.analysisInput,
      corroborating: [corroborating.snapshot],
    };
    const analyzer = new DeterministicReplayAnalyzer(() => TEST_NOW);
    const { analysis } = await analyzer.analyze(analysisInput);

    const validation = validateEvidence(analysis, analysisInput);

    expect(validation.valid).toBe(false);
    expect(validation.errors.join(" ")).toContain("corroborating source");
  });

  it("detects contradictory claims from independent sources even if the model misses the conflict", async () => {
    const fixture = await buildHighRiskFixture();
    const corroboratingSource: SourceDefinition = {
      id: "okx-x-rwa-overview",
      url: "https://www.okx.com/x-rwa",
      authority: "OKX",
      assetScope: ["X_RWA", "XBETH"],
      enabled: true,
    };
    const store = new InMemoryStore();
    const ingestion = new SourceIngestionService(
      new InMemorySourceFetcher(
        new Map([
          [
            corroboratingSource.id,
            {
              rawContent:
                "<html><body><article><h1>X-RWA</h1><p>xBETH redemptions are available with no restriction.</p></article></body></html>",
              retrievedAt: TEST_NOW.toISOString(),
            },
          ],
        ]),
      ),
      store,
    );
    const corroborating = await ingestion.ingest(corroboratingSource);
    if (corroborating.status !== "CREATED") throw new Error("Expected source revision");
    const analyzer = new DeterministicReplayAnalyzer(() => TEST_NOW);
    const { analysis: original } = await analyzer.analyze(fixture.analysisInput);
    const analysis = cloneAnalysis(original);
    const line = corroborating.snapshot.normalized.lines.find((candidate) =>
      candidate.text.includes("redemptions"),
    )!;
    analysis.claims.push({
      claimId: "claim_positive_redemption",
      claimType: "REDEMPTION",
      subject: "XBETH",
      statement: line.text,
      previousValue: null,
      currentValue: line.text,
      changeKind: "UNCHANGED",
      changeSummary: "Corroborating source reports unrestricted redemption.",
      materiality: "LOW",
      positionImpact: line.text,
      evidence: [
        referenceForLine({
          sourceId: corroborating.snapshot.sourceId,
          sourceUrl: corroborating.snapshot.sourceUrl,
          revisionId: corroborating.snapshot.revisionId,
          contentHash: corroborating.snapshot.contentHash as `sha256:${string}`,
          line,
        }),
      ],
      confidence: 0.9,
    });
    const validation = validateEvidence(analysis, {
      ...fixture.analysisInput,
      corroborating: [corroborating.snapshot],
    });

    expect(validation.valid).toBe(false);
    expect(validation.errors.join(" ")).toMatch(/contradictory|conflicts/i);
  });
});
