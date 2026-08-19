import {
  getAddress,
  type Account,
  type Address,
  type Hex,
  type PublicClient,
  type WalletClient,
} from "viem";
import { objectHash, shortId } from "../domain/hash.js";
import { meetsRiskThreshold } from "../domain/risk.js";
import type { PolicyCheck } from "../domain/types.js";
import type { RiskEventRecord } from "../domain/schemas.js";
import { erc20Abi } from "../market/abis.js";
import type { MarketContextProvider } from "../market/provider.js";
import {
  autonomousExecutionSchema,
  onchainPolicyStateSchema,
  shadowKeeperDecisionSchema,
  type AutonomousExecution,
  type AutonomousRiskAttestation,
  type OnchainPolicyState,
  type OnchainProtectionPolicy,
  type ShadowKeeperDecision,
} from "../autonomy/schemas.js";
import {
  buildAutonomousContractRequest,
  egressAutonomousAbi,
  type ContractAutonomousRequest,
  type PreparedAutonomousWriteRequest,
} from "../autonomy/contract.js";
import {
  protectionPolicyId,
  riskLevelCode,
  verifyAutonomousRiskAttestation,
} from "../authorization/protection-policy.js";
import { operationalErrorMessage } from "../live/redaction.js";
import { percentMulUp } from "../market/math.js";

function sameAddress(left: string, right: string): boolean {
  return left.toLowerCase() === right.toLowerCase();
}

function accountAddress(account: Account | Address): Address {
  return typeof account === "string" ? getAddress(account) : account.address;
}

function unixNow(now: Date): bigint {
  return BigInt(Math.floor(now.getTime() / 1_000));
}

function ageSeconds(now: Date, timestamp: string): number {
  return Math.floor((now.getTime() - new Date(timestamp).getTime()) / 1_000);
}

function addCheck(
  checks: PolicyCheck[],
  check: string,
  passed: boolean,
  actual: string,
  required: string,
  reason: string,
): void {
  checks.push({ check, passed, actual, required, reason });
}

function minimum(...values: bigint[]): bigint {
  return values.reduce((result, value) => (value < result ? value : result));
}

function errorMessage(error: unknown): string {
  return operationalErrorMessage(error);
}

export interface ShadowKeeperTask {
  event: RiskEventRecord;
  policy: OnchainProtectionPolicy;
  attestation: AutonomousRiskAttestation;
}

export interface PreparedShadowDecision {
  decision: ShadowKeeperDecision;
  request: ContractAutonomousRequest | null;
  simulationRequest: PreparedAutonomousWriteRequest | null;
}

export class EgressShadowKeeper {
  private readonly now: () => Date;

  constructor(
    private readonly dependencies: {
      publicClient: PublicClient;
      marketProvider: MarketContextProvider;
      keeperAccount: Account | Address;
      walletClient?: WalletClient;
      now?: () => Date;
    },
  ) {
    this.now = dependencies.now ?? (() => new Date());
  }

  async evaluate(task: ShadowKeeperTask): Promise<ShadowKeeperDecision> {
    return (await this.prepareExecution(task)).decision;
  }

  /**
   * Exposes the exact typed autonomous request and successful simulation
   * request to the isolated staging worker. It does not broadcast.
   */
  async prepareExecution(task: ShadowKeeperTask): Promise<PreparedShadowDecision> {
    return this.prepare(task);
  }

  async executeFork(task: ShadowKeeperTask): Promise<{
    decision: ShadowKeeperDecision;
    transactionHash: Hex;
    blockNumber: bigint;
    gasUsed: bigint;
  }> {
    const prepared = await this.prepareExecution(task);
    if (prepared.decision.status !== "WOULD_EXECUTE" || !prepared.simulationRequest) {
      throw new Error(`Shadow keeper refused execution: ${prepared.decision.reasons.join("; ")}`);
    }
    if (task.event.mode === "LIVE") {
      throw new Error("Unattended live-mainnet broadcasting is disabled in Phase 5");
    }
    if (!this.dependencies.walletClient) {
      throw new Error("A wallet client is required for an explicit pinned-fork execution");
    }
    const hash = await this.dependencies.walletClient.writeContract({
      address: prepared.simulationRequest.address,
      abi: egressAutonomousAbi,
      functionName: prepared.simulationRequest.functionName,
      args: prepared.simulationRequest.args,
      chain: undefined,
      account: this.dependencies.keeperAccount,
      gas:
        prepared.simulationRequest.gas !== null
          ? prepared.simulationRequest.gas * 3n
          : 3_000_000n,
    });
    const receipt = await this.dependencies.publicClient.waitForTransactionReceipt({ hash });
    if (receipt.status !== "success") throw new Error("Autonomous fork transaction reverted atomically");
    return {
      decision: prepared.decision,
      transactionHash: hash,
      blockNumber: receipt.blockNumber,
      gasUsed: receipt.gasUsed,
    };
  }

  private async prepare(task: ShadowKeeperTask): Promise<PreparedShadowDecision> {
    const now = this.now();
    const nowSeconds = unixNow(now);
    const policyId = protectionPolicyId({
      chainId: task.event.policy.chainId,
      egressContract: task.event.policy.egressContract as Address,
      policy: task.policy,
    });
    const riskEventIdHash = objectHash(task.event.riskEventId);
    const checks: PolicyCheck[] = [];
    const chainId = await this.dependencies.publicClient.getChainId();
    const keeper = accountAddress(this.dependencies.keeperAccount);
    const egressContract = task.event.policy.egressContract as Address;

    const market = await this.dependencies.marketProvider.getContext(
      task.policy.user as Address,
      task.event.policy,
    );
    const [rawState, currentRevocationNonce, paused, used, protocolConfigHash, allowance] =
      await Promise.all([
        this.dependencies.publicClient.readContract({
          address: egressContract,
          abi: egressAutonomousAbi,
          functionName: "policyStates",
          args: [policyId],
        }),
        this.dependencies.publicClient.readContract({
          address: egressContract,
          abi: egressAutonomousAbi,
          functionName: "revocationNonces",
          args: [task.policy.user as Address],
        }),
        this.dependencies.publicClient.readContract({
          address: egressContract,
          abi: egressAutonomousAbi,
          functionName: "paused",
        }),
        this.dependencies.publicClient.readContract({
          address: egressContract,
          abi: egressAutonomousAbi,
          functionName: "riskEventUsed",
          args: [policyId, riskEventIdHash],
        }),
        this.dependencies.publicClient.readContract({
          address: egressContract,
          abi: egressAutonomousAbi,
          functionName: "PROTOCOL_CONFIG_HASH",
        }),
        this.dependencies.publicClient.readContract({
          address: market.position.aToken as Address,
          abi: erc20Abi,
          functionName: "allowance",
          args: [task.policy.user as Address, egressContract],
        }),
      ]);
    const [stateUser, active, executionCount, lastExecutionAt, cumulativeRepayment, cumulativeCollateral, enrollmentCollateral, enrollmentDebt] = rawState;
    const policyState: OnchainPolicyState = onchainPolicyStateSchema.parse({
      user: stateUser,
      active,
      executionCount: executionCount.toString(),
      lastExecutionAt: lastExecutionAt.toString(),
      cumulativeRepayment: cumulativeRepayment.toString(),
      cumulativeCollateral: cumulativeCollateral.toString(),
      enrollmentCollateral: enrollmentCollateral.toString(),
      enrollmentDebt: enrollmentDebt.toString(),
      currentRevocationNonce: currentRevocationNonce.toString(),
      paused,
      riskEventUsed: used,
      collateralAllowance: allowance.toString(),
    });

    addCheck(
      checks,
      "chain",
      chainId === task.event.policy.chainId,
      String(chainId),
      String(task.event.policy.chainId),
      "The keeper, policy, and Egress contract must share one chain.",
    );
    const identityMatches =
      sameAddress(task.policy.user, task.event.policy.user) &&
      sameAddress(task.policy.keeper, task.event.policy.executor) &&
      sameAddress(task.policy.riskAttestor, task.event.policy.approvedRiskAttestor) &&
      sameAddress(task.policy.keeper, keeper);
    addCheck(
      checks,
      "policy_identity",
      identityMatches,
      `${task.policy.user}:${task.policy.keeper}:${task.policy.riskAttestor}`,
      `${task.event.policy.user}:${task.event.policy.executor}:${task.event.policy.approvedRiskAttestor}`,
      "The pre-authorized position, keeper, and attestor must match the risk event policy.",
    );
    addCheck(
      checks,
      "protocol_configuration",
      task.policy.protocolConfigHash.toLowerCase() === protocolConfigHash.toLowerCase(),
      task.policy.protocolConfigHash,
      protocolConfigHash,
      "The signed policy must bind the immutable Aave, oracle, token, and Uniswap configuration.",
    );
    addCheck(
      checks,
      "policy_registered",
      sameAddress(policyState.user, task.policy.user) && policyState.active,
      `${policyState.user}:${policyState.active}`,
      `${task.policy.user}:true`,
      "Autonomous execution requires an active onchain policy registration.",
    );
    addCheck(
      checks,
      "policy_revocation",
      BigInt(task.policy.revocationNonce) === currentRevocationNonce,
      currentRevocationNonce.toString(),
      task.policy.revocationNonce,
      "The user's onchain revocation epoch is authoritative.",
    );
    addCheck(
      checks,
      "policy_expiry",
      nowSeconds <= BigInt(task.policy.expiresAt),
      nowSeconds.toString(),
      `<=${task.policy.expiresAt}`,
      "Expired pre-authorizations fail closed.",
    );
    addCheck(
      checks,
      "execution_count",
      executionCount < BigInt(task.policy.maxExecutions),
      executionCount.toString(),
      `<${task.policy.maxExecutions}`,
      "A keeper cannot exceed the user's maximum execution count.",
    );
    const cooldownElapsed =
      lastExecutionAt === 0n || nowSeconds >= lastExecutionAt + BigInt(task.policy.cooldownSeconds);
    addCheck(
      checks,
      "cooldown",
      cooldownElapsed,
      lastExecutionAt.toString(),
      `${task.policy.cooldownSeconds}s elapsed`,
      "Per-policy cooldown is read from onchain state.",
    );
    addCheck(
      checks,
      "emergency_pause",
      !paused,
      String(paused),
      "false",
      "The guardian pause is an absolute stop.",
    );
    addCheck(
      checks,
      "risk_event_replay",
      !used,
      String(used),
      "false",
      "One risk event can authorize at most one policy execution.",
    );

    const attestationSignatureValid = await verifyAutonomousRiskAttestation({
      attestation: task.attestation,
      chainId,
      egressContract,
      riskAttestor: task.policy.riskAttestor as Address,
    });
    const attestationLinks =
      task.attestation.policyId.toLowerCase() === policyId.toLowerCase() &&
      task.attestation.riskEventId.toLowerCase() === riskEventIdHash.toLowerCase() &&
      task.attestation.verdictHash.toLowerCase() === objectHash(task.event.verdict).toLowerCase() &&
      task.attestation.evidenceHash.toLowerCase() ===
        objectHash(task.event.verdict.claims.flatMap((claim) => claim.evidence)).toLowerCase();
    addCheck(
      checks,
      "risk_attestation",
      attestationSignatureValid && attestationLinks,
      `${attestationSignatureValid}:${attestationLinks}`,
      "valid:true",
      "The attestor signs the exact policy, risk event, verdict, evidence, risk level, and lifetime.",
    );
    const riskCode = task.event.verdict.riskLevel === "HIGH" || task.event.verdict.riskLevel === "CRITICAL"
      ? riskLevelCode(task.event.verdict.riskLevel)
      : 0;
    const riskThresholdMet =
      meetsRiskThreshold(task.event.verdict.riskLevel, task.event.policy.riskTrigger) &&
      riskCode >= task.policy.minimumRiskLevel &&
      task.attestation.riskLevel === riskCode;
    addCheck(
      checks,
      "risk_threshold",
      riskThresholdMet,
      `${task.event.verdict.riskLevel}:${task.attestation.riskLevel}`,
      `>=${task.policy.minimumRiskLevel}`,
      "AI interpretation can trigger only the user-approved HIGH or CRITICAL threshold.",
    );
    addCheck(
      checks,
      "evidence",
      task.event.verdict.evidenceValidation.valid,
      String(task.event.verdict.evidenceValidation.valid),
      "true",
      "Unsupported claims cannot reach the keeper.",
    );
    const approvedSources = task.event.verdict.claims.every((claim) =>
      claim.evidence.every((item) => task.event.policy.approvedSourceIds.includes(item.sourceId)),
    );
    addCheck(
      checks,
      "approved_sources",
      approvedSources,
      [...new Set(task.event.verdict.claims.flatMap((claim) => claim.evidence.map((item) => item.sourceId)))].join(","),
      task.event.policy.approvedSourceIds.join(","),
      "Only policy-approved authoritative sources may support the verdict.",
    );
    const issuedAt = BigInt(task.attestation.issuedAt);
    const attestationFresh =
      nowSeconds <= BigInt(task.attestation.expiresAt) &&
      issuedAt <= nowSeconds + BigInt(task.policy.maxClockSkewSeconds) &&
      nowSeconds <= issuedAt + BigInt(task.policy.maxRiskAgeSeconds);
    addCheck(
      checks,
      "attestation_freshness",
      attestationFresh,
      `${task.attestation.issuedAt}..${task.attestation.expiresAt}`,
      `age<=${task.policy.maxRiskAgeSeconds}s`,
      "Stale or implausibly future-dated risk information is rejected.",
    );

    const positionAge = ageSeconds(now, market.position.observedAt);
    const liquidityAge = ageSeconds(now, market.liquidity.observedAt);
    const marketFresh =
      market.position.dataFresh &&
      positionAge >= -task.event.policy.maximumClockSkewSeconds &&
      liquidityAge >= -task.event.policy.maximumClockSkewSeconds &&
      Math.max(positionAge, liquidityAge) <= task.event.policy.marketMaxAgeSeconds;
    addCheck(
      checks,
      "fresh_market_state",
      marketFresh,
      `${positionAge}s:${liquidityAge}s`,
      `<=${task.event.policy.marketMaxAgeSeconds}s`,
      "Position, prices, and liquidity are refreshed immediately before simulation.",
    );
    const marketIdentity =
      sameAddress(market.position.user, task.policy.user) &&
      market.position.chainId === chainId &&
      market.liquidity.chainId === chainId &&
      market.position.blockNumber === market.liquidity.blockNumber &&
      market.position.singleMarketPosition;
    addCheck(
      checks,
      "position_binding",
      marketIdentity,
      `${market.position.user}@${market.position.blockNumber}`,
      `${task.policy.user}@same-block single-market`,
      "The policy binds one Aave account and the configured xBETH/xETH market.",
    );
    const healthFactor = BigInt(market.position.healthFactorWad);
    addCheck(
      checks,
      "health_factor_trigger",
      healthFactor <= BigInt(task.policy.maxPreHealthFactor),
      healthFactor.toString(),
      `<=${task.policy.maxPreHealthFactor}`,
      "A false HIGH verdict cannot deleverage a position above the user's trigger ceiling.",
    );
    addCheck(
      checks,
      "liquidity",
      market.liquidity.executable && market.plan.executable,
      market.plan.failureReason ?? market.liquidity.failureReason ?? "executable",
      "executable",
      "A pool address alone is not executable liquidity.",
    );
    addCheck(
      checks,
      "market_limits",
      market.liquidity.estimatedSlippageBps <= Number(task.policy.maxSlippageBps) &&
        market.liquidity.priceImpactBps <= task.event.policy.maximumPriceImpactBps &&
        market.liquidity.oraclePoolDeviationBps <= task.event.policy.maximumOraclePoolDeviationBps,
      `${market.liquidity.estimatedSlippageBps}:${market.liquidity.priceImpactBps}:${market.liquidity.oraclePoolDeviationBps}`,
      `${task.policy.maxSlippageBps}:${task.event.policy.maximumPriceImpactBps}:${task.event.policy.maximumOraclePoolDeviationBps}`,
      "Fresh deterministic liquidity metrics must remain inside the user policy.",
    );

    const repay = BigInt(market.plan.repayAmountWei);
    const collateral = BigInt(market.plan.collateralAmountWei);
    const cumulativeRepaymentAfter = cumulativeRepayment + repay;
    const cumulativeCollateralAfter = cumulativeCollateral + collateral;
    const percentageBudget =
      (enrollmentCollateral * BigInt(task.policy.maxCollateralPercentageBps)) / 10_000n;
    const amountBounds =
      repay > 0n &&
      collateral > 0n &&
      repay <= BigInt(task.policy.maxRepaymentPerExecution) &&
      collateral <= BigInt(task.policy.maxCollateralPerExecution) &&
      cumulativeRepaymentAfter <= BigInt(task.policy.maxCumulativeRepayment) &&
      cumulativeCollateralAfter <= BigInt(task.policy.maxCumulativeCollateral) &&
      cumulativeCollateralAfter <= percentageBudget &&
      BigInt(market.position.debtBalanceWei) <= BigInt(task.policy.maxPositionDebt);
    addCheck(
      checks,
      "bounded_amounts",
      amountBounds,
      `${repay}:${collateral}:${cumulativeRepaymentAfter}:${cumulativeCollateralAfter}`,
      `${task.policy.maxRepaymentPerExecution}:${task.policy.maxCollateralPerExecution}:${task.policy.maxCumulativeRepayment}:${task.policy.maxCumulativeCollateral}`,
      "The deterministic planner cannot expand any signed per-action, cumulative, or position bound.",
    );
    addCheck(
      checks,
      "post_health_factor",
      BigInt(market.plan.projectedPostHealthFactorWad) >= BigInt(task.policy.minPostHealthFactor),
      market.plan.projectedPostHealthFactorWad,
      `>=${task.policy.minPostHealthFactor}`,
      "The projected and actual post-action health factor have the same contract floor.",
    );
    const oracleOut =
      (collateral * BigInt(market.position.xbEthPriceBase)) / BigInt(market.position.xethPriceBase);
    const oracleFloor =
      (oracleOut * (10_000n - BigInt(task.policy.maxOracleDeviationBps))) / 10_000n;
    const outputBounds =
      BigInt(market.plan.minimumSwapOutWei) >= oracleFloor &&
      BigInt(market.plan.minimumSwapOutWei) >=
        repay + percentMulUp(repay, BigInt(task.policy.maxFlashLoanPremiumBps));
    addCheck(
      checks,
      "output_floor",
      outputBounds,
      market.plan.minimumSwapOutWei,
      `>=max(${oracleFloor},flash repayment)`,
      "The contract anchors output to Aave oracle prices as well as the keeper's quote.",
    );
    addCheck(
      checks,
      "collateral_allowance",
      allowance >= collateral,
      allowance.toString(),
      `>=${collateral}`,
      "The setup-time allowance must still cover the bounded action; no post-event permit is accepted.",
    );

    const expiresAt = minimum(
      BigInt(task.policy.expiresAt),
      BigInt(task.attestation.expiresAt),
      nowSeconds + BigInt(task.event.policy.intentTtlSeconds),
    );
    const execution: AutonomousExecution | null = checks.every((check) => check.passed)
      ? autonomousExecutionSchema.parse({
          repayAmount: market.plan.repayAmountWei,
          collateralAmount: market.plan.collateralAmountWei,
          expectedSwapOut: market.plan.expectedSwapOutWei,
          minSwapOut: market.plan.minimumSwapOutWei,
          deadline: expiresAt.toString(),
          executionNonce: executionCount.toString(),
        })
      : null;

    let request: ContractAutonomousRequest | null = null;
    let simulationRequest: PreparedAutonomousWriteRequest | null = null;
    let simulation = { attempted: false, success: false, gasEstimate: null as string | null, error: null as string | null };
    if (execution) {
      request = buildAutonomousContractRequest({
        policy: task.policy,
        attestation: task.attestation,
        execution,
      });
      simulation.attempted = true;
      try {
        const result = await this.dependencies.publicClient.simulateContract({
          account: this.dependencies.keeperAccount,
          address: egressContract,
          abi: egressAutonomousAbi,
          functionName: "executeAutonomous",
          args: [request],
          blockNumber: BigInt(market.position.blockNumber),
        });
        simulationRequest = {
          address: egressContract,
          functionName: "executeAutonomous",
          args: [request] as const,
          gas: typeof (result.request as { gas?: unknown }).gas === "bigint"
            ? (result.request as { gas: bigint }).gas
            : null,
        };
        simulation.success = true;
        simulation.gasEstimate =
          typeof (result.request as { gas?: unknown }).gas === "bigint"
            ? ((result.request as { gas: bigint }).gas).toString()
            : null;
      } catch (error) {
        simulation.error = errorMessage(error);
      }
      addCheck(
        checks,
        "contract_simulation",
        simulation.success,
        simulation.error ?? "success",
        "success",
        "The exact request must pass the final contract boundary before any broadcast.",
      );
    }

    const allowed = execution !== null && simulation.success && checks.every((check) => check.passed);
    const reasons = allowed
      ? ["Fresh risk, market, policy, allowance, and contract simulation checks passed."]
      : checks.filter((check) => !check.passed).map((check) => `${check.check}: ${check.reason}`);
    const decisionBase = {
      status: allowed ? "WOULD_EXECUTE" as const : "WOULD_NOT_EXECUTE" as const,
      evaluatedAt: now.toISOString(),
      riskEventId: task.event.riskEventId,
      riskEventIdHash,
      policyId,
      checks,
      reasons,
      market,
      policyState,
      attestation: task.attestation,
      execution,
      simulation,
    };
    const decision = shadowKeeperDecisionSchema.parse({
      decisionId: shortId("shadow", decisionBase),
      ...decisionBase,
    });
    return { decision, request, simulationRequest };
  }
}

export class ShadowKeeperPoller {
  constructor(
    private readonly keeper: EgressShadowKeeper,
    private readonly discover: () => Promise<ShadowKeeperTask[]>,
    private readonly onDecision: (decision: ShadowKeeperDecision) => Promise<void> | void,
  ) {}

  async run(input: { intervalMs: number; maxIterations?: number; signal?: AbortSignal }): Promise<void> {
    const maximum = input.maxIterations ?? Number.POSITIVE_INFINITY;
    for (let iteration = 0; iteration < maximum; iteration += 1) {
      if (input.signal?.aborted) return;
      for (const task of await this.discover()) {
        await this.onDecision(await this.keeper.evaluate(task));
      }
      if (iteration + 1 >= maximum || input.signal?.aborted) return;
      await new Promise<void>((resolve) => setTimeout(resolve, input.intervalMs));
    }
  }
}
