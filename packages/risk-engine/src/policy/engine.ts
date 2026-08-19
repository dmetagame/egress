import type { Address, Hex } from "viem";
import type {
  ExecutionIntent,
  MarketContext,
  PolicyRuntimeState,
  RiskAttestation,
  RiskVerdict,
  UserProtectionPolicy,
} from "../domain/schemas.js";
import type { ExecutorAuthorization, PolicyCheck } from "../domain/types.js";
import { objectHash, shortId } from "../domain/hash.js";
import { meetsRiskThreshold } from "../domain/risk.js";
import { verifyRiskAttestation } from "../authorization/risk-attestation.js";
import { verifyExecutorAuthorizationSignature } from "../authorization/executor-typed-data.js";
import { percentMulUp } from "../market/math.js";

function signedAgeSeconds(now: Date, timestamp: string): number {
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

export class DeterministicPolicyEngine {
  async evaluate(input: {
    verdict: RiskVerdict;
    attestation: RiskAttestation | null;
    market: MarketContext;
    policy: UserProtectionPolicy;
    runtime: PolicyRuntimeState;
  }): Promise<ExecutionIntent> {
    const { verdict, attestation, market, policy, runtime } = input;
    const now = new Date(runtime.evaluatedAt);
    const checks: PolicyCheck[] = [];
    const failReasons: string[] = [];

    const attestationResult = attestation
      ? await verifyRiskAttestation({ attestation, verdict, policy })
      : { valid: false, reason: "No signed risk attestation was supplied." };
    addCheck(
      checks,
      "risk_attestation",
      attestationResult.valid,
      attestationResult.valid ? "valid" : "invalid",
      policy.approvedRiskAttestor,
      attestationResult.reason,
    );

    addCheck(
      checks,
      "evidence_valid",
      verdict.evidenceValidation.valid,
      String(verdict.evidenceValidation.valid),
      "true",
      verdict.evidenceValidation.valid
        ? "All cited evidence resolves to exact source revision excerpts."
        : "Unsupported or conflicting evidence cannot authorize an action.",
    );

    const approvedSources = verdict.claims.every((claim) =>
      claim.evidence.every((evidence) => policy.approvedSourceIds.includes(evidence.sourceId)),
    );
    addCheck(
      checks,
      "approved_sources",
      approvedSources,
      [...new Set(verdict.claims.flatMap((claim) => claim.evidence.map((item) => item.sourceId)))].join(","),
      policy.approvedSourceIds.join(","),
      approvedSources ? "All evidence comes from policy-approved sources." : "Verdict cites an unapproved source.",
    );

    const verdictNotExpired = now.getTime() <= new Date(verdict.expiresAt).getTime();
    addCheck(
      checks,
      "verdict_expiry",
      verdictNotExpired,
      runtime.evaluatedAt,
      verdict.expiresAt,
      verdictNotExpired ? "Verdict is unexpired." : "Verdict has expired.",
    );

    const verdictAge = signedAgeSeconds(now, verdict.issuedAt);
    const verdictTimestampValid =
      verdictAge >= -policy.maximumClockSkewSeconds &&
      verdictAge <= policy.verdictMaxAgeSeconds;
    addCheck(
      checks,
      "verdict_freshness",
      verdictTimestampValid,
      `${verdictAge}s`,
      `-${policy.maximumClockSkewSeconds}s..${policy.verdictMaxAgeSeconds}s`,
      "Risk interpretation must be recent and cannot be implausibly future-dated.",
    );

    const riskMet = meetsRiskThreshold(verdict.riskLevel, policy.riskTrigger);
    addCheck(
      checks,
      "risk_threshold",
      riskMet,
      verdict.riskLevel,
      `>=${policy.riskTrigger}`,
      riskMet ? "Risk threshold is met." : "Risk is below the user's trigger or evidence is insufficient.",
    );

    addCheck(
      checks,
      "confidence",
      verdict.confidence >= policy.minimumConfidence,
      verdict.confidence.toString(),
      `>=${policy.minimumConfidence}`,
      "Low-confidence model output cannot authorize action.",
    );

    addCheck(
      checks,
      "policy_authorization_expiry",
      now.getTime() <= new Date(policy.authorizationExpiresAt).getTime(),
      runtime.evaluatedAt,
      policy.authorizationExpiresAt,
      "The user's protection policy must still be active.",
    );

    const cooldownElapsed =
      runtime.lastExecutionAt === null ||
      signedAgeSeconds(now, runtime.lastExecutionAt) >= policy.cooldownSeconds;
    addCheck(
      checks,
      "cooldown",
      cooldownElapsed,
      runtime.lastExecutionAt ?? "never",
      `${policy.cooldownSeconds}s`,
      cooldownElapsed ? "Cooldown has elapsed." : "A prior action is still in cooldown.",
    );

    addCheck(
      checks,
      "nonce_unused",
      !runtime.nonceAlreadyUsed,
      runtime.authorizationNonce,
      "unused",
      "The executor contract also enforces nonce replay protection.",
    );

    addCheck(
      checks,
      "executor_unpaused",
      !runtime.executorPaused,
      String(runtime.executorPaused),
      "false",
      "The onchain emergency pause is an absolute execution stop.",
    );

    const positionAge = signedAgeSeconds(now, market.position.observedAt);
    const liquidityAge = signedAgeSeconds(now, market.liquidity.observedAt);
    const marketAge = Math.max(positionAge, liquidityAge);
    const marketFresh =
      market.position.dataFresh &&
      positionAge >= -policy.maximumClockSkewSeconds &&
      liquidityAge >= -policy.maximumClockSkewSeconds &&
      marketAge <= policy.marketMaxAgeSeconds;
    addCheck(
      checks,
      "market_freshness",
      marketFresh,
      `${marketAge}s`,
      `<=${policy.marketMaxAgeSeconds}s`,
      "Position and liquidity data must be recent.",
    );

    const identityMatches =
      market.position.user.toLowerCase() === policy.user.toLowerCase() &&
      market.position.chainId === policy.chainId &&
      market.liquidity.chainId === policy.chainId &&
      market.position.blockNumber === market.liquidity.blockNumber;
    addCheck(
      checks,
      "market_identity",
      identityMatches,
      `${market.position.user}@${market.position.chainId}:${market.position.blockNumber}`,
      `${policy.user}@${policy.chainId}:same-block`,
      "All deterministic reads must describe the authorized user on one block.",
    );

    const assetIdentityMatches =
      market.liquidity.tokenIn.toLowerCase() === market.position.collateralToken.toLowerCase() &&
      market.liquidity.tokenOut.toLowerCase() === market.position.debtToken.toLowerCase();
    addCheck(
      checks,
      "market_assets",
      assetIdentityMatches,
      `${market.liquidity.tokenIn}->${market.liquidity.tokenOut}`,
      `${market.position.collateralToken}->${market.position.debtToken}`,
      "The executable quote must sell the configured collateral into the configured debt asset.",
    );

    addCheck(
      checks,
      "single_market_scope",
      market.position.singleMarketPosition,
      market.position.positionScopeReason,
      "xBETH collateral + xETH variable debt only",
      "Egress refuses mixed Aave accounts because its projection is single-market.",
    );

    const currentHealthFactor = BigInt(market.position.healthFactorWad);
    const triggerHealthFactor = BigInt(policy.triggerHealthFactorWad);
    addCheck(
      checks,
      "health_factor_trigger",
      currentHealthFactor <= triggerHealthFactor,
      currentHealthFactor.toString(),
      `<=${triggerHealthFactor}`,
      "High RWA risk alone does not force deleveraging a healthy position.",
    );

    addCheck(
      checks,
      "liquidity_executable",
      market.liquidity.executable && market.plan.executable,
      market.plan.failureReason ?? market.liquidity.failureReason ?? "executable",
      "executable",
      "A pool existing is not proof that the bounded exit can execute.",
    );

    addCheck(
      checks,
      "slippage",
      market.liquidity.estimatedSlippageBps <= policy.maximumSlippageBps,
      `${market.liquidity.estimatedSlippageBps}bps`,
      `<=${policy.maximumSlippageBps}bps`,
      "Expected slippage must remain within the user's limit.",
    );

    addCheck(
      checks,
      "price_impact",
      market.liquidity.priceImpactBps <= policy.maximumPriceImpactBps,
      `${market.liquidity.priceImpactBps}bps`,
      `<=${policy.maximumPriceImpactBps}bps`,
      "Price impact is independently capped.",
    );

    addCheck(
      checks,
      "oracle_pool_deviation",
      market.liquidity.oraclePoolDeviationBps <= policy.maximumOraclePoolDeviationBps,
      `${market.liquidity.oraclePoolDeviationBps}bps`,
      `<=${policy.maximumOraclePoolDeviationBps}bps`,
      "The Uniswap spot price must remain close to the independent Aave oracle ratio.",
    );

    const quoteConsistent =
      market.plan.collateralAmountWei === market.liquidity.amountInWei &&
      market.plan.expectedSwapOutWei === market.liquidity.expectedAmountOutWei &&
      BigInt(market.plan.minimumSwapOutWei) > 0n &&
      BigInt(market.plan.minimumSwapOutWei) <= BigInt(market.plan.expectedSwapOutWei);
    addCheck(
      checks,
      "plan_quote_consistency",
      quoteConsistent,
      `${market.plan.collateralAmountWei}:${market.plan.expectedSwapOutWei}:${market.plan.minimumSwapOutWei}`,
      `${market.liquidity.amountInWei}:${market.liquidity.expectedAmountOutWei}:0<min<=expected`,
      "The bounded plan must be derived from the same liquidity quote.",
    );

    const repaymentWithinCap =
      BigInt(market.plan.repayAmountWei) > 0n &&
      BigInt(market.plan.repayAmountWei) <= BigInt(policy.maximumRepaymentWei) &&
      BigInt(market.plan.repayAmountWei) <= BigInt(market.position.debtBalanceWei);
    addCheck(
      checks,
      "repayment_cap",
      repaymentWithinCap,
      market.plan.repayAmountWei,
      `<=${policy.maximumRepaymentWei}`,
      "Repayment is bounded by policy and current debt.",
    );

    const maximumPremium = percentMulUp(
      BigInt(market.plan.repayAmountWei),
      BigInt(policy.maximumFlashLoanPremiumBps),
    );
    const flashLoanCovered =
      BigInt(market.plan.flashLoanPremiumCeilingWei) === maximumPremium &&
      BigInt(market.plan.minimumSwapOutWei) >=
        BigInt(market.plan.repayAmountWei) + maximumPremium;
    addCheck(
      checks,
      "flash_loan_coverage",
      flashLoanCovered,
      `${market.plan.minimumSwapOutWei} minOut / ${market.plan.flashLoanPremiumCeilingWei} premium`,
      `>=repay+${maximumPremium} with matching premium ceiling`,
      "The signed minimum output must atomically cover repayment plus the full permitted premium.",
    );

    const collateralPercentageCap =
      (BigInt(market.position.collateralBalanceWei) *
        BigInt(policy.maximumCollateralPercentageBps)) /
      10_000n;
    const collateralWithinCap =
      BigInt(market.plan.collateralAmountWei) > 0n &&
      BigInt(market.plan.collateralAmountWei) <= BigInt(policy.maximumCollateralWei) &&
      BigInt(market.plan.collateralAmountWei) <= collateralPercentageCap;
    addCheck(
      checks,
      "collateral_cap",
      collateralWithinCap,
      market.plan.collateralAmountWei,
      `<=min(${policy.maximumCollateralWei},${collateralPercentageCap})`,
      "Collateral sold is bounded by absolute and percentage caps.",
    );

    const postHealthFactor = BigInt(market.plan.projectedPostHealthFactorWad);
    const minimumPostHealthFactor = BigInt(policy.minimumPostHealthFactorWad);
    addCheck(
      checks,
      "post_health_factor",
      postHealthFactor >= minimumPostHealthFactor,
      postHealthFactor.toString(),
      `>=${minimumPostHealthFactor}`,
      "The execution contract independently enforces this signed floor.",
    );

    const hardChecksPassed = checks.every((check) => check.passed);
    if (!hardChecksPassed) {
      failReasons.push(...checks.filter((check) => !check.passed).map((check) => `${check.check}: ${check.reason}`));
    }

    const expiresAtMs = Math.min(
      new Date(policy.authorizationExpiresAt).getTime(),
      new Date(verdict.expiresAt).getTime(),
      now.getTime() + policy.intentTtlSeconds * 1_000,
    );
    const authorization = hardChecksPassed
      ? this.buildAuthorization(market, policy, runtime, expiresAtMs)
      : null;

    let userSignatureValid = false;
    if (authorization && runtime.userAuthorizationSignature) {
      userSignatureValid = await verifyExecutorAuthorizationSignature({
        chainId: policy.chainId,
        egressContract: policy.egressContract as Address,
        authorization,
        signature: runtime.userAuthorizationSignature as Hex,
      });
    }

    addCheck(
      checks,
      "user_authorization",
      authorization === null || userSignatureValid,
      runtime.userAuthorizationSignature ? (userSignatureValid ? "valid" : "invalid") : "missing",
      authorization === null ? "not-applicable" : "valid EIP-712 signature",
      authorization === null
        ? "No permitted action exists to sign."
        : "The user, not the AI or attestor, must sign the exact executor authorization.",
    );
    addCheck(
      checks,
      "collateral_authorization",
      authorization === null || runtime.collateralAuthorizationAvailable,
      String(runtime.collateralAuthorizationAvailable),
      authorization === null ? "not-applicable" : "permit or sufficient allowance",
      "Execution also requires an exact aXbETH permit or pre-existing bounded allowance.",
    );

    const readyForSubmission =
      hardChecksPassed && userSignatureValid && runtime.collateralAuthorizationAvailable;
    const invalidSuppliedUserSignature =
      authorization !== null &&
      runtime.userAuthorizationSignature !== null &&
      !userSignatureValid;
    const actionAllowed = hardChecksPassed && !invalidSuppliedUserSignature;
    if (invalidSuppliedUserSignature) {
      failReasons.push(
        "The supplied user signature does not authorize the exact bounded parameters; a fresh signature is required.",
      );
    }
    const intentBase = {
      riskEventId: verdict.riskEventId,
      riskVerdictId: verdict.verdictId,
      policyId: policy.policyId,
      generatedAt: runtime.evaluatedAt,
      expiresAt: new Date(expiresAtMs).toISOString(),
      authorization,
    };
    const intentId = shortId("intent", intentBase);
    const unsignedIntent = {
      intentId,
      riskEventId: verdict.riskEventId,
      riskVerdictId: verdict.verdictId,
      policyId: policy.policyId,
      allowed: actionAllowed,
      autoExecutionEligible: readyForSubmission && actionAllowed && policy.automaticExecutionEnabled,
      requiresUserSignature: actionAllowed && !userSignatureValid,
      status: !actionAllowed
        ? "REJECTED"
        : readyForSubmission
          ? "READY_FOR_SUBMISSION"
          : "AWAITING_USER_SIGNATURE",
      reasons:
        failReasons.length > 0
          ? failReasons
          : readyForSubmission
            ? ["All deterministic checks and user authorizations are valid."]
            : ["Policy permits the bounded action, but user authorization is incomplete."],
      checks,
      generatedAt: runtime.evaluatedAt,
      expiresAt: new Date(expiresAtMs).toISOString(),
      chainId: policy.chainId,
      egressContract: policy.egressContract,
      authorization,
    } as const;
    return {
      ...unsignedIntent,
      intentHash: objectHash(unsignedIntent),
    };
  }

  private buildAuthorization(
    market: MarketContext,
    policy: UserProtectionPolicy,
    runtime: PolicyRuntimeState,
    expiresAtMs: number,
  ): ExecutorAuthorization {
    const percentageCap =
      (BigInt(market.position.collateralBalanceWei) *
        BigInt(policy.maximumCollateralPercentageBps)) /
      10_000n;
    const signedCollateralCap =
      BigInt(policy.maximumCollateralWei) < percentageCap
        ? BigInt(policy.maximumCollateralWei)
        : percentageCap;
    const signedRepaymentCap =
      BigInt(policy.maximumRepaymentWei) < BigInt(market.position.debtBalanceWei)
        ? BigInt(policy.maximumRepaymentWei)
        : BigInt(market.position.debtBalanceWei);
    return {
      user: policy.user,
      executor: policy.executor,
      repayAmount: market.plan.repayAmountWei,
      collateralAmount: market.plan.collateralAmountWei,
      maxRepayment: signedRepaymentCap.toString(),
      maxCollateral: signedCollateralCap.toString(),
      expectedSwapOut: market.plan.expectedSwapOutWei,
      minSwapOut: market.plan.minimumSwapOutWei,
      maxSlippageBps: policy.maximumSlippageBps.toString(),
      maxFlashLoanPremiumBps: policy.maximumFlashLoanPremiumBps.toString(),
      minPostHealthFactor: policy.minimumPostHealthFactorWad,
      deadline: Math.floor(expiresAtMs / 1_000).toString(),
      nonce: runtime.authorizationNonce,
      revocationNonce: runtime.revocationNonce,
    };
  }
}
