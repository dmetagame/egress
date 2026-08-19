import { access, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  assertPhase11DeploymentStartupSafe,
  confirmedPhase11DeploymentTransactions,
  createPhase11DeploymentJournal,
  executePhase11DeploymentTransaction,
  finalizePhase11DeploymentTransaction,
  finalizePhase11DeploymentJournal,
  loadPhase11DeploymentJournal,
  persistFinalPhase11Manifest,
  persistNewPhase11DeploymentJournal,
  persistPhase11DeploymentJournal,
  PHASE11_DEPLOYMENT_JOURNAL_SCHEMA_VERSION,
  PHASE11_DEPLOYMENT_SEQUENCE,
  validatePhase11DeploymentJournal,
  type Phase11TransactionIntent,
} from "../src/index.js";
import {
  createTestnetManifestFixture,
  testnetTransactionInput,
} from "./testnet-deployment-fixture.js";

describe("Phase 11 deployment journal", () => {
  it("creates the initial journal exclusively and never overwrites it", async () => withHarness(async (harness) => {
    const existing = await loadPhase11DeploymentJournal(harness.journalPath);
    expect(existing.schemaVersion).toBe(PHASE11_DEPLOYMENT_JOURNAL_SCHEMA_VERSION);
    await expect(persistNewPhase11DeploymentJournal(harness.journalPath, existing)).rejects.toThrow(
      /refusing to overwrite existing Phase 11 file/i,
    );
    expect(await loadPhase11DeploymentJournal(harness.journalPath)).toEqual(existing);
  }));

  it.each(PHASE11_DEPLOYMENT_SEQUENCE)(
    "persists a non-replayable incomplete step when broadcast fails at step $sequence",
    async (failedStep) => withHarness(async (harness) => {
      let broadcasts = 0;
      for (let sequence = 1; sequence < failedStep.sequence; sequence += 1) {
        await executeConfirmed(harness, sequence, () => { broadcasts += 1; });
      }

      await expect(executePhase11DeploymentTransaction({
        journalPath: harness.journalPath,
        intent: transactionIntent(harness, failedStep.sequence),
        broadcast: async () => {
          broadcasts += 1;
          throw new Error("simulated broadcast failure");
        },
        waitForReceipt: async () => receiptFor(harness, failedStep.sequence),
        waitForSafeInclusion: async () => safeInclusionFor(harness, failedStep.sequence),
      })).rejects.toThrow(/returned no transaction hash|automatic rebroadcast is forbidden/i);

      const journal = await loadPhase11DeploymentJournal(harness.journalPath);
      expect(journal.steps.slice(0, failedStep.sequence - 1).every((step) => step.status === "SAFE_INCLUDED")).toBe(true);
      expect(journal.steps[failedStep.sequence - 1]).toMatchObject({
        status: "UNKNOWN",
        transactionHash: null,
        initialInclusion: null,
        safeInclusion: null,
        finalizedInclusion: null,
      });
      expect(journal.status).toBe("RECONCILIATION_REQUIRED");
      expect(await exists(harness.manifestPath)).toBe(false);
      await expect(assertPhase11DeploymentStartupSafe(startupIdentity(harness))).rejects.toThrow(
        /journal already exists|automatic rerun is forbidden/i,
      );
      await expect(executePhase11DeploymentTransaction({
        journalPath: harness.journalPath,
        intent: transactionIntent(harness, failedStep.sequence),
        broadcast: async () => {
          broadcasts += 1;
          return harness.manifest.deploymentTransactions[failedStep.sequence - 1]!.transactionHash;
        },
        waitForReceipt: async () => receiptFor(harness, failedStep.sequence),
        waitForSafeInclusion: async () => safeInclusionFor(harness, failedStep.sequence),
      })).rejects.toThrow(/forbids further deployment|replay is forbidden/i);
      expect(broadcasts).toBe(failedStep.sequence);
    }),
  );

  it.each([
    "process termination immediately after broadcast",
    "receipt timeout",
    "RPC failure after broadcast",
  ])("persists the hash and requires reconciliation on %s", async () => withHarness(async (harness) => {
    let broadcasts = 0;
    const record = harness.manifest.deploymentTransactions[0]!;
    await expect(executePhase11DeploymentTransaction({
      journalPath: harness.journalPath,
      intent: transactionIntent(harness, 1),
      broadcast: async () => {
        broadcasts += 1;
        return record.transactionHash;
      },
      waitForReceipt: async () => {
        throw new Error("simulated interruption");
      },
      waitForSafeInclusion: async () => safeInclusionFor(harness, 1),
    })).rejects.toThrow(/reconcile sender.*nonce.*transaction|automatic continuation/i);

    const journal = await loadPhase11DeploymentJournal(harness.journalPath);
    expect(journal.status).toBe("RECONCILIATION_REQUIRED");
    expect(journal.steps[0]).toMatchObject({
      status: "BROADCAST_UNKNOWN",
      transactionHash: record.transactionHash,
      initialInclusion: null,
      safeInclusion: null,
      finalizedInclusion: null,
    });
    await expect(executePhase11DeploymentTransaction({
      journalPath: harness.journalPath,
      intent: transactionIntent(harness, 1),
      broadcast: async () => {
        broadcasts += 1;
        return record.transactionHash;
      },
      waitForReceipt: async () => receiptFor(harness, 1),
      waitForSafeInclusion: async () => safeInclusionFor(harness, 1),
    })).rejects.toThrow(/forbids further deployment|replay is forbidden/i);
    expect(broadcasts).toBe(1);
  }));

  it("records UNKNOWN when broadcast throws before a hash is available", async () => withHarness(async (harness) => {
    await expect(executePhase11DeploymentTransaction({
      journalPath: harness.journalPath,
      intent: transactionIntent(harness, 1),
      broadcast: async () => {
        throw new Error("simulated send failure");
      },
      waitForReceipt: async () => receiptFor(harness, 1),
      waitForSafeInclusion: async () => safeInclusionFor(harness, 1),
    })).rejects.toThrow(/returned no transaction hash|automatic rebroadcast is forbidden/i);
    const journal = await loadPhase11DeploymentJournal(harness.journalPath);
    expect(journal.status).toBe("RECONCILIATION_REQUIRED");
    expect(journal.steps[0]).toMatchObject({ status: "UNKNOWN", transactionHash: null });
  }));

  it("persists a reverted receipt as FAILED without inventing a contract address", async () => withHarness(async (harness) => {
    const record = harness.manifest.deploymentTransactions[0]!;
    await expect(executePhase11DeploymentTransaction({
      journalPath: harness.journalPath,
      intent: transactionIntent(harness, 1),
      broadcast: async () => record.transactionHash,
      waitForReceipt: async () => ({
        ...receiptFor(harness, 1),
        status: "reverted",
        contractAddress: null,
      }),
      waitForSafeInclusion: async () => safeInclusionFor(harness, 1),
    })).rejects.toThrow(/reverted.*reconciliation is required/i);
    const journal = await loadPhase11DeploymentJournal(harness.journalPath);
    expect(journal.status).toBe("RECONCILIATION_REQUIRED");
    expect(journal.steps[0]).toMatchObject({
      status: "FAILED",
      initialInclusion: expect.objectContaining({
        receiptStatus: "REVERTED",
        blockNumber: record.initialInclusion.blockNumber,
        blockHash: record.initialInclusion.blockHash,
      }),
      contractAddress: null,
    });
  }));

  it("persists the confirmed receipt block hash in journal and manifest provenance", async () => withHarness(
    async (harness) => {
      await executeConfirmed(harness, 1);
      const record = harness.manifest.deploymentTransactions[0]!;
      const journal = await loadPhase11DeploymentJournal(harness.journalPath);
      expect(journal.steps[0]).toMatchObject({
        status: "SAFE_INCLUDED",
        transactionHash: record.transactionHash,
        initialInclusion: expect.objectContaining({
          blockNumber: record.initialInclusion.blockNumber,
          blockHash: record.initialInclusion.blockHash,
          transactionIndex: record.initialInclusion.transactionIndex,
        }),
        safeInclusion: expect.objectContaining({
          blockNumber: record.safeInclusion.blockNumber,
          blockHash: record.safeInclusion.blockHash,
          transactionIndex: record.safeInclusion.transactionIndex,
        }),
      });
    },
  ));

  it.each([
    ["missing", undefined],
    ["malformed", "0x1234"],
  ])("fails closed when a confirmed receipt block hash is %s", async (_label, blockHash) => withHarness(
    async (harness) => {
      const record = harness.manifest.deploymentTransactions[0]!;
      await expect(executePhase11DeploymentTransaction({
        journalPath: harness.journalPath,
        intent: transactionIntent(harness, 1),
        broadcast: async () => record.transactionHash,
        waitForReceipt: async () => ({
          ...receiptFor(harness, 1),
          blockHash,
        } as never),
        waitForSafeInclusion: async () => safeInclusionFor(harness, 1),
      })).rejects.toThrow(/block hash(?: or transaction index)? is missing or malformed.*automatic continuation is forbidden/i);
      const journal = await loadPhase11DeploymentJournal(harness.journalPath);
      expect(journal.status).toBe("RECONCILIATION_REQUIRED");
      expect(journal.steps[0]).toMatchObject({
        status: "BROADCAST_UNKNOWN",
        transactionHash: record.transactionHash,
        initialInclusion: null,
        safeInclusion: null,
        finalizedInclusion: null,
      });
    },
  ));

  it("rejects legacy or confirmed journal evidence without a block hash", async () => withHarness(
    async (harness) => {
      const initial = await loadPhase11DeploymentJournal(harness.journalPath);
      expect(() => validatePhase11DeploymentJournal({ ...initial, schemaVersion: 1 })).toThrow();

      await executeConfirmed(harness, 1);
      const confirmed = structuredClone(await loadPhase11DeploymentJournal(harness.journalPath));
      delete (confirmed.steps[0]!.initialInclusion as { blockHash?: string }).blockHash;
      expect(() => validatePhase11DeploymentJournal(confirmed)).toThrow(/blockHash|invalid_type/i);
    },
  ));

  it("fails closed when the RPC returns a duplicate transaction hash", async () => withHarness(async (harness) => {
    await executeConfirmed(harness, 1);
    const firstHash = harness.manifest.deploymentTransactions[0]!.transactionHash;
    let broadcasts = 0;
    await expect(executePhase11DeploymentTransaction({
      journalPath: harness.journalPath,
      intent: transactionIntent(harness, 2),
      broadcast: async () => {
        broadcasts += 1;
        return firstHash;
      },
      waitForReceipt: async () => receiptFor(harness, 2),
      waitForSafeInclusion: async () => safeInclusionFor(harness, 2),
    })).rejects.toThrow(/transaction hash already used|reconcile sender/i);
    const journal = await loadPhase11DeploymentJournal(harness.journalPath);
    expect(journal.status).toBe("RECONCILIATION_REQUIRED");
    expect(journal.steps[1]).toMatchObject({
      status: "BROADCAST_UNKNOWN",
      transactionHash: firstHash,
      initialInclusion: null,
      safeInclusion: null,
      finalizedInclusion: null,
    });
    expect(broadcasts).toBe(1);
  }));

  it("rejects an unexpected configuration target before broadcast", async () => withHarness(async (harness) => {
    await executeConfirmed(harness, 1);
    await executeConfirmed(harness, 2);
    await executeConfirmed(harness, 3);
    await executeConfirmed(harness, 4);
    await executeConfirmed(harness, 5);
    await executeConfirmed(harness, 6);
    await executeConfirmed(harness, 7);
    let broadcasts = 0;
    await expect(executePhase11DeploymentTransaction({
      journalPath: harness.journalPath,
      intent: {
        ...transactionIntent(harness, 8),
        to: harness.manifest.keeper,
      },
      broadcast: async () => {
        broadcasts += 1;
        return harness.manifest.deploymentTransactions[7]!.transactionHash;
      },
      waitForReceipt: async () => receiptFor(harness, 8),
      waitForSafeInclusion: async () => safeInclusionFor(harness, 8),
    })).rejects.toThrow(/target does not match/i);
    expect(broadcasts).toBe(0);
    expect((await loadPhase11DeploymentJournal(harness.journalPath)).steps[7]!.status).toBe("PLANNED");
  }));

  it("refuses a configured starting nonce that differs from the deployer pending nonce", async () => withHarness(
    async (harness) => {
      await rm(harness.journalPath);
      await expect(assertPhase11DeploymentStartupSafe({
        ...startupIdentity(harness),
        observedPendingNonce: Number(harness.manifest.startingNonce) + 1,
      })).rejects.toThrow(/pending nonce.*does not match configured starting nonce/i);
      expect(await exists(harness.journalPath)).toBe(false);
    },
  ));

  it("refuses a journal path that aliases the final manifest path", async () => withHarness(async (harness) => {
    await rm(harness.journalPath);
    await expect(assertPhase11DeploymentStartupSafe({
      ...startupIdentity(harness),
      journalPath: harness.manifestPath,
    })).rejects.toThrow(/journal path must be distinct from the final manifest path/i);
  }));

  it("refuses an existing journal, a mismatched journal identity, and an existing final manifest", async () => {
    await withHarness(async (harness) => {
      await expect(assertPhase11DeploymentStartupSafe(startupIdentity(harness))).rejects.toThrow(/journal already exists/i);
      await expect(assertPhase11DeploymentStartupSafe({
        ...startupIdentity(harness),
        deploymentId: `0x${"91".repeat(32)}`,
        configurationHash: `0x${"92".repeat(32)}`,
      })).rejects.toThrow(/configuration differs.*deployment ID.*configuration hash/i);
    });
    await withHarness(async (harness) => {
      await rm(harness.journalPath);
      await persistFinalPhase11Manifest(harness.manifestPath, harness.manifest);
      await expect(assertPhase11DeploymentStartupSafe(startupIdentity(harness))).rejects.toThrow(
        /final manifest already exists.*overwrite is forbidden/i,
      );
    });
  });

  it("requires all 26 confirmations and never overwrites the final manifest", async () => withHarness(async (harness) => {
    for (let sequence = 1; sequence <= 25; sequence += 1) await executeConfirmed(harness, sequence);
    const incomplete = await loadPhase11DeploymentJournal(harness.journalPath);
    expect(() => confirmedPhase11DeploymentTransactions(incomplete)).toThrow(/complete finalized deployment journal/i);
    expect(await exists(harness.manifestPath)).toBe(false);

    await executeConfirmed(harness, 26);
    for (let sequence = 1; sequence <= 26; sequence += 1) {
      await finalizePhase11DeploymentTransaction({
        journalPath: harness.journalPath,
        sequence,
        waitForFinalizedInclusion: async () => {
          const record = harness.manifest.deploymentTransactions[sequence - 1]!;
          return record.finalizedInclusion;
        },
      });
    }
    const complete = await loadPhase11DeploymentJournal(harness.journalPath);
    const provenance = confirmedPhase11DeploymentTransactions(complete);
    expect(provenance).toHaveLength(26);
    await persistFinalPhase11Manifest(harness.manifestPath, harness.manifest);
    await expect(persistFinalPhase11Manifest(harness.manifestPath, harness.manifest)).rejects.toThrow(
      /refusing to overwrite existing Phase 11 file/i,
    );
    const finalized = finalizePhase11DeploymentJournal(
      complete,
      harness.manifest.manifestHash,
      "2026-08-17T12:00:00.000Z",
    );
    await persistPhase11DeploymentJournal(harness.journalPath, finalized);
    expect((await loadPhase11DeploymentJournal(harness.journalPath)).status).toBe("FINALIZED");
  }));
});

type Harness = Awaited<ReturnType<typeof createHarness>>;

async function withHarness(run: (harness: Harness) => Promise<void>): Promise<void> {
  const harness = await createHarness();
  try {
    await run(harness);
  } finally {
    await rm(harness.directory, { recursive: true, force: true });
  }
}

async function createHarness() {
  const directory = await mkdtemp(join(tmpdir(), "egress-phase11-journal-"));
  const manifestPath = join(directory, "xlayer-testnet.json");
  const journalPath = `${manifestPath}.journal.json`;
  const manifest = createTestnetManifestFixture();
  await persistNewPhase11DeploymentJournal(journalPath, createPhase11DeploymentJournal({
    deploymentId: manifest.deploymentId,
    chainId: manifest.chainId,
    environmentId: manifest.environmentId,
    deployer: manifest.guardian,
    startingNonce: manifest.startingNonce,
    configurationHash: manifest.configurationHash,
    createdAt: "2026-08-17T10:00:00.000Z",
  }));
  return { directory, manifestPath, journalPath, manifest };
}

function startupIdentity(harness: Harness) {
  return {
    manifestPath: harness.manifestPath,
    journalPath: harness.journalPath,
    deploymentId: harness.manifest.deploymentId,
    chainId: harness.manifest.chainId,
    environmentId: harness.manifest.environmentId,
    deployer: harness.manifest.guardian,
    startingNonce: harness.manifest.startingNonce,
    configurationHash: harness.manifest.configurationHash,
  };
}

function transactionIntent(harness: Harness, sequence: number): Phase11TransactionIntent {
  const record = harness.manifest.deploymentTransactions[sequence - 1];
  if (!record) throw new Error(`Missing fixture transaction ${sequence}.`);
  return {
    deploymentId: harness.manifest.deploymentId,
    chainId: harness.manifest.chainId,
    environmentId: harness.manifest.environmentId,
    sequence,
    actionId: record.actionId,
    from: record.from,
    nonce: Number(record.nonce),
    to: record.to,
    value: BigInt(record.value),
    data: testnetTransactionInput(sequence),
  };
}

function receiptFor(harness: Harness, sequence: number) {
  const record = harness.manifest.deploymentTransactions[sequence - 1];
  if (!record) throw new Error(`Missing fixture transaction ${sequence}.`);
  return {
    transactionHash: record.transactionHash,
    status: "success" as const,
    blockNumber: BigInt(record.initialInclusion.blockNumber),
    blockHash: record.initialInclusion.blockHash,
    transactionIndex: Number(record.initialInclusion.transactionIndex),
    contractAddress: record.contractAddress,
    from: record.from,
    to: record.to,
  };
}

function safeInclusionFor(harness: Harness, sequence: number) {
  const record = harness.manifest.deploymentTransactions[sequence - 1];
  if (!record) throw new Error(`Missing fixture transaction ${sequence}.`);
  return record.safeInclusion;
}

async function executeConfirmed(
  harness: Harness,
  sequence: number,
  onBroadcast: () => void = () => undefined,
): Promise<void> {
  const record = harness.manifest.deploymentTransactions[sequence - 1];
  if (!record) throw new Error(`Missing fixture transaction ${sequence}.`);
  await executePhase11DeploymentTransaction({
    journalPath: harness.journalPath,
    intent: transactionIntent(harness, sequence),
    broadcast: async () => {
      onBroadcast();
      return record.transactionHash;
    },
    waitForReceipt: async () => receiptFor(harness, sequence),
    waitForSafeInclusion: async () => record.safeInclusion,
  });
}

async function exists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}
