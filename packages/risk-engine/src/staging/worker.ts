import { randomUUID } from "node:crypto";
import type { Hex } from "viem";
import { objectHash } from "../domain/hash.js";
import {
  autonomousContractRequestHash,
  preparedAutonomousWriteMatches,
  type PreparedAutonomousWriteRequest,
} from "../autonomy/contract.js";
import {
  protectionPolicyId,
  verifyProtectionPolicySignature,
} from "../authorization/protection-policy.js";
import { verifyArchivedLiveSnapshot } from "../live/archive.js";
import type { ArchivedLiveSnapshot } from "../live/archive-schemas.js";
import type { ExecutionProtocolIdentity } from "./schemas.js";
import {
  createExecutionSimulation,
  createExecutionFingerprint,
  createExecutionStagingIntent,
  createExecutionSubmission,
  createExecutionSubmissionReservation,
  createExecutionTransactionBinding,
  createExecutionWorkerEvent,
  executionStagingRequestSchema,
  type ExecutionSimulation,
  type ExecutionStagingIntent,
  type ExecutionStagingRequest,
  type ExecutionSubmission,
  type ExecutionTransactionBinding,
  type ExecutionWriteEnvironment,
  type ExecutionWorkerEvent,
} from "./schemas.js";
import {
  assertExecutionEnvironment,
  type ExecutionEnvironmentIdentity,
  type ExecutionStagingConfig,
  ExecutionStagingError,
} from "./config.js";
import { executionProtocolConfigHash, snapshotMatchesProtocol } from "./protocol.js";
import { testnetPolicyBoundViolations } from "./testnet-deployment.js";
import type { EgressShadowKeeper, PreparedShadowDecision } from "../keeper/shadow-keeper.js";
import type { ExecutionStagingStore, StagingSnapshotReader } from "./store.js";
import { operationalErrorMessage } from "../live/redaction.js";

export interface ExecutionSubmitterResult {
  status: "CONFIRMED" | "REVERTED";
  transactionHash: Hex | null;
  blockNumber: bigint | null;
  gasUsed: bigint | null;
  error?: string | null;
}

export interface ExecutionSubmitter {
  submit(input: {
    intent: ExecutionStagingIntent;
    simulation: ExecutionSimulation;
    simulationRequest: PreparedAutonomousWriteRequest;
    transactionBinding: ExecutionTransactionBinding;
    executionFingerprint: Hex;
  }): Promise<ExecutionSubmitterResult>;
}

export interface ExecutionStagingResult {
  status: "REJECTED" | "SIMULATED" | "CONFIRMED" | "REVERTED" | "UNAVAILABLE";
  code: string | null;
  reason: string;
  intent: ExecutionStagingIntent | null;
  simulation: ExecutionSimulation | null;
  submission: ExecutionSubmission | null;
  environment: ExecutionEnvironmentIdentity | null;
}

export class EgressExecutionStagingWorker {
  private readonly now: () => Date;

  constructor(
    private readonly dependencies: {
      config: ExecutionStagingConfig;
      snapshotReader: StagingSnapshotReader;
      store: ExecutionStagingStore;
      keeper: EgressShadowKeeper;
      identifyEnvironment: () => Promise<ExecutionEnvironmentIdentity>;
      readBlockHash: (blockNumber: bigint) => Promise<Hex | null>;
      submitter?: ExecutionSubmitter;
      now?: () => Date;
    },
  ) {
    this.now = dependencies.now ?? (() => new Date());
  }

  async stage(input: ExecutionStagingRequest): Promise<ExecutionStagingResult> {
    const requested = executionStagingRequestSchema.parse(input);
    const now = this.now();
    try {
      const environment = await this.verifyEnvironment(requested.environment);
      await this.recordEvent(createExecutionWorkerEvent({
        eventType: "WORKER_STARTED",
        environment: environment.environment,
        state: "HEALTHY",
        snapshotHash: requested.snapshotHash as Hex,
        message: "Execution staging request accepted for deterministic validation.",
        payload: { chainId: environment.chainId },
        createdAt: now.toISOString(),
      }));

      this.validateRequestFreshness(requested, now);

      const snapshot = await this.dependencies.snapshotReader.get(requested.snapshotHash);
      this.validateSnapshot(snapshot, requested, now);
      await this.validateSnapshotBlock(snapshot!, environment);
      this.validateRequestBinding(snapshot!, requested);

      const policySignatureValid = await verifyProtectionPolicySignature({
        chainId: requested.riskEvent.policy.chainId,
        egressContract: requested.riskEvent.policy.egressContract as `0x${string}`,
        policy: requested.policy,
        signature: requested.policyAuthorizationSignature as Hex,
      });
      if (!policySignatureValid) {
        throw new ExecutionStagingError(
          "AUTHORIZATION_INVALID",
          "The supplied user policy signature does not validate against the exact bounded policy.",
        );
      }

      const prepared = await this.dependencies.keeper.prepareExecution({
        event: requested.riskEvent,
        policy: requested.policy,
        attestation: requested.riskAttestation,
      });
      if (!prepared.decision.execution) {
        const failed = prepared.decision.checks.find((check) => !check.passed);
        const code = failed?.check === "risk_threshold" || failed?.check === "risk_attestation" || failed?.check === "evidence"
          ? "INVALID_RISK_STATE"
          : failed?.check === "bounded_amounts" || failed?.check === "post_health_factor" || failed?.check === "output_floor"
            ? "EXECUTION_BOUNDS_EXCEEDED"
            : failed?.check === "policy_identity" || failed?.check === "policy_registered" || failed?.check === "policy_revocation" || failed?.check === "policy_expiry"
              ? "AUTHORIZATION_INVALID"
              : "INVALID_MARKET_STATE";
        throw new ExecutionStagingError(code, prepared.decision.reasons.join("; ") || "Deterministic staging checks rejected the action.");
      }
      assertExecutionBounds(prepared, requested);
      this.validateRefreshedMarket(snapshot!, prepared);
      if (!prepared.request) {
        throw new ExecutionStagingError(
          "SIMULATION_FAILED",
          "A deterministic execution decision did not return the typed autonomous request.",
        );
      }

      const marketStateHash = objectHash(prepared.decision.market);
      const contractRequestHash = autonomousContractRequestHash(prepared.request);
      const policyId = protectionPolicyId({
        chainId: requested.riskEvent.policy.chainId,
        egressContract: requested.riskEvent.policy.egressContract as `0x${string}`,
        policy: requested.policy,
      });
      const requestHash = objectHash({
        actionType: requested.actionType,
        environment: requested.environment,
        snapshotHash: requested.snapshotHash as Hex,
        riskEventId: requested.riskEvent.riskEventId,
        policyId,
        policyAuthorizationSignature: objectHash(requested.policyAuthorizationSignature),
        riskAttestation: objectHash(requested.riskAttestation),
        marketStateHash,
        contractRequestHash,
        requestedAt: requested.requestedAt,
      });
      const intent = createExecutionStagingIntent({
        requestHash,
        actionType: requested.actionType,
        environment: requested.environment,
        snapshotHash: requested.snapshotHash as Hex,
        snapshotIntegrityHash: snapshot!.integrityHash as Hex,
        chainId: environment.chainId,
        observedBlock: prepared.decision.market.position.blockNumber,
        riskEventId: requested.riskEvent.riskEventId,
        riskEventIdHash: prepared.decision.riskEventIdHash as Hex,
        verdictId: requested.riskEvent.verdict.verdictId,
        verdictHash: requested.riskAttestation.verdictHash as Hex,
        evidenceHash: requested.riskAttestation.evidenceHash as Hex,
        riskLevel: materialRiskLevel(requested.riskEvent.verdict.riskLevel),
        policyId,
        policy: requested.policy,
        policyAuthorizationSignatureHash: objectHash(requested.policyAuthorizationSignature),
        riskAttestationSignatureHash: objectHash(requested.riskAttestation.signature),
        user: requested.policy.user,
        keeper: requested.policy.keeper,
        riskAttestor: requested.policy.riskAttestor,
        egressContract: requested.riskEvent.policy.egressContract,
        protocol: this.dependencies.config.protocol!,
        marketStateHash,
        contractRequestHash,
        execution: prepared.decision.execution,
        requestedAt: requested.requestedAt,
        createdAt: prepared.decision.evaluatedAt,
      });
      const savedIntent = await this.dependencies.store.saveIntent(intent);
      const simulation = createExecutionSimulation({
        intent: savedIntent.intent,
        decision: prepared.decision,
        createdAt: now.toISOString(),
      });
      const savedSimulation = await this.dependencies.store.saveSimulation(simulation);
      if (!savedSimulation.simulation.status || savedSimulation.simulation.status !== "PASSED") {
        await this.recordEvent(createExecutionWorkerEvent({
          eventType: "SIMULATION_FAILED",
          environment: environment.environment,
          state: "DEGRADED",
          intentHash: savedIntent.intent.intentHash as Hex,
          snapshotHash: requested.snapshotHash as Hex,
          code: "SIMULATION_FAILED",
          message: savedSimulation.simulation.error ?? "Contract simulation failed.",
          createdAt: now.toISOString(),
        }));
        return {
          status: "REJECTED",
          code: "SIMULATION_FAILED",
          reason: savedSimulation.simulation.error ?? "Contract simulation failed.",
          intent: savedIntent.intent,
          simulation: savedSimulation.simulation,
          submission: null,
          environment,
        };
      }

      if (!prepared.simulationRequest) {
        throw new ExecutionStagingError(
          "SIMULATION_FAILED",
          "A passing simulation did not return the typed write request.",
        );
      }
      if (!preparedAutonomousWriteMatches({
        prepared: prepared.simulationRequest,
        egressContract: savedIntent.intent.egressContract as `0x${string}`,
        contractRequestHash: savedIntent.intent.contractRequestHash as Hex,
      })) {
        throw new ExecutionStagingError(
          "SIMULATION_FAILED",
          "The typed simulated request does not match the immutable execution intent.",
        );
      }
      const transactionBinding = createExecutionTransactionBinding({
        intent: savedIntent.intent,
        simulationRequest: prepared.simulationRequest,
      });
      const executionFingerprint = createExecutionFingerprint({
        intent: savedIntent.intent,
        simulation: savedSimulation.simulation,
        transactionBinding,
      });

      await this.recordEvent(createExecutionWorkerEvent({
        eventType: "SIMULATION_PASSED",
        environment: environment.environment,
        state: "HEALTHY",
        intentHash: savedIntent.intent.intentHash as Hex,
        snapshotHash: requested.snapshotHash as Hex,
        message: "Exact bounded execution request passed contract simulation.",
        payload: {
          gasEstimate: savedSimulation.simulation.gasEstimate,
          executionFingerprint,
          calldataHash: transactionBinding.calldataHash,
        },
        createdAt: now.toISOString(),
      }));

      if (!this.dependencies.config.submissionEnabled || !this.dependencies.submitter) {
        return {
          status: "SIMULATED",
          code: null,
          reason: "Simulation passed; submission is disabled for this staging worker.",
          intent: savedIntent.intent,
          simulation: savedSimulation.simulation,
          submission: null,
          environment,
        };
      }

      await this.verifyEnvironment(requested.environment);
      this.validateIntentFreshness(savedIntent.intent, this.now());

      const reservation = createExecutionSubmissionReservation({
        reservationId: randomUUID(),
        intent: savedIntent.intent,
        simulation: savedSimulation.simulation,
        transactionBinding,
        executionFingerprint,
        createdAt: now.toISOString(),
      });
      const reserved = await this.dependencies.store.reserveSubmission(reservation);
      if (!reserved.inserted) {
        throw new ExecutionStagingError(
          "DUPLICATE_EXECUTION",
          "This immutable execution intent already has a submission reservation.",
        );
      }
      await this.verifyEnvironment(requested.environment);
      this.validateIntentFreshness(savedIntent.intent, this.now());
      let submitted: ExecutionSubmitterResult;
      try {
        submitted = await this.dependencies.submitter.submit({
          intent: savedIntent.intent,
          simulation: savedSimulation.simulation,
          simulationRequest: prepared.simulationRequest,
          transactionBinding,
          executionFingerprint,
        });
      } catch (error) {
        submitted = {
          status: "REVERTED",
          transactionHash: null,
          blockNumber: null,
          gasUsed: null,
          error: errorMessage(error),
        };
      }
      const submission = createExecutionSubmission({
        intent: savedIntent.intent,
        simulation: savedSimulation.simulation,
        transactionBinding,
        executionFingerprint,
        status: submitted.status,
        transactionHash: submitted.transactionHash,
        blockNumber: submitted.blockNumber?.toString() ?? null,
        gasUsed: submitted.gasUsed?.toString() ?? null,
        error: submitted.error,
        createdAt: now.toISOString(),
      });
      const savedSubmission = await this.dependencies.store.saveSubmission(submission);
      await this.recordEvent(createExecutionWorkerEvent({
        eventType: submitted.status === "CONFIRMED" ? "SUBMISSION_CONFIRMED" : "SUBMISSION_REVERTED",
        environment: environment.environment,
        state: submitted.status === "CONFIRMED" ? "HEALTHY" : "DEGRADED",
        intentHash: savedIntent.intent.intentHash as Hex,
        snapshotHash: requested.snapshotHash as Hex,
        code: submitted.status === "CONFIRMED" ? null : "SUBMISSION_FAILED",
        message: submitted.status === "CONFIRMED" ? "Execution submission confirmed." : submitted.error ?? "Execution submission failed.",
        payload: {
          transactionHash: submitted.transactionHash,
          executionFingerprint,
          simulationHash: savedSimulation.simulation.simulationHash,
        },
        createdAt: now.toISOString(),
      }));
      return {
        status: submitted.status,
        code: submitted.status === "CONFIRMED" ? null : "SUBMISSION_FAILED",
        reason: submitted.status === "CONFIRMED" ? "Execution submission confirmed." : submitted.error ?? "Execution submission failed.",
        intent: savedIntent.intent,
        simulation: savedSimulation.simulation,
        submission: savedSubmission.submission,
        environment,
      };
    } catch (error) {
      const stagingError = error instanceof ExecutionStagingError
        ? error
        : new ExecutionStagingError("INVALID_MARKET_STATE", errorMessage(error));
      await this.recordEvent(createExecutionWorkerEvent({
        eventType: "REQUEST_REJECTED",
        environment: this.dependencies.config.environment,
        state: stagingError.code === "EXECUTION_ENVIRONMENT_MISMATCH" ? "UNAVAILABLE" : "DEGRADED",
        snapshotHash: requested.snapshotHash as Hex,
        code: stagingError.code,
        message: stagingError.message,
        createdAt: now.toISOString(),
      }));
      return {
        status: stagingError.code === "EXECUTION_ENVIRONMENT_MISMATCH" ? "UNAVAILABLE" : "REJECTED",
        code: stagingError.code,
        reason: stagingError.message,
        intent: null,
        simulation: null,
        submission: null,
        environment: null,
      };
    }
  }

  private async verifyEnvironment(environment: ExecutionWriteEnvironment): Promise<ExecutionEnvironmentIdentity> {
    const identity = await this.dependencies.identifyEnvironment();
    if (identity.environment !== environment || identity.environment !== this.dependencies.config.environment) {
      throw new ExecutionStagingError(
        "EXECUTION_ENVIRONMENT_MISMATCH",
        "Requested execution environment does not match the positively identified worker environment.",
      );
    }
    return assertExecutionEnvironment({
      config: this.dependencies.config,
      observedChainId: identity.chainId,
      observedAnchorBlockHash: identity.anchorBlockHash,
      forkDetected: identity.forkDetected,
      testnetConfigured: identity.testnetConfigured,
    });
  }

  private validateSnapshot(
    snapshot: ArchivedLiveSnapshot | null,
    request: ExecutionStagingRequest,
    now: Date,
  ): asserts snapshot is ArchivedLiveSnapshot {
    if (!snapshot) throw new ExecutionStagingError("SNAPSHOT_NOT_FOUND", "The requested archived snapshot does not exist.");
    if (snapshot.snapshotHash.toLowerCase() !== request.snapshotHash.toLowerCase() || !verifyArchivedLiveSnapshot(snapshot)) {
      throw new ExecutionStagingError("SNAPSHOT_INTEGRITY_FAILURE", "Archived snapshot hash or integrity verification failed.");
    }
    if (snapshot.archiveStatus !== "COMPLETE" || snapshot.consistencyStatus !== "CONSISTENT") {
      throw new ExecutionStagingError("STALE_SNAPSHOT", "Only a complete, same-block archived snapshot may enter execution staging.");
    }
    if (
      snapshot.chainId === null ||
      snapshot.observedBlock === null ||
      snapshot.blockHash === null ||
      snapshot.position === null ||
      snapshot.position.blockNumber !== snapshot.observedBlock
    ) {
      throw new ExecutionStagingError(
        "EXECUTION_ENVIRONMENT_MISMATCH",
        "Execution staging requires a chain-bound snapshot with matching position block provenance.",
      );
    }
    const ageSeconds = (now.getTime() - new Date(snapshot.timestamp).getTime()) / 1_000;
    if (ageSeconds < -5 || ageSeconds > this.dependencies.config.maxSnapshotAgeSeconds) {
      throw new ExecutionStagingError("STALE_SNAPSHOT", `Observed snapshot state is ${ageSeconds.toFixed(0)} seconds old.`);
    }
    if (snapshot.broadcastPermitted || snapshot.transactionSubmitted) {
      throw new ExecutionStagingError("INVALID_MARKET_STATE", "A live observation snapshot cannot carry a write capability.");
    }
  }

  private async validateSnapshotBlock(
    snapshot: ArchivedLiveSnapshot,
    environment: ExecutionEnvironmentIdentity,
  ): Promise<void> {
    if (
      snapshot.chainId !== environment.chainId ||
      snapshot.observedBlock === null ||
      snapshot.blockHash === null ||
      this.dependencies.config.anchorBlockNumber === null ||
      BigInt(snapshot.observedBlock) < this.dependencies.config.anchorBlockNumber
    ) {
      throw new ExecutionStagingError(
        "EXECUTION_ENVIRONMENT_MISMATCH",
        "Archived snapshot chain or block is incompatible with the configured fork environment.",
      );
    }
    let observedHash: Hex | null;
    try {
      observedHash = await this.dependencies.readBlockHash(BigInt(snapshot.observedBlock));
    } catch (error) {
      throw new ExecutionStagingError(
        "EXECUTION_ENVIRONMENT_MISMATCH",
        `Unable to verify the archived snapshot block against the execution RPC: ${errorMessage(error)}`,
      );
    }
    if (!observedHash || observedHash.toLowerCase() !== snapshot.blockHash.toLowerCase()) {
      throw new ExecutionStagingError(
        "EXECUTION_ENVIRONMENT_MISMATCH",
        "Archived snapshot block hash does not exist in the positively identified execution environment.",
      );
    }
  }

  private validateRefreshedMarket(snapshot: ArchivedLiveSnapshot, prepared: PreparedShadowDecision): void {
    const snapshotBlock = BigInt(snapshot.observedBlock!);
    const positionBlock = BigInt(prepared.decision.market.position.blockNumber);
    const liquidityBlock = BigInt(prepared.decision.market.liquidity.blockNumber);
    if (positionBlock < snapshotBlock || liquidityBlock !== positionBlock) {
      throw new ExecutionStagingError(
        "INVALID_MARKET_STATE",
        "Deterministic market refresh must be same-block and no older than the archived snapshot.",
      );
    }
  }

  private validateRequestBinding(snapshot: ArchivedLiveSnapshot, request: ExecutionStagingRequest): void {
    const protocol = this.dependencies.config.protocol;
    if (
      !protocol ||
      this.dependencies.config.chainId === null ||
      this.dependencies.config.egressContract === null ||
      this.dependencies.config.keeperAddress === null
    ) {
      throw new ExecutionStagingError("EXECUTION_ENVIRONMENT_MISMATCH", "Execution protocol configuration is incomplete.");
    }
    if (snapshot.chainId !== this.dependencies.config.chainId || request.riskEvent.policy.chainId !== this.dependencies.config.chainId) {
      throw new ExecutionStagingError("EXECUTION_ENVIRONMENT_MISMATCH", "Snapshot, policy, and execution chain IDs do not match.");
    }
    if (request.riskEvent.policy.egressContract.toLowerCase() !== this.dependencies.config.egressContract.toLowerCase()) {
      throw new ExecutionStagingError("EXECUTION_ENVIRONMENT_MISMATCH", "Configured Egress contract does not match the signed policy.");
    }
    if (request.policy.keeper.toLowerCase() !== this.dependencies.config.keeperAddress.toLowerCase()) {
      throw new ExecutionStagingError(
        "AUTHORIZATION_INVALID",
        "Configured execution keeper does not match the keeper authorized by the signed policy.",
      );
    }
    const protocolReasons = snapshotMatchesProtocol(snapshot, protocol);
    if (protocolReasons.length > 0) {
      throw new ExecutionStagingError("INVALID_MARKET_STATE", protocolReasons.join(" "));
    }
    const expectedProtocolHash = executionProtocolConfigHash(protocol);
    if (request.policy.protocolConfigHash.toLowerCase() !== expectedProtocolHash.toLowerCase()) {
      throw new ExecutionStagingError("EXECUTION_ENVIRONMENT_MISMATCH", "Signed policy protocol configuration hash does not match the worker address book.");
    }
    if (this.dependencies.config.environment === "TESTNET_WRITE") {
      const bounds = this.dependencies.config.testnetDeployment?.executionBounds;
      if (!bounds) {
        throw new ExecutionStagingError(
          "EXECUTION_ENVIRONMENT_MISMATCH",
          "TESTNET_WRITE requires manifest-pinned execution bounds.",
        );
      }
      const violations = testnetPolicyBoundViolations(request.policy, bounds);
      if (violations.length > 0) {
        throw new ExecutionStagingError(
          "EXECUTION_BOUNDS_EXCEEDED",
          `Signed policy exceeds the independently pinned testnet deployment bounds: ${violations.join(", ")}.`,
        );
      }
    }
    if (
      request.riskEvent.mode === "REPLAY" ||
      request.riskEvent.policy.user.toLowerCase() !== request.policy.user.toLowerCase() ||
      request.riskEvent.policy.executor.toLowerCase() !== request.policy.keeper.toLowerCase() ||
      request.riskEvent.policy.approvedRiskAttestor.toLowerCase() !== request.policy.riskAttestor.toLowerCase()
    ) {
      throw new ExecutionStagingError("AUTHORIZATION_INVALID", "Risk event and signed onchain policy are not position- and executor-bound.");
    }
    this.validateOffchainPolicyBounds(request);
    if (
      snapshot.account?.toLowerCase() !== request.policy.user.toLowerCase() ||
      snapshot.riskClassification !== request.riskEvent.verdict.riskLevel ||
      snapshot.rwaEvidence?.status !== "AVAILABLE" ||
      snapshot.rwaEvidence.verdictId !== request.riskEvent.verdict.verdictId ||
      snapshot.rwaEvidence.summary !== request.riskEvent.verdict.summary ||
      snapshot.rwaEvidence.confidence !== request.riskEvent.verdict.confidence ||
      objectHash(snapshot.rwaEvidence.claims) !== objectHash(request.riskEvent.verdict.claims) ||
      !snapshot.rwaEvidence.evidenceValid ||
      !request.riskEvent.verdict.evidenceValidation.valid ||
      snapshot.policyEvaluation?.riskEventId !== request.riskEvent.riskEventId ||
      snapshot.policyEvaluation?.riskVerdictId !== request.riskEvent.verdict.verdictId
    ) {
      throw new ExecutionStagingError("INVALID_RISK_STATE", "Archived RWA evidence does not bind to the supplied risk verdict.");
    }
    const availableRevisionIds = new Set(
      snapshot.rwaEvidence.sourceStates.flatMap((source) => [
        source.revisionId,
        source.snapshot.previousRevisionId,
        source.diff.fromRevisionId,
        source.diff.toRevisionId,
      ]).filter((value): value is string => Boolean(value)),
    );
    if (request.riskEvent.verdict.sourceRevisionIds.some((revisionId) => !availableRevisionIds.has(revisionId))) {
      throw new ExecutionStagingError("INVALID_RISK_STATE", "Risk verdict references an OKX source revision absent from the archived snapshot.");
    }
    const availableDiffIds = new Set(
      snapshot.rwaEvidence.sourceStates.flatMap((source) => [source.diff.diffId]),
    );
    if (request.riskEvent.verdict.diffIds.some((diffId) => !availableDiffIds.has(diffId))) {
      throw new ExecutionStagingError("INVALID_RISK_STATE", "Risk verdict references an OKX source diff absent from the archived snapshot.");
    }
    if (
      objectHash([...request.riskEvent.sourceRevisionIds].sort()) !==
        objectHash([...request.riskEvent.verdict.sourceRevisionIds].sort()) ||
      objectHash([...request.riskEvent.diffIds].sort()) !==
        objectHash([...request.riskEvent.verdict.diffIds].sort())
    ) {
      throw new ExecutionStagingError("INVALID_RISK_STATE", "Risk event provenance does not match its signed verdict provenance.");
    }
    if (request.riskAttestation.policyId.toLowerCase() !== protectionPolicyId({
      chainId: request.riskEvent.policy.chainId,
      egressContract: request.riskEvent.policy.egressContract as `0x${string}`,
      policy: request.policy,
    }).toLowerCase()) {
      throw new ExecutionStagingError("AUTHORIZATION_INVALID", "Risk attestation policy ID does not match the signed policy.");
    }
  }

  private validateRequestFreshness(request: ExecutionStagingRequest, now: Date): void {
    const ageSeconds = (now.getTime() - new Date(request.requestedAt).getTime()) / 1_000;
    if (ageSeconds < -5 || ageSeconds > this.dependencies.config.maxIntentAgeSeconds) {
      throw new ExecutionStagingError("STALE_REQUEST", `Execution request is ${ageSeconds.toFixed(0)} seconds old.`);
    }
  }

  private validateIntentFreshness(intent: ExecutionStagingIntent, now: Date): void {
    const ageSeconds = (now.getTime() - new Date(intent.createdAt).getTime()) / 1_000;
    if (ageSeconds < -5 || ageSeconds > this.dependencies.config.maxIntentAgeSeconds) {
      throw new ExecutionStagingError("STALE_REQUEST", `Execution intent is ${ageSeconds.toFixed(0)} seconds old.`);
    }
    if (BigInt(Math.floor(now.getTime() / 1_000)) > BigInt(intent.execution.deadline)) {
      throw new ExecutionStagingError("EXPIRED_INTENT", "The typed execution deadline has expired before submission.");
    }
  }

  private validateOffchainPolicyBounds(request: ExecutionStagingRequest): void {
    const offchain = request.riskEvent.policy;
    const signed = request.policy;
    const riskLevel = offchain.riskTrigger === "HIGH" ? 3 : offchain.riskTrigger === "CRITICAL" ? 4 : 0;
    const authorizationExpiresAt = Math.floor(new Date(offchain.authorizationExpiresAt).getTime() / 1_000);
    const violations = [
      riskLevel !== signed.minimumRiskLevel ? "riskTrigger" : null,
      BigInt(offchain.maximumRepaymentWei) > BigInt(signed.maxRepaymentPerExecution) ? "maximumRepaymentWei" : null,
      BigInt(offchain.maximumCollateralWei) > BigInt(signed.maxCollateralPerExecution) ? "maximumCollateralWei" : null,
      BigInt(offchain.maximumCollateralPercentageBps) > BigInt(signed.maxCollateralPercentageBps) ? "maximumCollateralPercentageBps" : null,
      BigInt(offchain.maximumSlippageBps) > BigInt(signed.maxSlippageBps) ? "maximumSlippageBps" : null,
      BigInt(offchain.maximumOraclePoolDeviationBps) > BigInt(signed.maxOracleDeviationBps) ? "maximumOraclePoolDeviationBps" : null,
      BigInt(offchain.maximumFlashLoanPremiumBps) > BigInt(signed.maxFlashLoanPremiumBps) ? "maximumFlashLoanPremiumBps" : null,
      BigInt(offchain.triggerHealthFactorWad) > BigInt(signed.maxPreHealthFactor) ? "triggerHealthFactorWad" : null,
      BigInt(offchain.minimumPostHealthFactorWad) < BigInt(signed.minPostHealthFactor) ? "minimumPostHealthFactorWad" : null,
      BigInt(offchain.targetPostHealthFactorWad) < BigInt(signed.minPostHealthFactor) ? "targetPostHealthFactorWad" : null,
      BigInt(offchain.cooldownSeconds) < BigInt(signed.cooldownSeconds) ? "cooldownSeconds" : null,
      BigInt(authorizationExpiresAt) > BigInt(signed.expiresAt) ? "authorizationExpiresAt" : null,
      BigInt(offchain.verdictMaxAgeSeconds) > BigInt(signed.maxRiskAgeSeconds) ? "verdictMaxAgeSeconds" : null,
      BigInt(offchain.maximumClockSkewSeconds) > BigInt(signed.maxClockSkewSeconds) ? "maximumClockSkewSeconds" : null,
      !offchain.automaticExecutionEnabled ? "automaticExecutionEnabled" : null,
    ].filter((value): value is string => value !== null);
    if (violations.length > 0) {
      throw new ExecutionStagingError(
        "AUTHORIZATION_INVALID",
        `Offchain policy parameters are broader than the exact signed onchain policy: ${violations.join(", ")}.`,
      );
    }
  }

  private async recordEvent(event: ExecutionWorkerEvent): Promise<void> {
    await this.dependencies.store.saveWorkerEvent(event);
  }
}

function assertExecutionBounds(prepared: PreparedShadowDecision, request: ExecutionStagingRequest): void {
  const execution = prepared.decision.execution;
  const policy = request.policy;
  if (!execution) throw new ExecutionStagingError("EXECUTION_BOUNDS_EXCEEDED", "No bounded execution was produced.");
  if (
    BigInt(execution.repayAmount) > BigInt(policy.maxRepaymentPerExecution) ||
    BigInt(execution.collateralAmount) > BigInt(policy.maxCollateralPerExecution) ||
    BigInt(execution.minSwapOut) > BigInt(execution.expectedSwapOut) ||
    BigInt(execution.expectedSwapOut) === 0n ||
    BigInt(execution.collateralAmount) === 0n ||
    BigInt(execution.repayAmount) === 0n
  ) {
    throw new ExecutionStagingError("EXECUTION_BOUNDS_EXCEEDED", "Produced execution parameters exceed the signed policy bounds.");
  }
}

function errorMessage(error: unknown): string {
  return operationalErrorMessage(error);
}

function materialRiskLevel(value: string): "HIGH" | "CRITICAL" {
  if (value === "HIGH" || value === "CRITICAL") return value;
  throw new ExecutionStagingError("INVALID_RISK_STATE", `Risk level ${value} is not eligible for autonomous staging.`);
}
