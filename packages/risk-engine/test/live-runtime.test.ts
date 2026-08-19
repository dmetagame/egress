import { describe, expect, it } from "vitest";
import {
  createLiveRevisionStore,
  createLiveSnapshotArchive,
  readLiveRuntimeConfig,
} from "../src/live/runtime.js";
import { FilesystemLiveSnapshotArchive } from "../src/live/filesystem-archive.js";
import { PostgresLiveSnapshotArchive } from "../src/live/postgres-archive.js";
import { JsonFileStore } from "../src/sources/store.js";
import { PostgresRevisionStore } from "../src/sources/postgres-store.js";

describe("live archive runtime configuration", () => {
  it("uses a conservative local polling interval and filesystem archive", () => {
    const config = readLiveRuntimeConfig({}, "/tmp/egress-runtime-test");
    expect(config.rpcUrl).toBe("https://rpc.xlayer.tech");
    expect(config.rpcUrls).toEqual(["https://rpc.xlayer.tech"]);
    expect(config.pollIntervalSeconds).toBe(300);
    expect(config.archivePath).toBe("/tmp/egress-runtime-test/.data/live-archive");
    expect(config.hostedRuntime).toBe(false);
    expect(config.inlinePollingPermitted).toBe(true);
    expect(config.issues).toEqual([]);
    expect(createLiveSnapshotArchive(config)).toBeInstanceOf(FilesystemLiveSnapshotArchive);
    expect(createLiveRevisionStore(config)).toBeInstanceOf(JsonFileStore);
  });

  it("requires PostgreSQL for hosted durability", () => {
    const config = readLiveRuntimeConfig({ VERCEL: "1" });
    expect(config.issues).toContain(
      "EGRESS_DATABASE_URL is required for durable archiving on hosted production.",
    );
    expect(() => createLiveSnapshotArchive(config)).toThrow(/EGRESS_DATABASE_URL/i);
    expect(() => createLiveRevisionStore(config)).toThrow(/EGRESS_DATABASE_URL/i);
  });

  it("selects direct PostgreSQL without exposing or validating credentials over the network", () => {
    const config = readLiveRuntimeConfig({
      VERCEL: "1",
      EGRESS_DATABASE_URL: "postgresql://user:secret@example.invalid/egress",
      EGRESS_LIVE_POLL_INTERVAL_SECONDS: "600",
    });
    expect(config.issues).toEqual([]);
    expect(config.pollIntervalSeconds).toBe(600);
    expect(config.inlinePollingPermitted).toBe(false);
    expect(createLiveSnapshotArchive(config)).toBeInstanceOf(PostgresLiveSnapshotArchive);
    expect(createLiveRevisionStore(config)).toBeInstanceOf(PostgresRevisionStore);
  });

  it("rejects inline polling on hosted runtimes", () => {
    const config = readLiveRuntimeConfig({
      VERCEL: "1",
      EGRESS_DATABASE_URL: "postgresql://user:secret@example.invalid/egress",
      EGRESS_WEB_INLINE_POLLING: "true",
    });
    expect(config.inlinePollingPermitted).toBe(true);
    expect(config.issues).toContain(
      "EGRESS_WEB_INLINE_POLLING must be false on hosted production; the persistent worker owns polling.",
    );
  });

  it("accepts an ordered read-only RPC failover list", () => {
    const config = readLiveRuntimeConfig({
      EGRESS_XLAYER_RPC_URL: "https://primary.example/rpc",
      EGRESS_XLAYER_RPC_URLS: "https://secondary.example/rpc, https://tertiary.example/rpc",
    });
    expect(config.issues).toEqual([]);
    expect(config.rpcUrls).toEqual([
      "https://primary.example/rpc",
      "https://secondary.example/rpc",
      "https://tertiary.example/rpc",
    ]);
  });

  it("rejects excessive polling and malformed database schemes", () => {
    const config = readLiveRuntimeConfig({
      EGRESS_DATABASE_URL: "https://example.invalid/database",
      EGRESS_LIVE_POLL_INTERVAL_SECONDS: "30",
    });
    expect(config.issues).toEqual(expect.arrayContaining([
      expect.stringMatching(/PostgreSQL URL scheme/i),
      expect.stringMatching(/at least 60 seconds/i),
    ]));
  });

  it("fails closed for production write-mode or broadcast configuration", () => {
    const config = readLiveRuntimeConfig({
      EGRESS_DEPLOYMENT_ENV: "production",
      EGRESS_RUNTIME_MODE: "LIVE_MAINNET",
      EGRESS_LIVE_MAINNET_BROADCAST: "true",
    });
    expect(config.issues).toEqual(expect.arrayContaining([
      expect.stringMatching(/must be LIVE_READ_ONLY/i),
      expect.stringMatching(/must remain disabled/i),
      expect.stringMatching(/EGRESS_DATABASE_URL is required/i),
    ]));
    expect(config.public.broadcastPermitted).toBe(false);
    expect(config.public.transactionSubmitted).toBe(false);
  });

  it("keeps webhook credentials server-only and validates signed-delivery pairing", () => {
    const secret = "s".repeat(32);
    const valid = readLiveRuntimeConfig({
      EGRESS_ALERT_WEBHOOK_URL: "https://alerts.example.test/egress",
      EGRESS_ALERT_WEBHOOK_SECRET: secret,
    });
    expect(valid.issues).toEqual([]);
    expect(valid.alertDelivery.webhookSecret).toBe(secret);
    expect(JSON.stringify(valid.public)).not.toContain(secret);

    const invalid = readLiveRuntimeConfig({
      EGRESS_ALERT_WEBHOOK_URL: "https://alerts.example.test/egress",
      NEXT_PUBLIC_EGRESS_ALERT_WEBHOOK_SECRET: secret,
    });
    expect(invalid.issues).toEqual(expect.arrayContaining([
      expect.stringMatching(/WEBHOOK_SECRET is required/i),
      expect.stringMatching(/server-only/i),
    ]));
  });
});
