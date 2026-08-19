import { privateKeyToAccount } from "viem/accounts";
import type {
  MarketContext,
  PolicyRuntimeState,
  RiskAttestation,
  RiskVerdict,
  SourceSnapshot,
  UserProtectionPolicy,
} from "../src/domain/schemas.js";
import type { AnalysisInput, RiskAnalyzer } from "../src/analysis/analyzer.js";
import { DeterministicReplayAnalyzer } from "../src/analysis/replay-analyzer.js";
import { validateEvidence } from "../src/analysis/evidence-validator.js";
import { createRiskVerdict } from "../src/analysis/verdict.js";
import { RiskAttestationSigner } from "../src/authorization/risk-attestation.js";
import { RiskAuditLogger } from "../src/audit/logger.js";
import { StaticMarketContextProvider } from "../src/market/provider.js";
import { EgressRiskPipeline } from "../src/pipeline/risk-pipeline.js";
import { DeterministicPolicyEngine } from "../src/policy/engine.js";
import {
  REPLAY_PRIVATE_KEY,
  REPLAY_REVISIONS,
  REPLAY_SOURCE,
  replayMarketContext,
  replayPolicy,
} from "../src/replay/fixtures.js";
import { InMemorySourceFetcher } from "../src/sources/fetcher.js";
import { SourceIngestionService } from "../src/sources/ingest.js";
import { InMemoryStore } from "../src/sources/store.js";

export const TEST_NOW = new Date("2026-08-14T10:00:00.000Z");
export const TEST_USER_PRIVATE_KEY =
  "0x2222222222222222222222222222222222222222222222222222222222222222" as const;
export const TEST_USER_ACCOUNT = privateKeyToAccount(TEST_USER_PRIVATE_KEY);
export const TEST_ATTESTOR_ACCOUNT = privateKeyToAccount(REPLAY_PRIVATE_KEY);

export function testPolicy(
  now = TEST_NOW,
  overrides: Partial<UserProtectionPolicy> = {},
): UserProtectionPolicy {
  return {
    ...replayPolicy(now),
    user: TEST_USER_ACCOUNT.address,
    ...overrides,
  };
}

export function testMarket(
  now = TEST_NOW,
  overrides: {
    position?: Partial<MarketContext["position"]>;
    liquidity?: Partial<MarketContext["liquidity"]>;
    plan?: Partial<MarketContext["plan"]>;
  } = {},
): MarketContext {
  const base = replayMarketContext(now);
  return {
    ...base,
    position: {
      ...base.position,
      user: TEST_USER_ACCOUNT.address,
      ...overrides.position,
    },
    liquidity: {
      ...base.liquidity,
      ...overrides.liquidity,
    },
    plan: {
      ...base.plan,
      ...overrides.plan,
    },
  };
}

export function testRuntime(
  now = TEST_NOW,
  overrides: Partial<PolicyRuntimeState> = {},
): PolicyRuntimeState {
  return {
    evaluatedAt: now.toISOString(),
    lastExecutionAt: null,
    authorizationNonce: "1",
    revocationNonce: "0",
    nonceAlreadyUsed: false,
    executorPaused: false,
    userAuthorizationSignature: null,
    collateralAuthorizationAvailable: false,
    ...overrides,
  };
}

export function pipelineForRevision(input: {
  store: InMemoryStore;
  rawContent: string;
  analyzer?: RiskAnalyzer;
  policy?: UserProtectionPolicy;
  market?: MarketContext;
  now?: Date;
}): EgressRiskPipeline {
  const now = input.now ?? TEST_NOW;
  return new EgressRiskPipeline({
    ingestion: new SourceIngestionService(
      new InMemorySourceFetcher(
        new Map([
          [
            REPLAY_SOURCE.id,
            { rawContent: input.rawContent, retrievedAt: now.toISOString() },
          ],
        ]),
      ),
      input.store,
    ),
    revisionStore: input.store,
    analyzer: input.analyzer ?? new DeterministicReplayAnalyzer(() => now),
    attestationSigner: new RiskAttestationSigner(TEST_ATTESTOR_ACCOUNT),
    marketProvider: new StaticMarketContextProvider(input.market ?? testMarket(now)),
    policyEngine: new DeterministicPolicyEngine(),
    auditLogger: new RiskAuditLogger(input.store),
    now: () => now,
  });
}

export async function runRevision(input: {
  store: InMemoryStore;
  rawContent: string;
  analyzer?: RiskAnalyzer;
  policy?: UserProtectionPolicy;
  market?: MarketContext;
  runtime?: PolicyRuntimeState;
  now?: Date;
}) {
  const now = input.now ?? TEST_NOW;
  const policy = input.policy ?? testPolicy(now);
  return pipelineForRevision({ ...input, policy, now }).run({
    source: REPLAY_SOURCE,
    corroboratingSources: [],
    policy,
    runtime: input.runtime ?? testRuntime(now),
    mode: "TEST",
  });
}

export interface HighRiskFixture {
  store: InMemoryStore;
  analysisInput: AnalysisInput;
  verdict: RiskVerdict;
  attestation: RiskAttestation;
  policy: UserProtectionPolicy;
  market: MarketContext;
  previous: SourceSnapshot;
  current: SourceSnapshot;
}

export async function buildHighRiskFixture(
  now = TEST_NOW,
): Promise<HighRiskFixture> {
  const store = new InMemoryStore();
  const previousIngestion = new SourceIngestionService(
    new InMemorySourceFetcher(
      new Map([
        [REPLAY_SOURCE.id, { rawContent: REPLAY_REVISIONS.B, retrievedAt: now.toISOString() }],
      ]),
    ),
    store,
  );
  const previousResult = await previousIngestion.ingest(REPLAY_SOURCE);
  if (previousResult.status !== "CREATED") throw new Error("Expected previous revision");

  const currentIngestion = new SourceIngestionService(
    new InMemorySourceFetcher(
      new Map([
        [REPLAY_SOURCE.id, { rawContent: REPLAY_REVISIONS.C, retrievedAt: now.toISOString() }],
      ]),
    ),
    store,
  );
  const currentResult = await currentIngestion.ingest(REPLAY_SOURCE);
  if (currentResult.status !== "CREATED") throw new Error("Expected current revision");

  const analysisInput: AnalysisInput = {
    previous: previousResult.snapshot,
    current: currentResult.snapshot,
    diff: currentResult.diff,
    corroborating: [],
  };
  const analyzer = new DeterministicReplayAnalyzer(() => now);
  const { analysis, metadata } = await analyzer.analyze(analysisInput);
  const validation = validateEvidence(analysis, analysisInput);
  if (!validation.valid) throw new Error(validation.errors.join(" "));
  const verdict = createRiskVerdict({
    riskEventId: "risk_test_material",
    analysis,
    metadata,
    validation,
    current: currentResult.snapshot,
    diff: currentResult.diff,
    issuedAt: now,
    ttlSeconds: 300,
  });
  const policy = testPolicy(now);
  const attestation = await new RiskAttestationSigner(TEST_ATTESTOR_ACCOUNT).sign(
    verdict,
    policy,
  );
  return {
    store,
    analysisInput,
    verdict,
    attestation,
    policy,
    market: testMarket(now),
    previous: previousResult.snapshot,
    current: currentResult.snapshot,
  };
}
