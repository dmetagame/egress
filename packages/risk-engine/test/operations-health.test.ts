import { describe, expect, it } from "vitest";
import {
  InMemoryLiveSnapshotArchive,
  buildOperationalHealth,
  createOperationalEvent,
  executionStagingHealthSchema,
  readOperationalHealth,
} from "../src/index.js";
import type { LiveArchiveHistoryEntry } from "../src/live/archive-schemas.js";

const NOW = new Date("2026-08-16T10:00:00.000Z");

describe("operational health", () => {
  it("resets poller failure state after a later successful poll", () => {
    const events = [
      createOperationalEvent({
        eventType: "POLL_FAILED",
        healthState: "DEGRADED",
        startedAt: "2026-08-16T09:59:00.000Z",
        completedAt: "2026-08-16T09:59:01.000Z",
        durationMs: 1_000,
        consecutiveFailures: 2,
        payload: { error: "temporary RPC failure" },
      }),
      createOperationalEvent({
        eventType: "POLL_SUCCEEDED",
        healthState: "HEALTHY",
        snapshotHash: `0x${"44".repeat(32)}`,
        block: "68060442",
        startedAt: "2026-08-16T09:59:30.000Z",
        completedAt: "2026-08-16T09:59:31.000Z",
        durationMs: 1_000,
        consecutiveFailures: 0,
      }),
    ];
    const health = buildOperationalHealth({
      current: null,
      events,
      deliveries: [],
      now: NOW,
    });
    expect(health.poller.state).toBe("HEALTHY");
    expect(health.poller.consecutiveFailures).toBe(0);
    expect(health.poller.lastError).toBeNull();
  });

  it("preserves degraded state reported by a completed but unusable poll", () => {
    const health = buildOperationalHealth({
      current: null,
      events: [createOperationalEvent({
        eventType: "POLL_SUCCEEDED",
        healthState: "DEGRADED",
        startedAt: "2026-08-16T09:59:00.000Z",
        completedAt: "2026-08-16T09:59:01.000Z",
        durationMs: 1_000,
        consecutiveFailures: 0,
        payload: { archiveStatus: "STALE" },
      })],
      deliveries: [],
      now: NOW,
    });
    expect(health.poller.state).toBe("DEGRADED");
  });

  it("marks an observation unavailable after the bounded polling age window", () => {
    const current = {
      observation: { observedAt: "2026-08-16T09:40:00.000Z" },
      snapshot: {
        snapshotHash: `0x${"55".repeat(32)}`,
        archiveStatus: "COMPLETE",
        consistencyReasons: [],
        observedBlock: "68060442",
        timestamp: "2026-08-16T09:39:55.000Z",
        freshness: { adapters: [] },
        position: {
          healthFactorWad: "1075000000000000000",
          debtBalanceWei: "1",
          collateralBalanceWei: "1",
        },
        liquidity: { executable: true },
        rwaEvidence: null,
      },
    } as unknown as LiveArchiveHistoryEntry;
    const health = buildOperationalHealth({
      current,
      events: [createOperationalEvent({
        eventType: "POLL_SUCCEEDED",
        healthState: "HEALTHY",
        startedAt: "2026-08-16T09:40:00.000Z",
        completedAt: "2026-08-16T09:40:01.000Z",
        durationMs: 1_000,
        consecutiveFailures: 0,
      })],
      deliveries: [],
      now: NOW,
      pollIntervalSeconds: 300,
    });
    expect(health.current.ageSeconds).toBe(1_200);
    expect(health.metrics.archiveLagSeconds).toBe(5);
    expect(health.poller.state).toBe("UNAVAILABLE");
    expect(health.archive.state).toBe("HEALTHY");
  });

  it("retains restored snapshot provenance when operational events are absent", () => {
    const snapshotHash = `0x${"66".repeat(32)}`;
    const observedAt = "2026-08-16T09:59:30.000Z";
    const current = {
      observation: { observedAt },
      snapshot: {
        snapshotHash,
        archiveStatus: "COMPLETE",
        consistencyReasons: [],
        observedBlock: "68060442",
        timestamp: "2026-08-16T09:59:25.000Z",
        freshness: { adapters: [] },
        position: null,
        liquidity: null,
        rwaEvidence: null,
      },
    } as unknown as LiveArchiveHistoryEntry;
    const health = buildOperationalHealth({
      current,
      events: [],
      deliveries: [],
      now: NOW,
    });
    expect(health.poller.state).toBe("UNAVAILABLE");
    expect(health.poller.lastSuccessfulObservationAt).toBe(observedAt);
    expect(health.archive.lastSuccessfulSnapshotHash).toBe(snapshotHash);
    expect(health.archive.lastWriteAt).toBe(observedAt);
  });

  it("exposes archive and delivery health without enabling writes", async () => {
    const archive = new InMemoryLiveSnapshotArchive();
    await archive.saveOperationalEvent(createOperationalEvent({
      eventType: "POLL_FAILED",
      healthState: "UNAVAILABLE",
      startedAt: NOW.toISOString(),
      completedAt: NOW.toISOString(),
      durationMs: 0,
      consecutiveFailures: 3,
      payload: { error: "source unavailable" },
    }));
    const health = await readOperationalHealth(archive, { now: NOW });
    expect(health.poller.state).toBe("UNAVAILABLE");
    expect(health.database.state).toBe("HEALTHY");
    expect(health.broadcastPermitted).toBe(false);
    expect(health.transactionSubmitted).toBe(false);
  });

  it("reports execution staging separately while mainnet observation remains write-disabled", () => {
    const executionStaging = executionStagingHealthSchema.parse({
      schemaVersion: 1,
      configured: true,
      environment: "FORK_WRITE",
      state: "HEALTHY",
      submissionPermitted: true,
      latestIntent: {
        intentHash: `0x${"11".repeat(32)}`,
        snapshotHash: `0x${"22".repeat(32)}`,
        environment: "FORK_WRITE",
        chainId: 196,
        observedBlock: "67881241",
        createdAt: NOW.toISOString(),
      },
      latestSimulation: {
        simulationHash: `0x${"33".repeat(32)}`,
        intentHash: `0x${"11".repeat(32)}`,
        status: "PASSED",
        createdAt: NOW.toISOString(),
      },
      latestReservation: {
        reservationId: "123e4567-e89b-42d3-a456-426614174000",
        intentHash: `0x${"11".repeat(32)}`,
        environment: "FORK_WRITE",
        simulationHash: `0x${"33".repeat(32)}`,
        executionFingerprint: `0x${"44".repeat(32)}`,
        createdAt: NOW.toISOString(),
      },
      latestSubmission: null,
      lastError: null,
      lastEventAt: NOW.toISOString(),
      generatedAt: NOW.toISOString(),
    });
    const health = buildOperationalHealth({
      current: null,
      events: [],
      deliveries: [],
      executionStaging,
      now: NOW,
    });
    expect(health.executionStaging.environment).toBe("FORK_WRITE");
    expect(health.executionStaging.submissionPermitted).toBe(true);
    expect(health.runtimeMode).toBe("LIVE_READ_ONLY");
    expect(health.broadcastPermitted).toBe(false);
    expect(health.transactionSubmitted).toBe(false);
  });

  it("reports the current RPC head separately from indexed-through state", () => {
    const health = buildOperationalHealth({
      current: null,
      events: [],
      deliveries: [],
      now: NOW,
      rpcHead: {
        blockNumber: "68060500",
        provider: "https://rpc.xlayer.tech",
        latencyMs: 42,
        reason: null,
      },
    });
    expect(health.rpc.headBlock).toBe("68060500");
    expect(health.rpc.indexedThroughBlock).toBeNull();
    expect(health.rpc.indexLagBlocks).toBeNull();
    expect(health.rpc.provider).toBe("https://rpc.xlayer.tech");
  });

  it("calculates index lag when an archived snapshot trails the RPC head", () => {
    const current = {
      observation: { observedAt: NOW.toISOString() },
      snapshot: {
        snapshotHash: `0x${"77".repeat(32)}`,
        archiveStatus: "COMPLETE",
        consistencyReasons: [],
        observedBlock: "68060442",
        timestamp: NOW.toISOString(),
        freshness: { adapters: [] },
        position: null,
        liquidity: null,
        rwaEvidence: null,
      },
    } as unknown as LiveArchiveHistoryEntry;
    const health = buildOperationalHealth({
      current,
      events: [],
      deliveries: [],
      now: NOW,
      rpcHead: {
        blockNumber: "68060450",
        provider: "https://rpc.xlayer.tech",
        latencyMs: 20,
        reason: null,
      },
    });
    expect(health.rpc.indexedThroughBlock).toBe("68060442");
    expect(health.rpc.indexLagBlocks).toBe("8");
  });
});
