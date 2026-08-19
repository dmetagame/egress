import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { privateKeyToAccount } from "viem/accounts";
import { RiskAuditLogger } from "../audit/logger.js";
import { DeterministicReplayAnalyzer } from "../analysis/replay-analyzer.js";
import { createConfiguredAiRiskAnalyzer } from "../ai/config.js";
import { RiskAttestationSigner } from "../authorization/risk-attestation.js";
import { StaticMarketContextProvider } from "../market/provider.js";
import { DeterministicPolicyEngine } from "../policy/engine.js";
import { EgressRiskPipeline } from "../pipeline/risk-pipeline.js";
import {
  REPLAY_PRIVATE_KEY,
  REPLAY_REVISIONS,
  REPLAY_SOURCE,
  replayMarketContext,
  replayPolicy,
} from "../replay/fixtures.js";
import { InMemorySourceFetcher } from "../sources/fetcher.js";
import { SourceIngestionService } from "../sources/ingest.js";
import { InMemoryStore } from "../sources/store.js";

const now = new Date("2026-08-14T10:00:00.000Z");
const store = new InMemoryStore();
const account = privateKeyToAccount(REPLAY_PRIVATE_KEY);
const policy = replayPolicy(now);
const liveModelConfigured = Boolean(process.env.EGRESS_AI_MODEL?.trim());
const analyzer = liveModelConfigured
  ? createConfiguredAiRiskAnalyzer()
  : new DeterministicReplayAnalyzer(() => now);
if (account.address.toLowerCase() !== policy.approvedRiskAttestor.toLowerCase()) {
  throw new Error("Replay attestor fixture does not match policy");
}

const outputs: unknown[] = [];
for (const [label, rawContent] of Object.entries(REPLAY_REVISIONS)) {
  const fetcher = new InMemorySourceFetcher(
    new Map([[REPLAY_SOURCE.id, { rawContent, retrievedAt: now.toISOString() }]]),
  );
  const pipeline = new EgressRiskPipeline({
    ingestion: new SourceIngestionService(fetcher, store),
    revisionStore: store,
    analyzer,
    attestationSigner: new RiskAttestationSigner(account),
    marketProvider: new StaticMarketContextProvider(replayMarketContext(now)),
    policyEngine: new DeterministicPolicyEngine(),
    auditLogger: new RiskAuditLogger(store),
    now: () => now,
  });
  const result = await pipeline.run({
    source: REPLAY_SOURCE,
    corroboratingSources: [],
    policy,
    runtime: {
      evaluatedAt: now.toISOString(),
      lastExecutionAt: null,
      authorizationNonce: label.charCodeAt(0).toString(),
      revocationNonce: "0",
      nonceAlreadyUsed: false,
      executorPaused: false,
      userAuthorizationSignature: null,
      collateralAuthorizationAvailable: false,
    },
    mode: "REPLAY",
  });
  outputs.push({ revision: label, ...result });
}

const projectRoot = fileURLToPath(new URL("../../../..", import.meta.url));
const outputDirectory = join(projectRoot, "reports", "risk-replay");
await mkdir(outputDirectory, { recursive: true });
await writeFile(
  join(outputDirectory, "replay.json"),
  `${JSON.stringify(outputs, null, 2)}\n`,
  "utf8",
);

for (const output of outputs) {
  const event = (output as { event?: { verdict?: { riskLevel: string }; intent?: { status: string } } }).event;
  process.stdout.write(
    `Revision ${(output as { revision: string }).revision}: ${event?.verdict?.riskLevel ?? "NO_EVENT"} / ${event?.intent?.status ?? "NO_INTENT"}\n`,
  );
}
process.stdout.write(
  `Replay analyzer: ${liveModelConfigured ? "AI_SDK" : "DETERMINISTIC_REPLAY"}\n`,
);
