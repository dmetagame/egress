import { createHmac } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  ConsoleAlertSink,
  InMemoryLiveSnapshotArchive,
  LiveAlertDeliveryService,
  WebhookAlertSink,
  createAlertDelivery,
  liveAlertSchema,
  stableStringify,
} from "../src/index.js";

const ALERT = liveAlertSchema.parse({
  schemaVersion: 1,
  alertId: "alert_phase8c_1",
  deduplicationKey: `0x${"11".repeat(32)}`,
  alertType: "RISK_CHANGED",
  severity: "HIGH",
  snapshotHash: `0x${"22".repeat(32)}`,
  previousSnapshotHash: `0x${"33".repeat(32)}`,
  block: "68060442",
  timestamp: "2026-08-16T10:00:00.000Z",
  evidence: [{
    code: "RISK_CLASSIFICATION_CHANGED",
    message: "Risk changed from NORMAL to HIGH.",
    source: "okx-rwa",
    provenance: ["revision_2"],
  }],
  previousState: "NORMAL",
  currentState: "HIGH",
  thresholdPolicyVersion: 1,
  createdAt: "2026-08-16T10:00:00.000Z",
});

describe("live alert delivery", () => {
  it("delivers once and deduplicates a previously delivered alert", async () => {
    const archive = new InMemoryLiveSnapshotArchive();
    const lines: string[] = [];
    const service = new LiveAlertDeliveryService({
      store: archive,
      sinks: [new ConsoleAlertSink((line) => lines.push(line))],
      now: () => new Date("2026-08-16T10:00:00.000Z"),
    });

    const first = await service.deliver([ALERT]);
    const second = await service.deliver([ALERT]);

    expect(first.delivered).toBe(1);
    expect(second.outcomes[0]?.status).toBe("ALREADY_DELIVERED");
    expect(lines).toHaveLength(1);
    expect((await archive.alertDeliveries()).map((delivery) => delivery.status)).toEqual(["DELIVERED"]);
  });

  it("retries with a bounded deterministic schedule and persists failure state", async () => {
    const archive = new InMemoryLiveSnapshotArchive();
    let calls = 0;
    const service = new LiveAlertDeliveryService({
      store: archive,
      sinks: [{
        id: "test-sink",
        deliver: async () => {
          calls += 1;
          throw new Error("temporary sink failure");
        },
      }],
      now: () => new Date("2026-08-16T10:00:00.000Z"),
      sleep: async () => undefined,
      maxAttemptsPerRun: 2,
      maxTotalAttempts: 3,
      retryBackoffMs: 10,
      maxRetryBackoffMs: 20,
    });

    const result = await service.deliver([ALERT]);
    const delivery = await archive.alertDelivery(ALERT.alertId, "test-sink");
    expect(calls).toBe(2);
    expect(result.outcomes[0]?.status).toBe("FAILED");
    expect(delivery?.attempts).toBe(2);
    expect(delivery?.status).toBe("FAILED");
    expect(delivery?.nextAttemptAt).toBe("2026-08-16T10:00:00.020Z");
  });

  it("signs webhook payloads and sends the durable idempotency key", async () => {
    const secret = "s".repeat(32);
    let request: { body: string; headers: Headers } | null = null;
    const sink = new WebhookAlertSink({
      url: "https://alerts.example.test/egress",
      secret,
      sinkId: "webhook-test",
      fetch: async (_input, init) => {
        request = {
          body: String(init?.body),
          headers: new Headers(init?.headers),
        };
        return new Response(null, { status: 202 });
      },
    });
    const archive = new InMemoryLiveSnapshotArchive();
    const service = new LiveAlertDeliveryService({
      store: archive,
      sinks: [sink],
      now: () => new Date("2026-08-16T10:00:00.000Z"),
    });

    await service.deliver([ALERT]);

    expect(request).not.toBeNull();
    const idempotencyKey = request!.headers.get("idempotency-key")!;
    const timestamp = request!.headers.get("x-egress-timestamp")!;
    const expectedBody = stableStringify({
      schemaVersion: 1,
      event: "egress.live.alert",
      mode: "LIVE_READ_ONLY",
      alert: ALERT,
      broadcastPermitted: false,
      transactionSubmitted: false,
    });
    const expectedSignature = createHmac("sha256", secret)
      .update(`${timestamp}.${expectedBody}`, "utf8")
      .digest("hex");
    expect(request!.body).toBe(expectedBody);
    expect(request!.headers.get("x-egress-signature")).toBe(`sha256=${expectedSignature}`);
    expect(idempotencyKey).toBe("webhook-test:alert_phase8c_1");
  });

  it("prevents an expired worker lease from downgrading delivered state", async () => {
    const archive = new InMemoryLiveSnapshotArchive();
    const pending = createAlertDelivery({
      alert: ALERT,
      sinkId: "lease-test",
      now: "2026-08-16T10:00:00.000Z",
    });
    expect(await archive.claimAlertDelivery(pending, {
      leaseId: "lease-a",
      claimedAt: "2026-08-16T10:00:00.000Z",
      leaseExpiresAt: "2026-08-16T10:00:01.000Z",
    })).toBe(true);
    expect(await archive.claimAlertDelivery(pending, {
      leaseId: "lease-b",
      claimedAt: "2026-08-16T10:00:02.000Z",
      leaseExpiresAt: "2026-08-16T10:00:03.000Z",
    })).toBe(true);
    const delivered = createAlertDelivery({
      alert: ALERT,
      sinkId: "lease-test",
      now: "2026-08-16T10:00:02.100Z",
      status: "DELIVERED",
      attempts: 1,
      deliveredAt: "2026-08-16T10:00:02.100Z",
      createdAt: pending.createdAt,
    });
    const staleFailure = createAlertDelivery({
      alert: ALERT,
      sinkId: "lease-test",
      now: "2026-08-16T10:00:02.200Z",
      status: "FAILED",
      attempts: 1,
      lastError: "late failure",
      createdAt: pending.createdAt,
    });
    expect(await archive.completeAlertDelivery(delivered, "lease-b")).toBe(true);
    expect(await archive.completeAlertDelivery(staleFailure, "lease-a")).toBe(false);
    expect((await archive.alertDelivery(ALERT.alertId, "lease-test"))?.status).toBe("DELIVERED");
  });

  it("gives simultaneous workers distinct leases even with the same clock", async () => {
    class BarrierArchive extends InMemoryLiveSnapshotArchive {
      readonly leaseIds: string[] = [];
      private releaseBarrier!: () => void;
      private readonly barrier = new Promise<void>((resolve) => {
        this.releaseBarrier = resolve;
      });

      override async claimAlertDelivery(
        delivery: Parameters<InMemoryLiveSnapshotArchive["claimAlertDelivery"]>[0],
        lease: Parameters<InMemoryLiveSnapshotArchive["claimAlertDelivery"]>[1],
      ): Promise<boolean> {
        this.leaseIds.push(lease.leaseId);
        if (this.leaseIds.length === 2) this.releaseBarrier();
        await this.barrier;
        return super.claimAlertDelivery(delivery, lease);
      }
    }

    const archive = new BarrierArchive();
    let deliveries = 0;
    const sink = {
      id: "concurrent-sink",
      deliver: async () => {
        deliveries += 1;
        return { responseStatus: 202 };
      },
    };
    const options = {
      store: archive,
      sinks: [sink],
      now: () => new Date("2026-08-16T10:00:00.000Z"),
    };

    const [first, second] = await Promise.all([
      new LiveAlertDeliveryService(options).deliver([ALERT]),
      new LiveAlertDeliveryService(options).deliver([ALERT]),
    ]);

    expect(archive.leaseIds).toHaveLength(2);
    expect(new Set(archive.leaseIds).size).toBe(2);
    expect(archive.leaseIds).toEqual(
      archive.leaseIds.map((leaseId) => expect.stringMatching(/^[0-9a-f-]{36}$/i)),
    );
    expect(deliveries).toBe(1);
    expect([first.outcomes[0]?.status, second.outcomes[0]?.status].sort()).toEqual([
      "DELIVERED",
      "LEASED",
    ]);
  });
});
