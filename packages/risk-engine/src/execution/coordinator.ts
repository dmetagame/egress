import {
  concatHex,
  encodeAbiParameters,
  keccak256,
  parseAbiParameters,
  parseEventLogs,
  recoverAddress,
  type Account,
  type Address,
  type Hex,
  type PublicClient,
  type TransactionReceipt,
  type WalletClient,
} from "viem";
import type {
  DeleveragedExecution,
  ExecutionResult,
  PolicyRuntimeState,
  RiskEventRecord,
} from "../domain/schemas.js";
import { riskEventRecordSchema } from "../domain/schemas.js";
import { objectHash } from "../domain/hash.js";
import { verifyExecutorAuthorizationSignature } from "../authorization/executor-typed-data.js";
import { egressExecutorStateAbi } from "../market/abis.js";
import { aTokenPermitAuthorizationAbi } from "../market/abis.js";
import { DeterministicPolicyEngine } from "../policy/engine.js";
import type { RiskAuditLogger } from "../audit/logger.js";
import {
  buildEgressExecutionRequest,
  egressExecutorExecutionAbi,
  type CollateralPermitAuthorization,
  type EgressContractExecutionRequest,
} from "./contract.js";

const PERMIT_PARAMETERS = parseAbiParameters(
  "bytes32 typeHash,address owner,address spender,uint256 value,uint256 nonce,uint256 deadline",
);

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function sameAddress(left: string, right: string): boolean {
  return left.toLowerCase() === right.toLowerCase();
}

function executorAddress(account: Account | Address): Address {
  return typeof account === "string" ? account : account.address;
}

export interface PreparedEgressExecution {
  event: RiskEventRecord;
  request: EgressContractExecutionRequest;
}

export interface EgressExecutionOutcome extends PreparedEgressExecution {
  receipt: TransactionReceipt | null;
}

export class EgressExecutionCoordinator {
  private readonly policyEngine: DeterministicPolicyEngine;
  private readonly now: () => Date;

  constructor(
    private readonly dependencies: {
      publicClient: PublicClient;
      walletClient?: WalletClient;
      executorAccount: Account | Address;
      policyEngine?: DeterministicPolicyEngine;
      auditLogger?: RiskAuditLogger;
      now?: () => Date;
    },
  ) {
    this.policyEngine = dependencies.policyEngine ?? new DeterministicPolicyEngine();
    this.now = dependencies.now ?? (() => new Date());
  }

  async prepare(input: {
    event: RiskEventRecord;
    userAuthorizationSignature: Hex;
    collateralPermit: CollateralPermitAuthorization;
  }): Promise<PreparedEgressExecution> {
    const event = riskEventRecordSchema.parse(structuredClone(input.event));
    const intent = event.intent;
    const market = event.marketContext;
    if (!intent?.allowed || !intent.authorization || !market) {
      throw new Error("Risk event does not contain a permitted bounded execution intent");
    }
    if (event.executionResult && event.executionResult.status !== "NOT_SUBMITTED") {
      throw new Error(`Risk event execution is already ${event.executionResult.status}`);
    }
    this.assertCanonicalLinks(event);

    const now = this.now();
    if (now.getTime() > new Date(intent.expiresAt).getTime()) {
      throw new Error("Execution intent has expired");
    }
    if (BigInt(Math.floor(now.getTime() / 1_000)) > BigInt(intent.authorization.deadline)) {
      throw new Error("Executor authorization has expired");
    }

    const chainId = await this.dependencies.publicClient.getChainId();
    if (chainId !== intent.chainId) {
      throw new Error(`Execution client chain ${chainId} does not match intent chain ${intent.chainId}`);
    }
    const executor = executorAddress(this.dependencies.executorAccount);
    if (!sameAddress(executor, intent.authorization.executor)) {
      throw new Error("Configured transaction signer is not the policy-approved executor");
    }

    const userSignatureValid = await verifyExecutorAuthorizationSignature({
      chainId: intent.chainId,
      egressContract: intent.egressContract as Address,
      authorization: intent.authorization,
      signature: input.userAuthorizationSignature,
    });
    if (!userSignatureValid) {
      throw new Error("User signature does not authorize the exact execution intent");
    }

    const runtime = await this.readCurrentRuntime({
      event,
      userAuthorizationSignature: input.userAuthorizationSignature,
      collateralPermit: input.collateralPermit,
    });
    const refreshedIntent = await this.policyEngine.evaluate({
      verdict: event.verdict,
      attestation: event.attestation,
      market,
      policy: event.policy,
      runtime,
    });
    if (
      !refreshedIntent.allowed ||
      refreshedIntent.status !== "READY_FOR_SUBMISSION" ||
      !refreshedIntent.authorization
    ) {
      const failedChecks = refreshedIntent.checks
        .filter((check) => !check.passed)
        .map((check) => check.check)
        .join(", ");
      throw new Error(`Final deterministic policy evaluation rejected execution: ${failedChecks}`);
    }
    if (objectHash(refreshedIntent.authorization) !== objectHash(intent.authorization)) {
      throw new Error("Bounded authorization changed during final policy evaluation");
    }

    const request = buildEgressExecutionRequest({
      authorization: refreshedIntent.authorization,
      userAuthorizationSignature: input.userAuthorizationSignature,
      collateralPermit: input.collateralPermit,
    });
    return {
      event: riskEventRecordSchema.parse({
        ...event,
        policyRuntime: runtime,
        intent: refreshedIntent,
      }),
      request,
    };
  }

  async execute(input: {
    event: RiskEventRecord;
    userAuthorizationSignature: Hex;
    collateralPermit: CollateralPermitAuthorization;
    broadcast?: boolean;
  }): Promise<EgressExecutionOutcome> {
    const prepared = await this.prepare(input);
    let simulation;
    try {
      simulation = await this.dependencies.publicClient.simulateContract({
        account: this.dependencies.executorAccount,
        address: prepared.event.intent!.egressContract as Address,
        abi: egressExecutorExecutionAbi,
        functionName: "execute",
        args: [prepared.request],
      });
    } catch (error) {
      const event = await this.recordResult(
        prepared.event,
        this.executionResult(
          "FAILED_VALIDATION",
          `Contract simulation failed: ${errorMessage(error)}`,
        ),
      );
      throw new EgressExecutionError(event.executionResult!.message, event);
    }

    if (!input.broadcast) {
      const event = await this.recordResult(
        prepared.event,
        this.executionResult(
          "SIMULATED",
          "Bounded Egress execution simulated successfully; no transaction was broadcast.",
        ),
      );
      return { event, request: prepared.request, receipt: null };
    }
    if (prepared.event.mode === "LIVE") {
      throw new Error("Live-event broadcasting is intentionally disabled in Phase 4");
    }
    if (!this.dependencies.walletClient) {
      throw new Error("A wallet client is required for local-fork broadcasting");
    }

    const transactionHash = await this.dependencies.walletClient.writeContract({
      ...simulation.request,
      // Anvil fork execution can consume more gas than its eth_call estimate because
      // remote fork-state hydration is not reflected consistently in the estimate.
      // This changes only the transaction gas ceiling for TEST/REPLAY broadcasts;
      // calldata and every signed/contract-enforced bound remain identical.
      gas: simulation.request.gas ? simulation.request.gas * 3n : 3_000_000n,
    });
    await this.recordResult(
      prepared.event,
      this.executionResult(
        "SUBMITTED",
        "Bounded Egress execution submitted to the configured local fork.",
        transactionHash,
      ),
    );

    const receipt = await this.dependencies.publicClient.waitForTransactionReceipt({
      hash: transactionHash,
    });
    if (receipt.status !== "success") {
      const event = await this.recordResult(
        prepared.event,
        this.executionResult(
          "REVERTED",
          "The Egress transaction reverted atomically.",
          transactionHash,
          receipt,
        ),
      );
      return { event, request: prepared.request, receipt };
    }

    let deleveraged: DeleveragedExecution;
    try {
      deleveraged = this.parseAndValidateDeleveraged(
        receipt,
        prepared.event.intent!.egressContract as Address,
        prepared.request,
      );
    } catch (error) {
      const event = await this.recordResult(
        prepared.event,
        this.executionResult(
          "FAILED_VALIDATION",
          `Confirmed transaction failed Egress receipt validation: ${errorMessage(error)}`,
          transactionHash,
          receipt,
        ),
      );
      throw new EgressExecutionError(event.executionResult!.message, event);
    }

    const event = await this.recordResult(
      prepared.event,
      this.executionResult(
        "CONFIRMED",
        "Egress deleveraging confirmed and matched the bounded execution intent.",
        transactionHash,
        receipt,
        deleveraged,
      ),
    );
    return { event, request: prepared.request, receipt };
  }

  private assertCanonicalLinks(event: RiskEventRecord): void {
    const intent = event.intent!;
    const authorization = intent.authorization!;
    if (
      event.verdict.riskEventId !== event.riskEventId ||
      intent.riskEventId !== event.riskEventId ||
      intent.riskVerdictId !== event.verdict.verdictId ||
      intent.policyId !== event.policy.policyId ||
      intent.chainId !== event.policy.chainId ||
      !sameAddress(intent.egressContract, event.policy.egressContract) ||
      !sameAddress(authorization.user, event.policy.user) ||
      !sameAddress(authorization.executor, event.policy.executor) ||
      !sameAddress(authorization.user, event.marketContext!.position.user)
    ) {
      throw new Error("Risk event, verdict, policy, market, and execution intent are not canonically linked");
    }
  }

  private async readCurrentRuntime(input: {
    event: RiskEventRecord;
    userAuthorizationSignature: Hex;
    collateralPermit: CollateralPermitAuthorization;
  }): Promise<PolicyRuntimeState> {
    const intent = input.event.intent!;
    const authorization = intent.authorization!;
    const aToken = input.event.marketContext!.position.aToken as Address;
    const egressContract = intent.egressContract as Address;
    const user = authorization.user as Address;
    const [revocationNonce, nonceAlreadyUsed, executorPaused, allowance] = await Promise.all([
      this.dependencies.publicClient.readContract({
        address: egressContract,
        abi: egressExecutorStateAbi,
        functionName: "revocationNonces",
        args: [user],
      }),
      this.dependencies.publicClient.readContract({
        address: egressContract,
        abi: egressExecutorStateAbi,
        functionName: "authorizationUsed",
        args: [user, BigInt(authorization.nonce)],
      }),
      this.dependencies.publicClient.readContract({
        address: egressContract,
        abi: egressExecutorStateAbi,
        functionName: "paused",
      }),
      this.dependencies.publicClient.readContract({
        address: aToken,
        abi: aTokenPermitAuthorizationAbi,
        functionName: "allowance",
        args: [user, egressContract],
      }),
    ]);

    const requiredCollateral = BigInt(authorization.collateralAmount);
    const collateralAuthorizationAvailable =
      allowance >= requiredCollateral ||
      (await this.verifyCollateralPermit({
        aToken,
        user,
        spender: egressContract,
        value: requiredCollateral,
        authorizationDeadline: BigInt(authorization.deadline),
        permit: input.collateralPermit,
      }));

    return {
      evaluatedAt: input.event.policyRuntime.evaluatedAt,
      lastExecutionAt: input.event.policyRuntime.lastExecutionAt,
      authorizationNonce: authorization.nonce,
      revocationNonce: revocationNonce.toString(),
      nonceAlreadyUsed,
      executorPaused,
      userAuthorizationSignature: input.userAuthorizationSignature,
      collateralAuthorizationAvailable,
    };
  }

  private async verifyCollateralPermit(input: {
    aToken: Address;
    user: Address;
    spender: Address;
    value: bigint;
    authorizationDeadline: bigint;
    permit: CollateralPermitAuthorization;
  }): Promise<boolean> {
    if (!input.permit.signature || input.permit.deadline < input.authorizationDeadline) {
      return false;
    }
    const [nonce, domainSeparator, permitTypeHash] = await Promise.all([
      this.dependencies.publicClient.readContract({
        address: input.aToken,
        abi: aTokenPermitAuthorizationAbi,
        functionName: "nonces",
        args: [input.user],
      }),
      this.dependencies.publicClient.readContract({
        address: input.aToken,
        abi: aTokenPermitAuthorizationAbi,
        functionName: "DOMAIN_SEPARATOR",
      }),
      this.dependencies.publicClient.readContract({
        address: input.aToken,
        abi: aTokenPermitAuthorizationAbi,
        functionName: "PERMIT_TYPEHASH",
      }),
    ]);
    const structHash = keccak256(
      encodeAbiParameters(PERMIT_PARAMETERS, [
        permitTypeHash,
        input.user,
        input.spender,
        input.value,
        nonce,
        input.permit.deadline,
      ]),
    );
    const digest = keccak256(concatHex(["0x1901", domainSeparator, structHash]));
    try {
      const recovered = await recoverAddress({
        hash: digest,
        signature: input.permit.signature,
      });
      return sameAddress(recovered, input.user);
    } catch {
      return false;
    }
  }

  private parseAndValidateDeleveraged(
    receipt: TransactionReceipt,
    egressContract: Address,
    request: EgressContractExecutionRequest,
  ): DeleveragedExecution {
    const logs = parseEventLogs({
      abi: egressExecutorExecutionAbi,
      eventName: "Deleveraged",
      logs: receipt.logs.filter((log) => sameAddress(log.address, egressContract)),
      strict: true,
    });
    const log = logs[0];
    if (!log) throw new Error("Missing Deleveraged event");
    const args = log.args;
    if (
      !sameAddress(args.user, request.authorization.user) ||
      !sameAddress(args.executor, request.authorization.executor) ||
      args.nonce !== request.authorization.nonce ||
      args.debtRepaid !== request.authorization.repayAmount ||
      args.collateralSold !== request.authorization.collateralAmount ||
      args.swapOutput < request.authorization.minSwapOut ||
      args.healthFactorAfter <= args.healthFactorBefore
    ) {
      throw new Error("Deleveraged event does not match the signed execution bounds");
    }
    return {
      user: args.user,
      executor: args.executor,
      nonce: args.nonce.toString(),
      authorizationHash: args.authorizationHash,
      debtRepaidWei: args.debtRepaid.toString(),
      collateralSoldWei: args.collateralSold.toString(),
      swapOutputWei: args.swapOutput.toString(),
      flashPremiumWei: args.flashPremium.toString(),
      surplusReturnedWei: args.surplusReturned.toString(),
      healthFactorBeforeWad: args.healthFactorBefore.toString(),
      healthFactorAfterWad: args.healthFactorAfter.toString(),
    };
  }

  private executionResult(
    status: ExecutionResult["status"],
    message: string,
    transactionHash: Hex | null = null,
    receipt: TransactionReceipt | null = null,
    deleveraged: DeleveragedExecution | null = null,
  ): ExecutionResult {
    return {
      status,
      transactionHash,
      blockNumber: receipt?.blockNumber.toString() ?? null,
      gasUsed: receipt?.gasUsed.toString() ?? null,
      observedAt: this.now().toISOString(),
      message,
      deleveraged,
    };
  }

  private async recordResult(
    event: RiskEventRecord,
    result: ExecutionResult,
  ): Promise<RiskEventRecord> {
    const updated = riskEventRecordSchema.parse({ ...event, executionResult: result });
    await this.dependencies.auditLogger?.record(updated);
    return updated;
  }
}

export class EgressExecutionError extends Error {
  constructor(
    message: string,
    readonly event: RiskEventRecord,
  ) {
    super(message);
    this.name = "EgressExecutionError";
  }
}
