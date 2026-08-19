import type { PublicClient, WalletClient } from "viem";
import {
  egressAutonomousAbi,
  preparedAutonomousWriteMatches,
  type PreparedAutonomousWriteRequest,
} from "../autonomy/contract.js";
import type { ExecutionSubmitter, ExecutionSubmitterResult } from "./worker.js";
import {
  createExecutionTransactionBinding,
  verifyExecutionFingerprint,
  verifyExecutionSimulation,
  verifyExecutionStagingIntent,
  type ExecutionSimulation,
  type ExecutionStagingIntent,
  type ExecutionTransactionBinding,
} from "./schemas.js";
import { objectHash } from "../domain/hash.js";

/**
 * The submitter accepts only the exact request returned by viem simulation.
 * It has no method for arbitrary calldata and is constructed only by the
 * isolated execution worker.
 */
export class ViemExecutionSubmitter implements ExecutionSubmitter {
  constructor(
    private readonly dependencies: {
      walletClient: WalletClient;
      publicClient: PublicClient;
    },
  ) {}

  async submit(input: {
    intent: ExecutionStagingIntent;
    simulation: ExecutionSimulation;
    simulationRequest: PreparedAutonomousWriteRequest;
    transactionBinding: ExecutionTransactionBinding;
    executionFingerprint: `0x${string}`;
  }): Promise<ExecutionSubmitterResult> {
    const account = this.dependencies.walletClient.account;
    if (!account) throw new Error("The isolated execution wallet has no configured account.");
    if (!verifyExecutionStagingIntent(input.intent)) {
      throw new Error("Execution intent integrity verification failed.");
    }
    if (
      !verifyExecutionSimulation(input.simulation) ||
      input.simulation.status !== "PASSED" ||
      input.simulation.intentHash.toLowerCase() !== input.intent.intentHash.toLowerCase()
    ) {
      throw new Error("Execution simulation integrity or immutable intent linkage failed.");
    }
    const accountAddress = typeof account === "string" ? account : account.address;
    if (accountAddress.toLowerCase() !== input.intent.keeper.toLowerCase()) {
      throw new Error("Execution wallet does not match the keeper authorized by the immutable intent.");
    }
    if (!preparedAutonomousWriteMatches({
      prepared: input.simulationRequest,
      egressContract: input.intent.egressContract as `0x${string}`,
      contractRequestHash: input.intent.contractRequestHash as `0x${string}`,
    })) {
      throw new Error("Typed simulated request does not match the immutable execution intent.");
    }
    const recomputedBinding = createExecutionTransactionBinding({
      intent: input.intent,
      simulationRequest: input.simulationRequest,
    });
    if (objectHash(recomputedBinding).toLowerCase() !== objectHash(input.transactionBinding).toLowerCase()) {
      throw new Error("Submitted transaction differs from the transaction envelope recorded after simulation.");
    }
    if (!verifyExecutionFingerprint({
      fingerprint: input.executionFingerprint,
      intent: input.intent,
      simulation: input.simulation,
      transactionBinding: input.transactionBinding,
    })) {
      throw new Error("Execution fingerprint does not bind the exact intent, simulation, and transaction envelope.");
    }
    const [publicChainId, walletChainId] = await Promise.all([
      this.dependencies.publicClient.getChainId(),
      this.dependencies.walletClient.getChainId(),
    ]);
    if (publicChainId !== input.intent.chainId || walletChainId !== input.intent.chainId) {
      throw new Error("Execution clients are connected to a chain that differs from the immutable intent.");
    }
    const hash = await this.dependencies.walletClient.writeContract(
      {
        address: input.simulationRequest.address,
        abi: egressAutonomousAbi,
        functionName: input.simulationRequest.functionName,
        args: input.simulationRequest.args,
        chain: undefined,
        account,
        ...(input.simulationRequest.gas === null ? {} : { gas: input.simulationRequest.gas }),
      },
    );
    const receipt = await this.dependencies.publicClient.waitForTransactionReceipt({ hash });
    return {
      status: receipt.status === "success" ? "CONFIRMED" : "REVERTED",
      transactionHash: hash,
      blockNumber: receipt.blockNumber,
      gasUsed: receipt.gasUsed,
      error: receipt.status === "success" ? null : "Execution transaction reverted atomically.",
    };
  }
}
