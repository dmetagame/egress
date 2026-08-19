import { describe, expect, it } from "vitest";
import {
  createExecutionFingerprint,
  createExecutionStagingIntent,
  createExecutionTransactionBinding,
  EgressExecutionStagingWorker,
  InMemoryExecutionStagingStore,
  ViemExecutionSubmitter,
} from "../src/index.js";
import { createStagingFixture, STAGING_TRANSACTION_HASH } from "./staging-fixture.js";

describe("typed Viem staging submitter", () => {
  it("submits only the exact simulated autonomous request bound by the intent hash", async () => {
    const fixture = await createStagingFixture();
    const prepared = await fixture.keeper.prepareExecution({
      event: fixture.request.riskEvent,
      policy: fixture.request.policy,
      attestation: fixture.request.riskAttestation,
    });
    const staged = await new EgressExecutionStagingWorker({
      config: fixture.config,
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
    if (!staged.intent || !staged.simulation || !prepared.simulationRequest) {
      throw new Error("Expected typed staging request.");
    }
    const transactionBinding = createExecutionTransactionBinding({
      intent: staged.intent,
      simulationRequest: prepared.simulationRequest,
    });
    const executionFingerprint = createExecutionFingerprint({
      intent: staged.intent,
      simulation: staged.simulation,
      transactionBinding,
    });
    let writes = 0;
    const submitter = new ViemExecutionSubmitter({
      walletClient: {
        account: { address: fixture.request.policy.keeper },
        getChainId: async () => 196,
        writeContract: async () => {
          writes += 1;
          return STAGING_TRANSACTION_HASH;
        },
      } as never,
      publicClient: {
        getChainId: async () => 196,
        waitForTransactionReceipt: async () => ({
          status: "success",
          blockNumber: 67_881_250n,
          gasUsed: 900_000n,
        }),
      } as never,
    });

    await expect(submitter.submit({
      intent: staged.intent,
      simulation: staged.simulation,
      simulationRequest: prepared.simulationRequest,
      transactionBinding,
      executionFingerprint,
    })).resolves.toMatchObject({ status: "CONFIRMED" });
    expect(writes).toBe(1);

    await expect(submitter.submit({
      intent: staged.intent,
      simulation: staged.simulation,
      simulationRequest: {
        ...prepared.simulationRequest,
        address: "0x4444444444444444444444444444444444444444",
      },
      transactionBinding,
      executionFingerprint,
    })).rejects.toThrow(/does not match/i);
    expect(writes).toBe(1);

    await expect(submitter.submit({
      intent: staged.intent,
      simulation: staged.simulation,
      simulationRequest: {
        ...prepared.simulationRequest,
        functionName: "registerProtectionPolicy",
      } as never,
      transactionBinding,
      executionFingerprint,
    })).rejects.toThrow(/does not match|executeAutonomous/i);
    expect(writes).toBe(1);

    await expect(submitter.submit({
      intent: staged.intent,
      simulation: staged.simulation,
      simulationRequest: {
        ...prepared.simulationRequest,
        args: [{
          ...prepared.simulationRequest.args[0],
          execution: {
            ...prepared.simulationRequest.args[0].execution,
            repayAmount: prepared.simulationRequest.args[0].execution.repayAmount + 1n,
          },
        }],
      },
      transactionBinding,
      executionFingerprint,
    })).rejects.toThrow(/does not match/i);
    expect(writes).toBe(1);

    const widenedIntent = createExecutionStagingIntent({
      requestHash: staged.intent.requestHash as `0x${string}`,
      actionType: staged.intent.actionType,
      environment: staged.intent.environment,
      snapshotHash: staged.intent.snapshotHash as `0x${string}`,
      snapshotIntegrityHash: staged.intent.snapshotIntegrityHash as `0x${string}`,
      chainId: staged.intent.chainId,
      observedBlock: staged.intent.observedBlock,
      riskEventId: staged.intent.riskEventId,
      riskEventIdHash: staged.intent.riskEventIdHash as `0x${string}`,
      verdictId: staged.intent.verdictId,
      verdictHash: staged.intent.verdictHash as `0x${string}`,
      evidenceHash: staged.intent.evidenceHash as `0x${string}`,
      riskLevel: staged.intent.riskLevel,
      policyId: staged.intent.policyId as `0x${string}`,
      policy: {
        ...fixture.request.policy,
        maxSlippageBps: (BigInt(fixture.request.policy.maxSlippageBps) + 1n).toString(),
      },
      policyAuthorizationSignatureHash: staged.intent.policyAuthorizationSignatureHash as `0x${string}`,
      riskAttestationSignatureHash: staged.intent.riskAttestationSignatureHash as `0x${string}`,
      user: staged.intent.user,
      keeper: staged.intent.keeper,
      riskAttestor: staged.intent.riskAttestor,
      egressContract: staged.intent.egressContract,
      protocol: staged.intent.protocol,
      marketStateHash: staged.intent.marketStateHash as `0x${string}`,
      contractRequestHash: staged.intent.contractRequestHash as `0x${string}`,
      execution: staged.intent.execution,
      requestedAt: staged.intent.requestedAt,
      createdAt: staged.intent.createdAt,
    });
    await expect(submitter.submit({
      intent: widenedIntent,
      simulation: staged.simulation,
      simulationRequest: prepared.simulationRequest,
      transactionBinding,
      executionFingerprint,
    })).rejects.toThrow(/simulation.*linkage|transaction.*intent|fingerprint/i);
    expect(writes).toBe(1);

    await expect(submitter.submit({
      intent: staged.intent,
      simulation: staged.simulation,
      simulationRequest: prepared.simulationRequest,
      transactionBinding,
      executionFingerprint: `0x${"99".repeat(32)}`,
    })).rejects.toThrow(/fingerprint/i);
    expect(writes).toBe(1);

    const wrongKeeperSubmitter = new ViemExecutionSubmitter({
      walletClient: {
        account: { address: "0x4444444444444444444444444444444444444444" },
        getChainId: async () => 196,
        writeContract: async () => {
          writes += 1;
          return STAGING_TRANSACTION_HASH;
        },
      } as never,
      publicClient: {
        getChainId: async () => 196,
        waitForTransactionReceipt: async () => ({
          status: "success",
          blockNumber: 67_881_250n,
          gasUsed: 900_000n,
        }),
      } as never,
    });
    await expect(wrongKeeperSubmitter.submit({
      intent: staged.intent,
      simulation: staged.simulation,
      simulationRequest: prepared.simulationRequest,
      transactionBinding,
      executionFingerprint,
    })).rejects.toThrow(/authorized.*keeper|keeper authorized/i);
    expect(writes).toBe(1);

    const wrongChainSubmitter = new ViemExecutionSubmitter({
      walletClient: {
        account: { address: fixture.request.policy.keeper },
        getChainId: async () => 195,
        writeContract: async () => {
          writes += 1;
          return STAGING_TRANSACTION_HASH;
        },
      } as never,
      publicClient: {
        getChainId: async () => 196,
        waitForTransactionReceipt: async () => ({
          status: "success",
          blockNumber: 67_881_250n,
          gasUsed: 900_000n,
        }),
      } as never,
    });
    await expect(wrongChainSubmitter.submit({
      intent: staged.intent,
      simulation: staged.simulation,
      simulationRequest: prepared.simulationRequest,
      transactionBinding,
      executionFingerprint,
    })).rejects.toThrow(/chain.*immutable intent/i);
    expect(writes).toBe(1);
  });
});
