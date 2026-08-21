import { describe, expect, it } from "vitest";
import type { RiskAnalyzer } from "../src/analysis/analyzer.js";
import { REPLAY_REVISIONS, REPLAY_SOURCE } from "../src/replay/fixtures.js";
import {
  AllowlistedHttpSourceFetcher,
  InMemorySourceFetcher,
} from "../src/sources/fetcher.js";
import { SourceIngestionService } from "../src/sources/ingest.js";
import {
  AUTHORITATIVE_OKX_SOURCES,
  isAllowlistedSourceUrl,
} from "../src/sources/registry.js";
import { defaultStorePath, InMemoryStore } from "../src/sources/store.js";
import { runRevision, TEST_NOW } from "./helpers.js";

describe("source ingestion and lifecycle", () => {
  it("resolves the persistent store relative to the risk-engine package root", () => {
    expect(defaultStorePath("/tmp/egress-risk-engine")).toBe(
      "/tmp/egress-risk-engine/.data/egress-risk.json",
    );
    expect(defaultStorePath()).toMatch(
      /\/packages\/risk-engine\/\.data\/egress-risk\.json$/,
    );
    expect(defaultStorePath()).not.toContain(
      "/packages/risk-engine/packages/risk-engine/",
    );
  });

  it("rejects a redirect before requesting a non-allowlisted destination", async () => {
    const requestedUrls: string[] = [];
    const fetcher = new AllowlistedHttpSourceFetcher({
      fetchImplementation: async (input) => {
        requestedUrls.push(String(input));
        return new Response(null, {
          status: 302,
          headers: { location: "https://attacker.example/rwa" },
        });
      },
    });

    await expect(fetcher.fetch(REPLAY_SOURCE)).rejects.toThrow(
      /outside allowlist/i,
    );
    expect(requestedUrls).toEqual([REPLAY_SOURCE.url]);
  });

  it("accepts only the reviewed OKX locale redirect targets", async () => {
    const source = AUTHORITATIVE_OKX_SOURCES[0];
    const canonicalUrl = "https://www.okx.com/en-us/x-rwa";
    const requestedUrls: string[] = [];
    const fetcher = new AllowlistedHttpSourceFetcher({
      fetchImplementation: async (input) => {
        const requestedUrl = String(input);
        requestedUrls.push(requestedUrl);
        if (requestedUrl === source.url) {
          return new Response(null, {
            status: 302,
            headers: { location: canonicalUrl },
          });
        }
        return new Response("<html><body><article>Verified OKX X-RWA source content for testing.</article></body></html>", {
          status: 200,
          headers: { "content-type": "text/html; charset=utf-8" },
        });
      },
    });

    const retrieved = await fetcher.fetch(source);

    expect(requestedUrls).toEqual([source.url, canonicalUrl]);
    expect(retrieved.responseMetadata.finalUrl).toBe(canonicalUrl);

    const unreviewedRedirectFetcher = new AllowlistedHttpSourceFetcher({
      fetchImplementation: async () => new Response(null, {
        status: 302,
        headers: { location: "https://www.okx.com/en-gb/x-rwa" },
      }),
    });
    await expect(unreviewedRedirectFetcher.fetch(source)).rejects.toThrow(/outside allowlist/i);

    expect(isAllowlistedSourceUrl("https://www.okx.com/en-us/x-rwa")).toBe(true);
    expect(isAllowlistedSourceUrl("https://www.okx.com/en-us/help/how-does-xasset-work")).toBe(true);
    expect(isAllowlistedSourceUrl("https://www.okx.com/en-eu/x-rwa")).toBe(true);
    expect(isAllowlistedSourceUrl("https://www.okx.com/en-eu/help/how-does-xasset-work")).toBe(true);
    expect(isAllowlistedSourceUrl("https://www.okx.com/en-gb/x-rwa")).toBe(false);
    const embeddedCredentialsUrl = [
      "https://user",
      ":secret@www.okx.com/en-us/x-rwa",
    ].join("");
    expect(isAllowlistedSourceUrl(embeddedCredentialsUrl)).toBe(false);
    expect(isAllowlistedSourceUrl("https://www.okx.com:444/en-us/x-rwa")).toBe(false);
    expect(isAllowlistedSourceUrl("https://www.okx.com/en-us/x-rwa?redirect=1")).toBe(false);
  });

  it("stops reading a streamed response when the byte limit is exceeded", async () => {
    const fetcher = new AllowlistedHttpSourceFetcher({
      maxBytes: 8,
      fetchImplementation: async () =>
        new Response(
          new ReadableStream({
            start(controller) {
              controller.enqueue(new TextEncoder().encode("12345678"));
              controller.enqueue(new TextEncoder().encode("9"));
              controller.close();
            },
          }),
          {
            status: 200,
            headers: { "content-type": "text/html" },
          },
        ),
    });

    await expect(fetcher.fetch(REPLAY_SOURCE)).rejects.toThrow(/exceeds 8 bytes/i);
  });

  it("does not create a new revision when normalized content is unchanged", async () => {
    const store = new InMemoryStore();
    const ingestion = new SourceIngestionService(
      new InMemorySourceFetcher(
        new Map([
          [
            REPLAY_SOURCE.id,
            { rawContent: REPLAY_REVISIONS.A, retrievedAt: TEST_NOW.toISOString() },
          ],
        ]),
      ),
      store,
    );

    const first = await ingestion.ingest(REPLAY_SOURCE);
    const second = await ingestion.ingest(REPLAY_SOURCE);

    expect(first.status).toBe("CREATED");
    expect(second.status).toBe("UNCHANGED");
    expect(store.snapshots).toHaveLength(1);
  });

  it("marks punctuation-only changes as skipped", async () => {
    const store = new InMemoryStore();
    const first = await runRevision({
      store,
      rawContent: REPLAY_REVISIONS.A,
    });
    expect(first.status).toBe("EVALUATED");

    const cosmetic = REPLAY_REVISIONS.A.replace(
      "normal operating conditions.",
      "normal operating conditions!",
    );
    const second = await runRevision({ store, rawContent: cosmetic });

    expect(second.status).toBe("COSMETIC_CHANGE");
    expect(store.snapshots.at(-1)?.extractionStatus).toBe("SKIPPED");
  });

  it("fails safely when an authoritative source is unavailable", async () => {
    const store = new InMemoryStore();
    const result = await runRevision({ store, rawContent: "" });

    expect(result.status).toBe("SOURCE_UNAVAILABLE");
    expect(result.event).toBeNull();
  });

  it("records analyzer failures and produces no permitted action", async () => {
    const store = new InMemoryStore();
    const analyzer: RiskAnalyzer = {
      async analyze() {
        throw new Error("model provider unavailable");
      },
    };
    const result = await runRevision({
      store,
      rawContent: REPLAY_REVISIONS.A,
      analyzer,
    });

    expect(result.status).toBe("ANALYSIS_FAILED");
    expect(result.event?.verdict.riskLevel).toBe("INSUFFICIENT_EVIDENCE");
    expect(result.event?.attestation).toBeNull();
    expect(result.event?.intent?.allowed).toBe(false);
    expect(store.snapshots[0]?.extractionStatus).toBe("FAILED");
  });

  it("enforces a bounded semantic-diff resource budget", async () => {
    const store = new InMemoryStore();
    const lineCount = 1_500;
    const html = (prefix: string) =>
      `<html><body><article>${Array.from(
        { length: lineCount },
        (_value, index) => `<p>${prefix} source line ${index}</p>`,
      ).join("")}</article></body></html>`;

    await runRevision({ store, rawContent: html("previous") });
    const result = await runRevision({ store, rawContent: html("current") });

    expect(result.status).toBe("SOURCE_UNAVAILABLE");
    expect(result.message).toContain("LCS cells");
  });
});
