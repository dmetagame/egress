import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it, vi } from "vitest";
import type { LiveSnapshotEnvelope } from "@egress/risk-engine";

vi.mock("server-only", () => ({}));

import {
  emitLiveSnapshotLogs,
  getLiveArchiveDashboard,
  getLiveOperationalHealth,
  getLiveReadOnlySnapshot,
  readLiveRuntimeConfig,
  redactLiveEnvelopeForClient,
  toLiveCurrentApiResponse,
} from "./live";

describe("live server runtime", () => {
  it("documents every production observation variable without publishing secrets", () => {
    const example = readFileSync(resolve(process.cwd(), ".env.example"), "utf8");
    const serverOnlyVariables = [
      "EGRESS_RUNTIME_MODE",
      "EGRESS_DEPLOYMENT_ENV",
      "EGRESS_LIVE_MAINNET_BROADCAST",
      "LIVE_MAINNET_BROADCAST",
      "EGRESS_XLAYER_RPC_URL",
      "EGRESS_XLAYER_RPC_URLS",
      "EGRESS_LIVE_ACCOUNT",
      "EGRESS_LIVE_EGRESS_SPENDER",
      "EGRESS_LIVE_OBSERVATION_BLOCK",
      "EGRESS_LIVE_OBSERVATION_BLOCK_HASH",
      "EGRESS_LIVE_MAX_BLOCK_AGE_SECONDS",
      "EGRESS_LIVE_MAX_ORACLE_AGE_SECONDS",
      "EGRESS_LIVE_MAX_SOURCE_AGE_SECONDS",
      "EGRESS_RISK_STORE_PATH",
      "EGRESS_LIVE_ARCHIVE_PATH",
      "EGRESS_DATABASE_URL",
      "EGRESS_WEB_INLINE_POLLING",
      "EGRESS_LIVE_POLL_INTERVAL_SECONDS",
      "EGRESS_LIVE_POLL_READ_TIMEOUT_MS",
      "EGRESS_LIVE_POLL_ARCHIVE_TIMEOUT_MS",
      "EGRESS_LIVE_POLL_MAX_ATTEMPTS",
      "EGRESS_LIVE_POLL_RETRY_BACKOFF_MS",
      "EGRESS_LIVE_POLL_MAX_RETRY_BACKOFF_MS",
      "EGRESS_LIVE_POLL_FAILURE_THRESHOLD",
      "EGRESS_ALERT_CONSOLE_ENABLED",
      "EGRESS_ALERT_WEBHOOK_URL",
      "EGRESS_ALERT_WEBHOOK_SECRET",
      "EGRESS_ALERT_WEBHOOK_SINK_ID",
      "EGRESS_ALERT_DELIVERY_TIMEOUT_MS",
      "EGRESS_ALERT_MAX_ATTEMPTS_PER_RUN",
      "EGRESS_ALERT_MAX_TOTAL_ATTEMPTS",
      "EGRESS_ALERT_RETRY_BACKOFF_MS",
      "EGRESS_ALERT_MAX_RETRY_BACKOFF_MS",
      "EGRESS_ALERT_DELIVERY_LEASE_MS",
      "EGRESS_EXECUTION_ENVIRONMENT",
      "EGRESS_EXECUTION_SUBMISSION_ENABLED",
      "EGRESS_EXECUTION_RPC_URL",
      "EGRESS_EXECUTION_CHAIN_ID",
      "EGRESS_EXECUTION_EGRESS_CONTRACT",
      "EGRESS_EXECUTION_KEEPER_ADDRESS",
      "EGRESS_EXECUTION_ANCHOR_BLOCK",
      "EGRESS_EXECUTION_ANCHOR_BLOCK_HASH",
      "EGRESS_EXECUTION_FORK_RUNTIME",
      "EGRESS_EXECUTION_MAX_SNAPSHOT_AGE_SECONDS",
      "EGRESS_EXECUTION_MAX_INTENT_AGE_SECONDS",
      "EGRESS_EXECUTION_ADDRESSES_PROVIDER",
      "EGRESS_EXECUTION_AAVE_POOL",
      "EGRESS_EXECUTION_AAVE_ORACLE",
      "EGRESS_EXECUTION_XBETH",
      "EGRESS_EXECUTION_XETH",
      "EGRESS_EXECUTION_A_XBETH",
      "EGRESS_EXECUTION_VARIABLE_DEBT_XETH",
      "EGRESS_EXECUTION_UNISWAP_FACTORY",
      "EGRESS_EXECUTION_SWAP_ROUTER",
      "EGRESS_EXECUTION_QUOTER_V2",
      "EGRESS_EXECUTION_SWAP_POOL",
      "EGRESS_EXECUTION_POOL_FEE",
    ];
    for (const variable of serverOnlyVariables) {
      expect(example).toMatch(new RegExp(`^${variable}=`, "m"));
    }
    expect(example).toMatch(/^EGRESS_RUNTIME_MODE=LIVE_READ_ONLY$/m);
    expect(example).toMatch(/^EGRESS_LIVE_MAINNET_BROADCAST=false$/m);
    expect(example).toMatch(/^LIVE_MAINNET_BROADCAST=false$/m);
    expect(example).toMatch(/^EGRESS_XLAYER_RPC_URLS=$/m);
    expect(example).toMatch(/^EGRESS_WEB_INLINE_POLLING=false$/m);
    expect(example).toMatch(/^EGRESS_EXECUTION_ENVIRONMENT=DISABLED$/m);
    expect(example).toMatch(/^EGRESS_EXECUTION_SUBMISSION_ENABLED=false$/m);
    expect(example).toMatch(/^EGRESS_ALERT_WEBHOOK_SECRET=$/m);
    expect(example).not.toMatch(/^EGRESS_EXECUTION_PRIVATE_KEY=/m);
    expect(example).not.toMatch(
      /^NEXT_PUBLIC_.*(?:DATABASE_URL|WEBHOOK_SECRET|PRIVATE_KEY|MNEMONIC|SIGNER)=/m,
    );
  });

  it("keeps the public X Layer RPC default and does not infer an account", () => {
    const config = readLiveRuntimeConfig({});
    expect(config.rpcUrl).toBe("https://rpc.xlayer.tech");
    expect(config.account).toBeNull();
    expect(config.riskStorePath).toMatch(/\.data\/egress-risk\.json$/);
    expect(config.archivePath).toMatch(/\.data\/live-archive$/);
    expect(config.pollIntervalSeconds).toBe(300);
    expect(config.issues).toEqual([]);
  });

  it("accepts a local HTTP fork runtime and validates bounded freshness settings", () => {
    const config = readLiveRuntimeConfig({
      EGRESS_XLAYER_RPC_URL: "http://127.0.0.1:8545",
      EGRESS_LIVE_ACCOUNT: "0x1111111111111111111111111111111111111111",
      EGRESS_LIVE_EGRESS_SPENDER: "0x2222222222222222222222222222222222222222",
      EGRESS_LIVE_OBSERVATION_BLOCK: "68047853",
      EGRESS_LIVE_OBSERVATION_BLOCK_HASH: `0x${"ab".repeat(32)}`,
      EGRESS_RISK_STORE_PATH: "/tmp/egress-risk.json",
      EGRESS_LIVE_MAX_BLOCK_AGE_SECONDS: "30",
      EGRESS_LIVE_MAX_ORACLE_AGE_SECONDS: "120",
      EGRESS_LIVE_MAX_SOURCE_AGE_SECONDS: "3600",
      EGRESS_LIVE_POLL_INTERVAL_SECONDS: "600",
      EGRESS_LIVE_ARCHIVE_PATH: "/tmp/egress-live-archive",
    });
    expect(config.issues).toEqual([]);
    expect(config.account).toBe("0x1111111111111111111111111111111111111111");
    expect(config.egressSpender).toBe("0x2222222222222222222222222222222222222222");
    expect(config.observationBlockNumber).toBe(68_047_853n);
    expect(config.observationBlockHash).toBe(`0x${"ab".repeat(32)}`);
    expect(config.maxBlockAgeSeconds).toBe(30);
    expect(config.maxOracleAgeSeconds).toBe(120);
    expect(config.maxSourceAgeSeconds).toBe(3600);
    expect(config.riskStorePath).toBe("/tmp/egress-risk.json");
    expect(config.archivePath).toBe("/tmp/egress-live-archive");
    expect(config.pollIntervalSeconds).toBe(600);
  });

  it("rejects insecure remote RPCs, malformed accounts, and invalid freshness values", () => {
    const config = readLiveRuntimeConfig({
      EGRESS_XLAYER_RPC_URL: "http://rpc.example",
      EGRESS_LIVE_ACCOUNT: "not-an-address",
      EGRESS_LIVE_EGRESS_SPENDER: "0x1234",
      EGRESS_LIVE_OBSERVATION_BLOCK: "-1",
      EGRESS_LIVE_OBSERVATION_BLOCK_HASH: "0x1234",
      EGRESS_LIVE_MAX_BLOCK_AGE_SECONDS: "0",
      EGRESS_LIVE_MAX_ORACLE_AGE_SECONDS: "not-a-number",
      EGRESS_LIVE_MAX_SOURCE_AGE_SECONDS: "-5",
      EGRESS_LIVE_POLL_INTERVAL_SECONDS: "30",
    });
    expect(config.issues).toEqual(expect.arrayContaining([
      expect.stringMatching(/must use HTTPS/i),
      expect.stringMatching(/account.*valid/i),
      expect.stringMatching(/spender.*valid/i),
      expect.stringMatching(/OBSERVATION_BLOCK.*positive/i),
      expect.stringMatching(/OBSERVATION_BLOCK_HASH.*32-byte/i),
      expect.stringMatching(/MAX_BLOCK_AGE.*positive/i),
      expect.stringMatching(/MAX_ORACLE_AGE.*positive/i),
      expect.stringMatching(/MAX_SOURCE_AGE.*positive/i),
      expect.stringMatching(/POLL_INTERVAL.*at least 60/i),
    ]));
  });

  it("fails closed when durable archive configuration is unavailable", async () => {
    const dashboard = await getLiveArchiveDashboard({ VERCEL: "1" });
    const response = toLiveCurrentApiResponse(dashboard);
    expect(response.status).toBe("UNAVAILABLE");
    expect(response.snapshot).toBeNull();
    expect(response.risk.classification).toBeNull();
    expect(response.broadcastPermitted).toBe(false);
    expect(response.transactionSubmitted).toBe(false);
    expect(response.reasons.join(" ")).toMatch(/EGRESS_DATABASE_URL/i);
  });

  it("reports operator health as unavailable without creating an execution capability", async () => {
    const health = await getLiveOperationalHealth({ VERCEL: "1" });
    expect(health.poller.state).toBe("UNAVAILABLE");
    expect(health.database.state).toBe("UNAVAILABLE");
    expect(health.poller.lastError).toMatch(/EGRESS_DATABASE_URL/i);
    expect(health.broadcastPermitted).toBe(false);
    expect(health.transactionSubmitted).toBe(false);
  });

  it("fails closed before touching the RPC when configuration is invalid", async () => {
    const result = await getLiveReadOnlySnapshot({
      EGRESS_XLAYER_RPC_URL: "ftp://rpc.example",
    });
    expect(result.status).toBe("LIVE_DATA_UNAVAILABLE");
    expect(result.mode).toBe("LIVE_READ_ONLY");
    expect(result.adapters[0]?.adapter).toBe("runtime-config");
    expect(result.adapters[0]?.status).toBe("INVALID_CONFIGURATION");
  });

  it("emits redacted structured logs without raw reasons or credentials", () => {
    const envelope = unavailableEnvelopeWithSecrets();
    const now = "2026-08-15T10:00:00.000Z";
    envelope.partial.rwa = {
      status: "AVAILABLE",
      riskLevel: "NORMAL",
      verdictId: "verdict-source-only",
      summary: "Source-only baseline",
      confidence: 0.98,
      claims: [],
      evidenceValid: true,
      latestRetrievedAt: now,
      sourceStates: [],
      reasons: [],
      analyzer: "DETERMINISTIC_REPLAY",
    };
    const lines: string[] = [];
    emitLiveSnapshotLogs(envelope, (line) => lines.push(line));
    const output = lines.join("\n");
    expect(output).toContain("egress.live.adapter_health");
    expect(output).toContain('"reasonCount":1');
    expect(output).toContain('"status":"LIVE_DATA_UNAVAILABLE"');
    expect(output).toContain('"riskLevel":null');
    expect(output).toContain('"evidenceStatus":"AVAILABLE"');
    expect(output).not.toContain("super-secret");
    expect(output).not.toContain("private-key");
    expect(output).not.toContain("0x1111111111111111111111111111111111111111");
  });

  it("keeps canonical source provenance while omitting raw source bodies from browser payloads", () => {
    const envelope = unavailableEnvelopeWithSecrets();
    const now = envelope.generatedAt;
    const sourceState: NonNullable<LiveSnapshotEnvelope["partial"]["rwa"]>["sourceStates"][number] = {
      sourceId: "okx-x-rwa-overview",
      sourceUrl: "https://www.okx.com/x-rwa",
      revisionId: "revision_1",
      sourceVersion: 1,
      contentHash: `sha256:${"ab".repeat(32)}`,
      retrievedAt: now,
      changed: false,
      diff: {
        diffId: "diff_1",
        sourceId: "okx-x-rwa-overview",
        fromRevisionId: null,
        toRevisionId: "revision_1",
        generatedAt: now,
        kind: "INITIAL",
        cosmeticOnly: false,
        summary: "Initial source",
        hunks: [],
      },
      snapshot: {
        revisionId: "revision_1",
        sourceId: "okx-x-rwa-overview",
        sourceUrl: "https://www.okx.com/x-rwa",
        sourceVersion: 1,
        retrievedAt: now,
        contentHash: `sha256:${"ab".repeat(32)}`,
        rawContentHash: `sha256:${"cd".repeat(32)}`,
        rawContent: "<html>large official source</html>",
        normalized: {
          title: "OKX X-RWA",
          description: "Official source",
          text: "large official source",
          lines: [{ line: 1, section: "Overview", text: "large official source" }],
          semanticFingerprint: `sha256:${"ef".repeat(32)}`,
        },
        previousRevisionId: null,
        diffId: "diff_1",
        extractionStatus: "ANALYZED",
        responseMetadata: {
          status: 200,
          contentType: "text/html",
          etag: null,
          lastModified: null,
          finalUrl: "https://www.okx.com/x-rwa",
        },
      },
    };
    envelope.partial.rwa = {
      status: "AVAILABLE",
      riskLevel: "NORMAL",
      verdictId: "verdict_1",
      summary: "Normal",
      confidence: 0.9,
      claims: [],
      evidenceValid: true,
      latestRetrievedAt: now,
      sourceStates: [sourceState],
      reasons: [],
      analyzer: "DETERMINISTIC_FILTER",
    };
    const redacted = redactLiveEnvelopeForClient(envelope);
    expect(redacted.partial.rwa?.sourceStates[0]?.contentHash).toBe(sourceState.contentHash);
    expect(redacted.partial.rwa?.sourceStates[0]?.snapshot.rawContent).toBe("");
    expect(redacted.partial.rwa?.sourceStates[0]?.snapshot.normalized.lines).toEqual([]);
    expect(envelope.partial.rwa!.sourceStates[0]?.snapshot.rawContent).toContain("large official");
  });
});

function unavailableEnvelopeWithSecrets(): LiveSnapshotEnvelope {
  const now = "2026-08-15T10:00:00.000Z";
  return {
    mode: "LIVE_READ_ONLY",
    status: "LIVE_DATA_UNAVAILABLE",
    generatedAt: now,
    snapshot: null,
    partial: {
      chain: null,
      account: null,
      position: null,
      liquidity: null,
      oracle: null,
      uniswapPool: null,
      rwa: null,
      policy: null,
      executionPreview: null,
    },
    adapters: [{
      adapter: "xlayer",
      version: "1",
      status: "UNAVAILABLE",
      message: "RPC https://user:super-secret@rpc.example/private-key failed",
      freshness: {
        observedAt: now,
        sourceTimestamp: null,
        blockNumber: null,
        ageSeconds: null,
        maxAgeSeconds: 120,
        fresh: false,
      },
      provenance: ["https://rpc.example"],
    }],
    reasons: ["RPC https://user:super-secret@rpc.example/private-key failed for 0x1111111111111111111111111111111111111111"],
  };
}
