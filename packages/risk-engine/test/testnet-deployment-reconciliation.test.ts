import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { describe, expect, it } from "vitest";
import {
  getContractAddress,
  keccak256,
  type Address,
  type Hex,
  type PublicClient,
} from "viem";
import {
  Phase11DeploymentFinalityError,
  Phase11DeploymentReconciliationError,
  PHASE11_DEPLOYMENT_SEQUENCE,
  persistPhase11ReconciliationArtifact,
  phase11FinalityExpectationFromProvenance,
  readPhase11CanonicalInclusion,
  reconcilePhase11Deployment,
  verifyPhase11ReconciliationArtifact,
  XLAYER_TESTNET_PUBLIC_RPC,
  type Phase11FinalityExpectation,
} from "../src/index.js";
import {
  createTestnetManifestFixture,
  testnetTransactionInput,
} from "./testnet-deployment-fixture.js";

const RPC = XLAYER_TESTNET_PUBLIC_RPC;
const NOW = "2026-08-18T00:00:00.000Z";
const SAFE_HEAD = `0x${"aa".repeat(32)}` as Hex;
const FINALIZED_HEAD = `0x${"bb".repeat(32)}` as Hex;

describe("Phase 11 finality-aware deployment reconciliation", () => {
  it("reconciles all 26 transactions and preserves unsafe-to-safe re-inclusion", async () => {
    await withLegacyJournal(async ({ path, manifest, initialBytes }) => {
      const changedSteps = new Set([3, 5, 10, 17, 18]);
      const artifact = await reconcilePhase11Deployment({
        journalPath: path,
        rpcEndpoint: RPC,
        client: chainIdClient(),
        now: () => new Date(NOW),
        readCanonicalInclusion: async (_client, input) => {
          const record = manifest.deploymentTransactions[input.expectation.sequence - 1]!;
          const changed = changedSteps.has(input.expectation.sequence);
          const blockHash = changed ? `0x${String(input.expectation.sequence).padStart(2, "0").repeat(32)}` as Hex : record.safeInclusion.blockHash;
          return {
            ...(input.stage === "SAFE_CANONICAL" ? record.safeInclusion : record.finalizedInclusion),
            stage: input.stage,
            blockHash,
            finalityHeadBlockNumber: "999999",
            finalityHeadBlockHash: input.stage === "SAFE_CANONICAL" ? SAFE_HEAD : FINALIZED_HEAD,
            observedAt: NOW,
          } as never;
        },
        verifyRuntime: async () => runtimeFixture(manifest.protocolConfigHash, manifest.scenario.policyId),
      });

      expect(artifact.overallStatus).toBe("PASS");
      expect(artifact.transactions).toHaveLength(26);
      expect(artifact.transactions.map((record) => record.nonce)).toEqual(
        Array.from({ length: 26 }, (_, index) => String(100 + index)),
      );
      expect(artifact.transactions[2]).toMatchObject({
        INITIAL_UNSAFE_BLOCK_HASH: manifest.deploymentTransactions[2]!.initialInclusion.blockHash,
        SAFE_CANONICAL_BLOCK_HASH: `0x03${"03".repeat(31)}`,
        FINALIZED_CANONICAL_BLOCK_HASH: `0x03${"03".repeat(31)}`,
        reIncluded: true,
      });
      expect(artifact.deploymentAnchor.sequence).toBe(26);
      expect(artifact.deploymentAnchor.transactionHash).toBe(
        manifest.deploymentTransactions[25]!.transactionHash,
      );
      expect(artifact.artifactHash).toMatch(/^0x[0-9a-f]{64}$/);
      expect((await readFile(path)).toString()).toBe(initialBytes);
    });
  });

  it("writes an exclusive, tamper-evident artifact without touching the journal", async () => {
    await withLegacyJournal(async ({ path, artifactPath, manifest, initialBytes }) => {
      const artifact = await reconcileWithFixture(path, manifest);
      await persistPhase11ReconciliationArtifact(artifactPath, artifact);
      const persisted = verifyPhase11ReconciliationArtifact(
        JSON.parse(await readFile(artifactPath, "utf8")),
      );
      expect(persisted.artifactHash).toBe(artifact.artifactHash);
      await expect(persistPhase11ReconciliationArtifact(artifactPath, artifact)).rejects.toThrow(
        /overwrite existing reconciliation artifact/i,
      );
      await expect(persistPhase11ReconciliationArtifact(path, artifact)).rejects.toThrow(
        /distinct from the immutable journal/i,
      );
      expect((await readFile(path)).toString()).toBe(initialBytes);
    });
  });

  it("does not publish a final manifest from the legacy journal", async () => {
    await withLegacyJournal(async ({ path, manifest }) => {
      await reconcileWithFixture(path, manifest);
      await expect(readFile(join(path, "..", "xlayer-testnet.json"), "utf8")).rejects.toMatchObject({
        code: "ENOENT",
      });
    });
  });

  it.each([
    ["safe", "SAFE_CANONICAL"],
    ["finalized", "FINALIZED_CANONICAL"],
  ] as const)("fails closed when the %s tag does not cover the transaction", async (_label, stage) => {
    await withLegacyJournal(async ({ path, manifest }) => {
      await expect(reconcilePhase11Deployment({
        journalPath: path,
        rpcEndpoint: RPC,
        client: chainIdClient(),
        readCanonicalInclusion: async (_client, input) => {
          if (input.stage === stage) throw new Phase11DeploymentFinalityError("finality head does not cover transaction block");
          return canonicalFor(manifest, input);
        },
        verifyRuntime: async () => runtimeFixture(manifest.protocolConfigHash, manifest.scenario.policyId),
      })).rejects.toThrow(/canonical.*finality head does not cover/i);
    });
  });

  it.each([
    "receipt/block hash mismatch",
    "transaction is not present at its receipt index",
    "RPC request failed",
  ])("fails closed on partial reconciliation failure: %s", async (message) => {
    await withLegacyJournal(async ({ path, manifest }) => {
      await expect(reconcilePhase11Deployment({
        journalPath: path,
        rpcEndpoint: RPC,
        client: chainIdClient(),
        readCanonicalInclusion: async (_client, input) => {
          if (input.expectation.sequence === 2) throw new Phase11DeploymentFinalityError(message);
          return canonicalFor(manifest, input);
        },
        verifyRuntime: async () => runtimeFixture(manifest.protocolConfigHash, manifest.scenario.policyId),
      })).rejects.toThrow(new RegExp(`canonical.*${message.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`, "i"));
    });
  });

  it("refuses a changed journal before continuing and remains read-only", async () => {
    await withLegacyJournal(async ({ path, manifest }) => {
      let calls = 0;
      const client = chainIdClient({
        sendTransaction: async () => {
          throw new Error("write method must not be called");
        },
      });
      await expect(reconcilePhase11Deployment({
        journalPath: path,
        rpcEndpoint: RPC,
        client,
        readCanonicalInclusion: async (_client, input) => {
          calls += 1;
          if (calls === 1) {
            const changed = JSON.parse(await readFile(path, "utf8"));
            changed.updatedAt = "2026-08-18T00:01:00.000Z";
            await writeFile(path, `${JSON.stringify(changed, null, 2)}\n`, "utf8");
          }
          return canonicalFor(manifest, input);
        },
        verifyRuntime: async () => runtimeFixture(manifest.protocolConfigHash, manifest.scenario.policyId),
      })).rejects.toThrow(/journal changed during reconciliation/i);
    });
  });

  it("rejects duplicate or missing transaction hashes before RPC reconciliation", async () => {
    await withLegacyJournal(async ({ path, raw }) => {
      const duplicate = JSON.parse(raw);
      duplicate.steps[1].transactionHash = duplicate.steps[0].transactionHash;
      await writeFile(path, `${JSON.stringify(duplicate, null, 2)}\n`, "utf8");
      await expect(reconcilePhase11Deployment({
        journalPath: path,
        rpcEndpoint: RPC,
        client: chainIdClient(),
      })).rejects.toThrow(/invalid|duplicated/i);
    });

    await withLegacyJournal(async ({ path, raw }) => {
      const missing = JSON.parse(raw);
      missing.steps[1].transactionHash = null;
      await writeFile(path, `${JSON.stringify(missing, null, 2)}\n`, "utf8");
      await expect(reconcilePhase11Deployment({
        journalPath: path,
        rpcEndpoint: RPC,
        client: chainIdClient(),
      })).rejects.toThrow(/invalid|incomplete/i);
    });
  });

  it.each([
    ["hash", (tx: Record<string, unknown>) => { tx.hash = `0x${"22".repeat(32)}`; }],
    ["sender", (tx: Record<string, unknown>) => { tx.from = "0x0000000000000000000000000000000000000001"; }],
    ["nonce", (tx: Record<string, unknown>) => { tx.nonce = 999; }],
    ["target", (tx: Record<string, unknown>) => { tx.to = "0x0000000000000000000000000000000000000001"; }],
    ["calldata", (tx: Record<string, unknown>) => { tx.input = "0x1234"; }],
  ] as const)("rejects a changed %s in canonical transaction evidence", async (_label, mutate) => {
    const manifest = createTestnetManifestFixture();
    const record = manifest.deploymentTransactions[0]!;
    const expectation = phase11FinalityExpectationFromProvenance({
      transactionHash: record.transactionHash,
      chainId: record.chainId,
      sequence: record.sequence,
      from: record.from,
      nonce: record.nonce,
      to: record.to,
      value: record.value,
      calldataHash: record.calldataHash,
      contractAddress: record.contractAddress,
    });
    const tx = canonicalTransaction(expectation);
    mutate(tx);
    await expect(readPhase11CanonicalInclusion(canonicalClient({ expectation, transaction: tx }), {
      expectation,
      stage: "SAFE_CANONICAL",
    })).rejects.toThrow(new RegExp(`${_label}(?: hash)? mismatch`, "i"));
  });

  it("rejects malformed block hashes, receipt/block mismatch, missing inclusion, and CREATE mismatch", async () => {
    const manifest = createTestnetManifestFixture();
    const record = manifest.deploymentTransactions[0]!;
    const expectation = phase11FinalityExpectationFromProvenance({
      transactionHash: record.transactionHash,
      chainId: record.chainId,
      sequence: record.sequence,
      from: record.from,
      nonce: record.nonce,
      to: record.to,
      value: record.value,
      calldataHash: record.calldataHash,
      contractAddress: record.contractAddress,
    });
    await expect(readPhase11CanonicalInclusion(canonicalClient({ expectation, receiptBlockHash: "0x1234" as Hex }), {
      expectation,
      stage: "SAFE_CANONICAL",
    })).rejects.toThrow(/block evidence/i);
    await expect(readPhase11CanonicalInclusion(canonicalClient({ expectation, blockHash: `0x${"cd".repeat(32)}` as Hex }), {
      expectation,
      stage: "SAFE_CANONICAL",
    })).rejects.toThrow(/receipt\/block hash mismatch/i);
    await expect(readPhase11CanonicalInclusion(canonicalClient({ expectation, includeTransaction: false }), {
      expectation,
      stage: "SAFE_CANONICAL",
    })).rejects.toThrow(/not present/i);
    await expect(readPhase11CanonicalInclusion(canonicalClient({ expectation, contractAddress: "0x0000000000000000000000000000000000000001" }), {
      expectation,
      stage: "SAFE_CANONICAL",
    })).rejects.toThrow(/CREATE address mismatch/i);
  });
});

async function reconcileWithFixture(path: string, manifest: ReturnType<typeof createTestnetManifestFixture>) {
  return reconcilePhase11Deployment({
    journalPath: path,
    rpcEndpoint: RPC,
    client: chainIdClient(),
    now: () => new Date(NOW),
    readCanonicalInclusion: async (_client, input) => canonicalFor(manifest, input),
    verifyRuntime: async () => runtimeFixture(manifest.protocolConfigHash, manifest.scenario.policyId),
  });
}

function canonicalFor(
  manifest: ReturnType<typeof createTestnetManifestFixture>,
  input: { expectation: Phase11FinalityExpectation; stage: "SAFE_CANONICAL" | "FINALIZED_CANONICAL" },
) {
  const record = manifest.deploymentTransactions[input.expectation.sequence - 1]!;
  return {
    ...(input.stage === "SAFE_CANONICAL" ? record.safeInclusion : record.finalizedInclusion),
    stage: input.stage,
    observedAt: NOW,
  } as never;
}

function runtimeFixture(protocolConfigHash: Hex, policyId: Hex) {
  return {
    status: "PASS" as const,
    contractAddresses: {},
    protocolConfigHash,
    policyId,
    borrower: "0x0000000000000000000000000000000000000003" as Address,
    keeper: "0x0000000000000000000000000000000000000002" as Address,
    riskAttestor: "0x0000000000000000000000000000000000000004" as Address,
    policyActive: true as const,
    protocolRelationshipsVerified: true as const,
    tokenMetadataVerified: true as const,
    oracleStateVerified: true as const,
  };
}

function chainIdClient(overrides: Record<string, unknown> = {}): PublicClient {
  return {
    getChainId: async () => 1952,
    ...overrides,
  } as unknown as PublicClient;
}

function canonicalTransaction(expectation: Phase11FinalityExpectation): Record<string, unknown> {
  return {
    hash: expectation.transactionHash,
    from: expectation.from,
    nonce: Number(expectation.nonce),
    to: expectation.to,
    value: BigInt(expectation.value),
    input: testnetTransactionInput(expectation.sequence),
    chainId: expectation.chainId,
    blockNumber: 123431n,
    blockHash: `0x${"11".repeat(32)}` as Hex,
    transactionIndex: 0,
  };
}

function canonicalClient(input: {
  expectation: Phase11FinalityExpectation;
  transaction?: Record<string, unknown>;
  receiptBlockHash?: Hex;
  blockHash?: Hex;
  includeTransaction?: boolean;
  contractAddress?: string | null;
}): PublicClient {
  const blockNumber = 123431n;
  const canonicalBlockHash = input.blockHash ?? `0x${"11".repeat(32)}` as Hex;
  const receiptBlockHash = input.receiptBlockHash ?? `0x${"11".repeat(32)}` as Hex;
  const transaction = input.transaction ?? canonicalTransaction(input.expectation);
  const transactionHash = input.expectation.transactionHash;
  const receipt = {
    transactionHash,
    status: "success",
    blockNumber,
    blockHash: receiptBlockHash,
    transactionIndex: 0,
    contractAddress: input.contractAddress === undefined
      ? input.expectation.expectedContractAddress
      : input.contractAddress,
    from: input.expectation.from,
    to: input.expectation.to,
  };
  const block = {
    number: blockNumber,
    hash: canonicalBlockHash,
    transactions: input.includeTransaction === false ? [] : [transactionHash],
  };
  return {
    getBlock: async (args: { blockTag?: string; blockNumber?: bigint; blockHash?: Hex }) => {
      if (args.blockTag) return { number: 999999n, hash: SAFE_HEAD };
      return block;
    },
    getTransactionReceipt: async () => receipt,
    getTransaction: async () => transaction,
  } as unknown as PublicClient;
}

async function withLegacyJournal(
  callback: (input: {
    path: string;
    artifactPath: string;
    raw: string;
    initialBytes: string;
    manifest: ReturnType<typeof createTestnetManifestFixture>;
  }) => Promise<void>,
): Promise<void> {
  const directory = await mkdtemp(join(tmpdir(), "egress-phase11-reconcile-"));
  const path = join(directory, "xlayer-testnet.json.journal.json");
  const artifactPath = join(directory, "xlayer-testnet.json.journal.reconciliation.json");
  const manifest = createTestnetManifestFixture();
  const legacy = {
    schemaVersion: 2,
    deploymentId: manifest.deploymentId,
    chainId: manifest.chainId,
    environmentId: manifest.environmentId,
    deployer: manifest.guardian,
    startingNonce: manifest.startingNonce,
    configurationHash: manifest.configurationHash,
    expectedTransactionCount: 26,
    expectedDeploymentSequence: PHASE11_DEPLOYMENT_SEQUENCE,
    createdAt: "2026-08-17T23:55:59.139Z",
    updatedAt: "2026-08-17T23:58:19.989Z",
    status: "COMPLETE",
    finalManifestHash: null,
    steps: manifest.deploymentTransactions.map((record) => ({
      sequence: record.sequence,
      actionId: record.actionId,
      label: PHASE11_DEPLOYMENT_SEQUENCE[record.sequence - 1]!.label,
      kind: PHASE11_DEPLOYMENT_SEQUENCE[record.sequence - 1]!.kind,
      status: "CONFIRMED",
      from: record.from,
      nonce: record.nonce,
      to: record.to,
      value: record.value,
      calldataHash: record.calldataHash,
      transactionHash: record.transactionHash,
      receiptStatus: "SUCCESS",
      blockNumber: record.initialInclusion.blockNumber,
      blockHash: record.initialInclusion.blockHash,
      contractAddress: record.contractAddress,
    })),
  };
  const raw = `${JSON.stringify(legacy, null, 2)}\n`;
  await writeFile(path, raw, { encoding: "utf8", mode: 0o600 });
  try {
    await callback({ path, artifactPath, raw, initialBytes: raw, manifest });
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}
