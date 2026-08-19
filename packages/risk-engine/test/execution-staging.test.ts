import { describe, expect, it } from "vitest";
import {
  EgressExecutionStagingWorker,
  executionStagingRequestSchema,
  InMemoryExecutionStagingStore,
  objectHash,
  type ExecutionEnvironmentIdentity,
} from "../src/index.js";
import { createStagingFixture, STAGING_TRANSACTION_HASH } from "./staging-fixture.js";

function workerFor(
  fixture: Awaited<ReturnType<typeof createStagingFixture>>,
  options: {
    store?: InMemoryExecutionStagingStore;
    now?: Date | (() => Date);
    identity?: Partial<ExecutionEnvironmentIdentity>;
    blockHash?: `0x${string}` | null | (() => Promise<`0x${string}` | null>);
    submitter?: { submit: () => Promise<{
      status: "CONFIRMED" | "REVERTED";
      transactionHash: `0x${string}` | null;
      blockNumber: bigint | null;
      gasUsed: bigint | null;
      error?: string | null;
    }> };
  } = {},
) {
  const store = options.store ?? new InMemoryExecutionStagingStore();
  const identity: ExecutionEnvironmentIdentity = {
    environment: "FORK_WRITE",
    chainId: 196,
    anchorBlockHash: fixture.config.anchorBlockHash!,
    forkDetected: true,
    testnetConfigured: false,
    ...options.identity,
  };
  const configuredBlockHash = options.blockHash;
  const worker = new EgressExecutionStagingWorker({
    config: fixture.config,
    snapshotReader: fixture.archive,
    store,
    keeper: fixture.keeper,
    identifyEnvironment: async () => identity,
    readBlockHash: typeof configuredBlockHash === "function"
      ? configuredBlockHash
      : async () => configuredBlockHash === undefined
        ? fixture.snapshot.blockHash as `0x${string}`
        : configuredBlockHash,
    submitter: options.submitter,
    now: () => typeof options.now === "function"
      ? options.now()
      : options.now ?? new Date("2026-08-14T10:00:00.000Z"),
  });
  return { store, worker };
}

describe("isolated Phase 9 execution staging", () => {
  it("rejects unknown action types at the typed request boundary", async () => {
    const fixture = await createStagingFixture();
    expect(executionStagingRequestSchema.safeParse({
      ...fixture.request,
      actionType: "ARBITRARY_CALL",
    }).success).toBe(false);
  });

  it("loads one immutable snapshot, rechecks the bounded policy, and records simulation without submitting", async () => {
    const fixture = await createStagingFixture();
    const { store, worker } = workerFor(fixture);
    const result = await worker.stage(fixture.request);

    expect(result.status).toBe("SIMULATED");
    expect(result.code).toBeNull();
    expect(result.intent?.snapshotHash).toBe(fixture.snapshot.snapshotHash);
    expect(result.simulation?.status).toBe("PASSED");
    expect(result.submission).toBeNull();
    expect(await store.latestIntent()).not.toBeNull();
    expect(await store.latestSimulation()).toMatchObject({ status: "PASSED" });
  });

  it("redacts RPC credentials from immutable simulation failure evidence", async () => {
    const fixture = await createStagingFixture({
      simulationError: new Error(
        "Simulation RPC failed at https://rpc.example.invalid/v2/super-secret?api_key=private-value",
      ),
    });
    const { store, worker } = workerFor(fixture);
    const result = await worker.stage(fixture.request);

    expect(result.status).toBe("REJECTED");
    expect(result.code).toBe("SIMULATION_FAILED");
    expect(result.reason).toContain("[redacted-url]");
    expect(result.reason).not.toContain("super-secret");
    expect(result.simulation?.error).not.toContain("private-value");
    expect(result.simulation?.decision.simulation.error).not.toContain("private-value");
    expect((await store.latestWorkerEvent())?.message).not.toContain("private-value");
  });

  it("replays the same archived snapshot deterministically and does not create a second intent", async () => {
    const fixture = await createStagingFixture();
    const store = new InMemoryExecutionStagingStore();
    const first = await workerFor(fixture, { store }).worker.stage(fixture.request);
    const second = await workerFor(fixture, { store }).worker.stage(fixture.request);

    expect(first.intent?.intentHash).toBe(second.intent?.intentHash);
    expect(first.intent?.requestHash).toBe(second.intent?.requestHash);
    expect(first.simulation?.simulationHash).toBe(second.simulation?.simulationHash);
    expect(second.status).toBe("SIMULATED");
  });

  it("rejects a missing, tampered, stale, or incomplete snapshot before keeper evaluation", async () => {
    const fixture = await createStagingFixture();
    const missing = new EgressExecutionStagingWorker({
      config: fixture.config,
      snapshotReader: { get: async () => null },
      store: new InMemoryExecutionStagingStore(),
      keeper: fixture.keeper,
      identifyEnvironment: async () => ({
        environment: "FORK_WRITE",
        chainId: 196,
        anchorBlockHash: fixture.config.anchorBlockHash!,
        forkDetected: true,
        testnetConfigured: false,
      }),
      readBlockHash: async () => fixture.snapshot.blockHash as `0x${string}`,
      now: () => new Date("2026-08-14T10:00:00.000Z"),
    });
    expect((await missing.stage(fixture.request)).code).toBe("SNAPSHOT_NOT_FOUND");

    const tamperedReader = {
      get: async () => ({
        ...fixture.snapshot,
        position: { ...fixture.snapshot.position!, debtBalanceWei: "999" },
      }),
    };
    const tampered = new EgressExecutionStagingWorker({
      config: fixture.config,
      snapshotReader: tamperedReader,
      store: new InMemoryExecutionStagingStore(),
      keeper: fixture.keeper,
      identifyEnvironment: async () => ({
        environment: "FORK_WRITE",
        chainId: 196,
        anchorBlockHash: fixture.config.anchorBlockHash!,
        forkDetected: true,
        testnetConfigured: false,
      }),
      readBlockHash: async () => fixture.snapshot.blockHash as `0x${string}`,
      now: () => new Date("2026-08-14T10:00:00.000Z"),
    });
    expect((await tampered.stage(fixture.request)).code).toBe("SNAPSHOT_INTEGRITY_FAILURE");

    const staleAt = new Date("2026-08-14T10:10:00.000Z");
    const stalePayload = {
      ...fixture.snapshot,
      createdAt: staleAt.toISOString(),
    };
    const { integrityHash: _integrityHash, ...staleState } = stalePayload;
    const staleSnapshot = {
      ...stalePayload,
      integrityHash: objectHash(staleState),
    };
    const stale = new EgressExecutionStagingWorker({
      config: fixture.config,
      snapshotReader: { get: async () => staleSnapshot },
      store: new InMemoryExecutionStagingStore(),
      keeper: fixture.keeper,
      identifyEnvironment: async () => ({
        environment: "FORK_WRITE",
        chainId: 196,
        anchorBlockHash: fixture.config.anchorBlockHash!,
        forkDetected: true,
        testnetConfigured: false,
      }),
      readBlockHash: async () => fixture.snapshot.blockHash as `0x${string}`,
      now: () => staleAt,
    });
    const freshRequest = executionStagingRequestSchema.parse({
      ...fixture.request,
      requestedAt: staleAt.toISOString(),
    });
    expect((await stale.stage(freshRequest)).code).toBe("STALE_SNAPSHOT");
  });

  it("rejects stale or future-dated staging requests independently of archive insertion time", async () => {
    const fixture = await createStagingFixture();
    const stale = await workerFor(fixture, {
      now: new Date("2026-08-14T10:10:00.000Z"),
    }).worker.stage(fixture.request);
    expect(stale.code).toBe("STALE_REQUEST");

    const futureRequest = executionStagingRequestSchema.parse({
      ...fixture.request,
      requestedAt: "2026-08-14T10:00:06.000Z",
    });
    expect((await workerFor(fixture).worker.stage(futureRequest)).code).toBe("STALE_REQUEST");
  });

  it("rejects wrong environment and wrong chain before loading market state", async () => {
    const fixture = await createStagingFixture();
    const { worker } = workerFor(fixture, {
      identity: { chainId: 195, forkDetected: true },
    });
    expect((await worker.stage(fixture.request)).code).toBe("EXECUTION_ENVIRONMENT_MISMATCH");

    const wrongRequest = executionStagingRequestSchema.parse({
      ...fixture.request,
      environment: "TESTNET_WRITE",
    });
    expect((await worker.stage(wrongRequest)).code).toBe("EXECUTION_ENVIRONMENT_MISMATCH");
  });

  it("rejects a snapshot block absent from the positively identified fork", async () => {
    const fixture = await createStagingFixture();
    const mismatched = await workerFor(fixture, {
      blockHash: `0x${"99".repeat(32)}`,
    }).worker.stage(fixture.request);
    expect(mismatched.status).toBe("UNAVAILABLE");
    expect(mismatched.code).toBe("EXECUTION_ENVIRONMENT_MISMATCH");

    const unavailable = workerFor(fixture, {
      blockHash: async () => { throw new Error("RPC unavailable: https://rpc.example.invalid/v2/super-secret?api_key=private-value"); },
    });
    const unavailableResult = await unavailable.worker.stage(fixture.request);
    expect(unavailableResult.status).toBe("UNAVAILABLE");
    expect(unavailableResult.reason).toMatch(/RPC unavailable/i);
    expect(unavailableResult.reason).not.toContain("super-secret");
    expect((await unavailable.store.latestWorkerEvent())?.message).not.toContain("private-value");
  });

  it("rejects policy, risk, and protocol identity mismatches at the staging boundary", async () => {
    const fixture = await createStagingFixture();
    const wrongPolicy = executionStagingRequestSchema.parse({
      ...fixture.request,
      policy: { ...fixture.request.policy, maxSlippageBps: "101" },
    });
    expect((await workerFor(fixture).worker.stage(wrongPolicy)).code).toBe("AUTHORIZATION_INVALID");

    const wrongRisk = executionStagingRequestSchema.parse({
      ...fixture.request,
      riskEvent: {
        ...fixture.request.riskEvent,
        verdict: { ...fixture.request.riskEvent.verdict, verdictId: "verdict_other" },
      },
    });
    expect((await workerFor(fixture).worker.stage(wrongRisk)).code).toBe("INVALID_RISK_STATE");

    const wrongEgress = {
      ...fixture.config,
      egressContract: "0x4444444444444444444444444444444444444444" as `0x${string}`,
    };
    const wrongContractWorker = new EgressExecutionStagingWorker({
      config: wrongEgress,
      snapshotReader: fixture.archive,
      store: new InMemoryExecutionStagingStore(),
      keeper: fixture.keeper,
      identifyEnvironment: async () => ({
        environment: "FORK_WRITE" as const,
        chainId: 196,
        anchorBlockHash: fixture.config.anchorBlockHash!,
        forkDetected: true,
        testnetConfigured: false,
      }),
      readBlockHash: async () => fixture.snapshot.blockHash as `0x${string}`,
      now: () => new Date("2026-08-14T10:00:00.000Z"),
    });
    expect((await wrongContractWorker.stage(fixture.request)).code).toBe("EXECUTION_ENVIRONMENT_MISMATCH");

    const wrongKeeperWorker = new EgressExecutionStagingWorker({
      config: {
        ...fixture.config,
        keeperAddress: "0x4444444444444444444444444444444444444444",
      },
      snapshotReader: fixture.archive,
      store: new InMemoryExecutionStagingStore(),
      keeper: fixture.keeper,
      identifyEnvironment: async () => ({
        environment: "FORK_WRITE" as const,
        chainId: 196,
        anchorBlockHash: fixture.config.anchorBlockHash!,
        forkDetected: true,
        testnetConfigured: false,
      }),
      readBlockHash: async () => fixture.snapshot.blockHash as `0x${string}`,
      now: () => new Date("2026-08-14T10:00:00.000Z"),
    });
    expect((await wrongKeeperWorker.stage(fixture.request)).code).toBe("AUTHORIZATION_INVALID");

    const widerOffchainPolicy = executionStagingRequestSchema.parse({
      ...fixture.request,
      riskEvent: {
        ...fixture.request.riskEvent,
        policy: {
          ...fixture.request.riskEvent.policy,
          maximumSlippageBps: Number(fixture.request.policy.maxSlippageBps) + 1,
        },
      },
    });
    const widerPolicyResult = await workerFor(fixture).worker.stage(widerOffchainPolicy);
    expect(widerPolicyResult.code).toBe("AUTHORIZATION_INVALID");
    expect(widerPolicyResult.reason).toContain("maximumSlippageBps");
  });

  it("rejects unexpected token, router, and pool address books", async () => {
    const fixture = await createStagingFixture();
    for (const key of ["xbEth", "xeth", "swapRouter", "swapPool"] as const) {
      const protocol = {
        ...fixture.protocol,
        [key]: "0x4444444444444444444444444444444444444444",
      };
      const config = { ...fixture.config, protocol };
      const result = await new EgressExecutionStagingWorker({
        config,
        snapshotReader: fixture.archive,
        store: new InMemoryExecutionStagingStore(),
        keeper: fixture.keeper,
        identifyEnvironment: async () => ({
          environment: "FORK_WRITE",
          chainId: 196,
          anchorBlockHash: fixture.config.anchorBlockHash!,
          forkDetected: true,
          testnetConfigured: false,
        }),
        readBlockHash: async () => fixture.snapshot.blockHash as `0x${string}`,
        now: () => new Date("2026-08-14T10:00:00.000Z"),
      }).stage(fixture.request);
      expect(["REJECTED", "UNAVAILABLE"]).toContain(result.status);
      expect(["INVALID_MARKET_STATE", "EXECUTION_ENVIRONMENT_MISMATCH"]).toContain(result.code);
    }
  });

  it("rejects deterministic amounts outside signed execution bounds", async () => {
    const fixture = await createStagingFixture();
    fixture.event.marketContext!.plan.repayAmountWei = (
      BigInt(fixture.request.policy.maxRepaymentPerExecution) + 1n
    ).toString();
    const result = await workerFor(fixture).worker.stage(fixture.request);
    expect(result.code).toBe("EXECUTION_BOUNDS_EXCEEDED");
  });

  it("rejects insufficient refreshed liquidity without creating an intent", async () => {
    const fixture = await createStagingFixture();
    fixture.event.marketContext!.liquidity.executable = false;
    fixture.event.marketContext!.liquidity.failureReason = "insufficient pool depth";
    fixture.event.marketContext!.plan.executable = false;
    fixture.event.marketContext!.plan.failureReason = "quote cannot cover flash loan";
    const { store, worker } = workerFor(fixture);
    const result = await worker.stage(fixture.request);
    expect(result.status).toBe("REJECTED");
    expect(result.code).toBe("INVALID_MARKET_STATE");
    expect(await store.latestIntent()).toBeNull();
  });

  it("records a failed simulation immutably and never calls a submitter", async () => {
    const fixture = await createStagingFixture({ simulationError: new Error("unsafe post health factor") });
    let submits = 0;
    const { store, worker } = workerFor(fixture, {
      submitter: { submit: async () => { submits += 1; throw new Error("must not run"); } },
    });
    fixture.config.submissionEnabled = true;
    const result = await worker.stage(fixture.request);

    expect(result.status).toBe("REJECTED");
    expect(result.code).toBe("SIMULATION_FAILED");
    expect(result.simulation?.status).toBe("FAILED");
    expect(submits).toBe(0);
    expect(await store.latestSimulation()).toMatchObject({ status: "FAILED" });
  });

  it("uses one immutable submission reservation and keeps a duplicate attempt from broadcasting", async () => {
    const fixture = await createStagingFixture({ submissionEnabled: true });
    fixture.config.submissionEnabled = true;
    let submits = 0;
    const submitter = {
      submit: async () => {
        submits += 1;
        return {
          status: "CONFIRMED" as const,
          transactionHash: STAGING_TRANSACTION_HASH,
          blockNumber: 67_881_250n,
          gasUsed: 900_000n,
        };
      },
    };
    const store = new InMemoryExecutionStagingStore();
    const first = await workerFor(fixture, { store, submitter }).worker.stage(fixture.request);
    const second = await workerFor(fixture, { store, submitter }).worker.stage(fixture.request);

    expect(first.status).toBe("CONFIRMED");
    expect(first.submission?.transactionHash).toBe(STAGING_TRANSACTION_HASH);
    expect(second.status).toBe("REJECTED");
    expect(second.code).toBe("DUPLICATE_EXECUTION");
    expect(submits).toBe(1);
  });

  it("keeps concurrent duplicate attempts idempotent", async () => {
    const fixture = await createStagingFixture({ submissionEnabled: true });
    fixture.config.submissionEnabled = true;
    let submits = 0;
    const submitter = {
      submit: async () => {
        submits += 1;
        return {
          status: "CONFIRMED" as const,
          transactionHash: STAGING_TRANSACTION_HASH,
          blockNumber: 67_881_250n,
          gasUsed: 900_000n,
        };
      },
    };
    const store = new InMemoryExecutionStagingStore();
    const [left, right] = await Promise.all([
      workerFor(fixture, { store, submitter }).worker.stage(fixture.request),
      workerFor(fixture, { store, submitter }).worker.stage(fixture.request),
    ]);
    expect([left.status, right.status].sort()).toEqual(["CONFIRMED", "REJECTED"]);
    expect(submits).toBe(1);
  });

  it("fails closed on staging-store failure before submission", async () => {
    const fixture = await createStagingFixture({ submissionEnabled: true });
    fixture.config.submissionEnabled = true;
    let submits = 0;
    class FailingIntentStore extends InMemoryExecutionStagingStore {
      override async saveIntent(): Promise<never> {
        throw new Error("database unavailable");
      }
    }
    const result = await workerFor(fixture, {
      store: new FailingIntentStore(),
      submitter: {
        submit: async () => {
          submits += 1;
          throw new Error("database failure must prevent submission");
        },
      },
    }).worker.stage(fixture.request);
    expect(result.status).toBe("REJECTED");
    expect(result.reason).toMatch(/database unavailable/i);
    expect(submits).toBe(0);
  });

  it("rechecks the typed deadline immediately before submission", async () => {
    const fixture = await createStagingFixture({ submissionEnabled: true });
    fixture.config.submissionEnabled = true;
    fixture.config.maxIntentAgeSeconds = 3_600;
    let nowCalls = 0;
    let submits = 0;
    const result = await workerFor(fixture, {
      now: () => {
        nowCalls += 1;
        return nowCalls === 1
          ? new Date("2026-08-14T10:00:00.000Z")
          : new Date("2026-08-14T10:02:01.000Z");
      },
      submitter: {
        submit: async () => {
          submits += 1;
          throw new Error("expired intent must not submit");
        },
      },
    }).worker.stage(fixture.request);
    expect(result.code).toBe("EXPIRED_INTENT");
    expect(submits).toBe(0);
  });

  it("keeps the canonical observation reader write-free", async () => {
    const fixture = await createStagingFixture();
    const before = fixture.snapshot.integrityHash;
    const historyBefore = await fixture.archive.history();
    const revisionBefore = await fixture.sourceStore.getRevision(
      fixture.request.riskEvent.verdict.sourceRevisionIds[0]!,
    );
    const result = await workerFor(fixture).worker.stage(fixture.request);
    expect(result.status).toBe("SIMULATED");
    expect((await fixture.archive.get(fixture.snapshot.snapshotHash))?.integrityHash).toBe(before);
    expect(await fixture.archive.history()).toEqual(historyBefore);
    expect(await fixture.sourceStore.getRevision(revisionBefore!.revisionId)).toEqual(revisionBefore);
  });
});
