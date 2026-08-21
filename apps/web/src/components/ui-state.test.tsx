import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { EnvironmentNotice } from "./app-shell";
import { EgressControlLoop } from "./control-loop";
import { ExecutionPreview, ExecutionResult } from "./execution-details";
import { PolicyEvaluation } from "./policy-evaluation";
import { PolicyReview, ProtectionSetup, RevocationPanel } from "./protection-console";
import { RiskEvidencePanel } from "./risk-evidence";
import { ReplayConsole } from "./replay-console";
import { LiveOverview } from "./live-overview";
import { ProtectionDashboard } from "./protection-dashboard";
import { HealthBoundary } from "./health-boundary";
import type {
  LiveApiResponse,
  LiveCurrentApiResponse,
  LiveHistoryItem,
  ProductSnapshot,
  ReplayApiResponse,
} from "@/lib/types";

const snapshot = {
  environment: { chainId: 196, forkBlock: 67881241 },
  actors: { user: "0x1111111111111111111111111111111111111111", keeper: "0x2222222222222222222222222222222222222222", riskAttestor: "0x3333333333333333333333333333333333333333" },
  contracts: { egressExecutor: "0x4444444444444444444444444444444444444444", aXbEth: "0x5555555555555555555555555555555555555555", swapPool: "0x6666666666666666666666666666666666666666" },
  authorization: { policyId: "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", policy: { minimumRiskLevel: 3, maxPreHealthFactor: "1050000000000000000", minPostHealthFactor: "1065000000000000000", maxRepaymentPerExecution: "12000000000000000000", maxCollateralPerExecution: "12000000000000000000", maxCollateralPercentageBps: "2500", maxSlippageBps: "100", cooldownSeconds: "3600", maxExecutions: "1", expiresAt: "1786654007", nonce: "5001", protocolConfigHash: "0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb" }, permitNonceAfterSetup: "1", postEventPermitNonce: "1" },
  policyState: { collateralAllowance: "12500000000000000000" },
  position: { before: { healthFactorWad: "1034610464600521702" } },
} as unknown as ProductSnapshot;

function response(
  level: "NORMAL" | "MEDIUM" | "HIGH",
  autonomous = false,
  options: { status?: "WOULD_EXECUTE" | "WOULD_NOT_EXECUTE"; simulationSuccess?: boolean; execution?: unknown } = {},
): ReplayApiResponse {
  const high = level === "HIGH";
  return {
    revision: high ? "C" : level === "MEDIUM" ? "B" : "A",
    pipelineStatus: "EVALUATED",
    message: high ? "A bounded execution intent was permitted" : "No executable intent",
    snapshot: { sourceUrl: "https://www.okx.com/help/how-does-xasset-work", revisionId: "rev_current" } as never,
    diff: {} as never,
    event: {
      riskEventId: "risk_demo",
      policy: { maximumSlippageBps: 100 },
      verdict: {
        riskLevel: level,
        confidence: 0.94,
        issuedAt: "2026-08-14T10:00:00.000Z",
        summary: "Evidence-backed finding",
        rationale: "The source changed exit conditions.",
        evidenceValidation: { valid: true },
        claims: [{
          claimId: "claim_demo",
          claimType: "REDEMPTION",
          changeSummary: high ? "Redemption terms changed" : "Baseline recorded",
          positionImpact: "The position impact is traceable to the source revision.",
          previousValue: "Normal conversion",
          currentValue: high ? "Subject to reserve availability" : "Normal conversion",
          materiality: high ? "HIGH" : level,
          confidence: 0.94,
          evidence: [{ side: "CURRENT", sourceUrl: "https://www.okx.com/help/how-does-xasset-work", revisionId: "rev_current", location: { section: "Deposit and withdrawal" } }],
        }],
      },
      intent: { allowed: high, checks: [{ check: "risk_threshold", passed: high, actual: level, reason: "Risk trigger" }] },
    } as never,
    autonomous: autonomous ? {
      label: "PINNED X LAYER FORK SIMULATION",
      environment: { chainId: 196, forkBlock: 67881241 },
      decision: {
        status: options.status ?? "WOULD_EXECUTE",
        reasons: options.simulationSuccess === false ? ["Contract simulation reverted."] : ["All deterministic gates passed."],
        checks: [{ check: "risk_threshold", passed: true, actual: "HIGH", reason: "Trigger met" }, { check: "contract_simulation", passed: true, actual: "success", reason: "Simulation passed" }],
        simulation: { attempted: true, success: options.simulationSuccess ?? true, gasEstimate: null, error: options.simulationSuccess === false ? "simulation reverted" : null },
        execution: { repayAmount: "10815264588741485975", collateralAmount: "10803443507051301343", expectedSwapOut: "10929971940440259312", minSwapOut: "10820672221035856718", executionNonce: "0" },
        market: { plan: { projectedPostHealthFactorWad: "1075000000000023945", flashLoanPremiumCeilingWei: "5407632294370743" } },
      },
      execution: options.execution === undefined ? { transactionHash: "0xcccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc", blockNumber: "67881249", gasUsed: "964117", deleveraged: { debtRepaidWei: "10815264588741485975", collateralSoldWei: "10803443507051301343", swapOutputWei: "10929971940440259312", flashPremiumWei: "5407632294370743", surplusReturnedWei: "109299719404402594", healthFactorBeforeWad: "1034610451232364178", healthFactorAfterWad: "1074999981589751047" } } : options.execution,
    } as never : null,
  };
}

describe("Egress product safety states", () => {
  it("always labels the public environment boundaries", () => {
    render(<EnvironmentNotice />);
    expect(screen.getByText("LIVE READ-ONLY")).toBeInTheDocument();
    expect(screen.getByText("X Layer mainnet observation / chain 196")).toBeInTheDocument();
    expect(screen.getByText("Historical testnet evidence / chain 1952")).toBeInTheDocument();
    expect(screen.getByText("Broadcast disabled / stale data fails closed")).toBeInTheDocument();
  });

  it("renders the control loop with explicit statuses", () => {
    render(<EgressControlLoop states={[
      { status: "passed", detail: "Detected" },
      { status: "passed", detail: "HIGH" },
      { status: "blocked", detail: "Rejected" },
      { status: "pending", detail: "Waiting" },
      { status: "pending", detail: "Waiting" },
      { status: "pending", detail: "Waiting" },
    ]} />);
    expect(screen.getByText("RWA signal")).toBeInTheDocument();
    expect(screen.getByText("Policy")).toBeInTheDocument();
    expect(screen.getByText("Rejected")).toBeInTheDocument();
  });

  it.each([
    ["NORMAL", "NORMAL"],
    ["MEDIUM", "MEDIUM"],
    ["HIGH", "HIGH"],
  ] as const)("renders %s evidence state", (level, label) => {
    render(<RiskEvidencePanel response={response(level)} />);
    expect(screen.getAllByText(label).length).toBeGreaterThan(0);
    expect(screen.getByText("Evidence-backed finding")).toBeInTheDocument();
  });

  it("distinguishes a rejected policy from an approved policy", () => {
    const { rerender } = render(<PolicyEvaluation allowed={false} checks={[{ check: "risk_threshold", passed: false, actual: "MEDIUM", required: ">=HIGH", reason: "Below trigger" }]} />);
    expect(screen.getByText("DO NOT EXECUTE")).toBeInTheDocument();
    rerender(<PolicyEvaluation allowed checks={[{ check: "risk_threshold", passed: true, actual: "HIGH", required: ">=HIGH", reason: "Trigger met" }]} />);
    expect(screen.getByText("EXECUTE")).toBeInTheDocument();
  });

  it("renders a simulation-safe empty state and the successful fork result", () => {
    const { rerender } = render(<ExecutionPreview response={response("MEDIUM")} />);
    expect(screen.getByText("No execution authorized")).toBeInTheDocument();
    rerender(<ExecutionPreview response={response("HIGH", true)} />);
    expect(screen.getByText("Egress will deleverage")).toBeInTheDocument();
    render(<ExecutionResult response={response("HIGH", true)} />);
    expect(screen.getByText("Position protected")).toBeInTheDocument();
    expect(screen.getByText("FORK TRANSACTION")).toBeInTheDocument();
  });

  it("renders failed simulation and unconfirmed execution as safe failures", () => {
    const failedSimulation = response("HIGH", true, { status: "WOULD_NOT_EXECUTE", simulationSuccess: false, execution: null });
    const { rerender } = render(<ExecutionResult response={failedSimulation} />);
    expect(screen.getByText("Simulation failed safely")).toBeInTheDocument();
    expect(screen.queryByText("Position protected")).not.toBeInTheDocument();

    rerender(<ExecutionResult response={response("HIGH", true, { execution: null })} />);
    expect(screen.getByText("Execution failed safely")).toBeInTheDocument();
  });

  it("renders revoked and expired policy states", () => {
    const revoked = {
      ...snapshot,
      policyState: { ...snapshot.policyState, active: false },
    } as ProductSnapshot;
    const { rerender } = render(<PolicyReview snapshot={revoked} />);
    expect(screen.getByText("REVOKED")).toBeInTheDocument();

    const expired = {
      ...snapshot,
      market: { position: { observedAt: "2026-08-15T10:00:00.000Z" } },
      policyState: { ...snapshot.policyState, active: true },
    } as ProductSnapshot;
    rerender(<PolicyReview snapshot={expired} />);
    expect(screen.getByText("EXPIRED")).toBeInTheDocument();
  });

  it("shows revocation and allowance cleanup as separate controls", () => {
    render(<RevocationPanel snapshot={snapshot} />);
    expect(screen.getByRole("button", { name: "Revoke protection" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Set allowance to zero" })).toBeDisabled();
    expect(screen.getByText(/does not automatically erase/i)).toBeInTheDocument();
  });

  it("keeps setup writes locked until a verified fork runtime is connected", () => {
    render(<ProtectionSetup snapshot={snapshot} />);
    expect(screen.getByRole("button", { name: "Approve bounded allowance" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Register protection" })).toBeDisabled();
    expect(screen.getByText(/never broadcasts to mainnet/i)).toBeInTheDocument();
  });

  it("labels replay mode before any revision is run", () => {
    render(<ReplayConsole snapshot={snapshot} />);
    expect(screen.getByText("REPLAY MODE")).toBeInTheDocument();
    expect(screen.getByText("PINNED FORK")).toBeInTheDocument();
  });
});

describe("Live read-only UI safety", () => {
  it("shows a fail-closed protection state when current evidence is unavailable", () => {
    render(<ProtectionDashboard live={liveUnavailable()} current={null} />);
    expect(screen.getByText("STATUS UNAVAILABLE")).toBeInTheDocument();
    expect(screen.getByText("Egress cannot determine whether this position is safe.")).toBeInTheDocument();
    expect(screen.getByText("No verified position data")).toBeInTheDocument();
  });

  it("arms protection only when verified risk, policy, and execution conditions pass", () => {
    const live = liveAvailable();
    const armed = {
      ...live,
      snapshot: {
        ...live.snapshot!,
        rwa: {
          ...live.snapshot!.rwa,
          riskLevel: "HIGH",
          summary: "A material redemption-risk signal is present.",
        },
        policy: {
          status: "REGISTERED",
          reason: "The registered policy matches the current deployment configuration.",
          policy: {
            ...live.snapshot!.policy!.policy!,
            policyVersion: 1,
            riskTrigger: "HIGH",
            triggerHealthFactorWad: "1120000000000000000",
            targetPostHealthFactorWad: "1200000000000000000",
          },
        },
      },
    } as LiveApiResponse;

    render(<ProtectionDashboard live={armed} current={null} />);
    expect(screen.getByText("PROTECTION ARMED")).toBeInTheDocument();
    expect(screen.getByText("Risk is present. A bounded protection path has passed validation.")).toBeInTheDocument();
    expect(screen.getByText("Ready for bounded action")).toBeInTheDocument();
    expect(screen.getByText(/No transaction has been submitted/i)).toBeInTheDocument();
  });

  it("renders a verified health boundary without inventing a warning value", () => {
    render(<HealthBoundary value={1.0346} trigger={1.05} target={1.075} />);
    expect(screen.getByText("DANGER / TRIGGERED")).toBeInTheDocument();
    expect(screen.getByText("1.0346")).toBeInTheDocument();
    expect(screen.getByText("Liquidation boundary")).toBeInTheDocument();
  });

  it("renders a verified live snapshot as read-only evidence", () => {
    render(<LiveOverview initial={liveAvailable()} />);
    expect(screen.getByText("LIVE DATA AVAILABLE")).toBeInTheDocument();
    expect(screen.getAllByText("1.0750").length).toBeGreaterThan(0);
    expect(screen.getByText("BOUNDED ACTION PERMITTED")).toBeInTheDocument();
    expect(screen.getByText("Flash premium ceiling")).toBeInTheDocument();
    expect(screen.getByText("Surplus at premium ceiling")).toBeInTheDocument();
    expect(screen.getByText("PREVIEW ONLY / NO TRANSACTION SUBMITTED")).toBeInTheDocument();
  });

  it("renders missing live data as unavailable, never as LOW or protected", () => {
    render(<LiveOverview initial={liveUnavailable()} />);
    expect(screen.getAllByText("DATA UNAVAILABLE").length).toBeGreaterThan(0);
    expect(screen.getByText(/cannot establish a complete current position snapshot/i)).toBeInTheDocument();
    expect(screen.queryByText("LOW")).not.toBeInTheDocument();
    expect(screen.queryByText("Protected")).not.toBeInTheDocument();
    expect(screen.getByText("PREVIEW ONLY / NO TRANSACTION SUBMITTED")).toBeInTheDocument();
  });

  it("shows archived risk history, deterministic alerts, and integrity detail", () => {
    const live = liveAvailable();
    const current = {
      mode: "LIVE_READ_ONLY",
      status: "COMPLETE",
      snapshotHash: `0x${"cd".repeat(32)}`,
      block: "67980000",
      blockHash: `0x${"ab".repeat(32)}`,
      timestamp: live.generatedAt,
      risk: { classification: "NORMAL", evidenceStatus: "AVAILABLE", confidence: 0.9, summary: "No material change" },
      freshness: null,
      provenance: ["https://www.okx.com/help/how-does-xasset-work"],
      observation: { observationId: "observation_1", snapshotHash: `0x${"cd".repeat(32)}`, observedAt: live.generatedAt },
      snapshot: null,
      envelope: live,
      reasons: [],
      broadcastPermitted: false,
      transactionSubmitted: false,
    } satisfies LiveCurrentApiResponse;
    const history: LiveHistoryItem[] = [{
      observationId: "observation_1",
      snapshotHash: `0x${"cd".repeat(32)}`,
      status: "COMPLETE",
      block: "67980000",
      blockHash: `0x${"ab".repeat(32)}`,
      timestamp: live.generatedAt,
      riskClassification: "NORMAL",
      healthFactorWad: "1075000000000000000",
      collateralBalanceWei: "50000000000000000000",
      debtBalanceWei: "44050000000000000000",
      sourceRevisionIds: ["revision_1"],
      integrityHash: `0x${"ef".repeat(32)}`,
    }];
    render(<LiveOverview
      initial={live}
      initialCurrent={current}
      initialHistory={history}
      initialAlerts={[{
        schemaVersion: 1,
        alertId: "alert_1",
        deduplicationKey: `0x${"01".repeat(32)}`,
        alertType: "RISK_CHANGED",
        severity: "WARNING",
        snapshotHash: `0x${"cd".repeat(32)}`,
        previousSnapshotHash: `0x${"bc".repeat(32)}`,
        block: "67980000",
        timestamp: live.generatedAt,
        evidence: [{ code: "RISK_CLASSIFICATION_CHANGED", message: "Risk changed from NORMAL to MEDIUM.", source: "risk-engine", provenance: ["revision_1"] }],
        previousState: "NORMAL",
        currentState: "MEDIUM",
        thresholdPolicyVersion: 1,
        createdAt: live.generatedAt,
      }]}
    />);
    expect(screen.getByText("Recent risk history")).toBeInTheDocument();
    expect(screen.getByText("RISK CHANGED")).toBeInTheDocument();
    expect(screen.getByText("Risk changed from NORMAL to MEDIUM.")).toBeInTheDocument();
    expect(screen.getByText("Snapshot detail")).toBeInTheDocument();
  });
});

describe("Replay console failure boundary", () => {
  it("does not present a transaction when the backend replay fails", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ error: "source unavailable" }), { status: 400 })));
    const { ReplayConsole } = await import("./replay-console");
    render(<ReplayConsole snapshot={snapshot} />);
    fireEvent.click(screen.getByRole("button", { name: /run full replay/i }));
    await waitFor(() => expect(screen.getByText(/source unavailable/i)).toBeInTheDocument());
    expect(screen.queryByText("Position protected")).not.toBeInTheDocument();
    vi.unstubAllGlobals();
  });
});

function liveUnavailable(): LiveApiResponse {
  const now = "2026-08-15T10:00:00.000Z";
  return {
    mode: "LIVE_READ_ONLY",
    status: "LIVE_DATA_UNAVAILABLE",
    generatedAt: now,
    snapshot: null,
    partial: {
      chain: {
        chainId: 196,
        rpcUrl: "https://rpc.xlayer.tech",
        blockNumber: "67980000",
        blockHash: `0x${"ab".repeat(32)}`,
        blockTimestamp: now,
        rpcHealthy: true,
      },
      account: null,
      position: null,
      liquidity: null,
      oracle: null,
      uniswapPool: {
        factory: "0x4B2ab38DBF28D31D467aA8993f6c2585981D6804",
        pool: "0x84d4DbEebFf5F77c63F36bD0dCb18121Aa9aC8fc",
        token0: "0xAFeab3B85B6A56cF5F02317F0f7A23340eb983D7",
        token1: "0xE7B000003A45145decf8a28FC755aD5eC5EA025A",
        feeTier: 100,
        sqrtPriceX96: "1",
        tick: "0",
        activeLiquidity: "1",
        poolTokenInBalanceWei: "1",
        poolTokenOutBalanceWei: "1",
        unlocked: true,
        configurationVerified: true,
      },
      rwa: {
        status: "AVAILABLE",
        riskLevel: "NORMAL",
        verdictId: "verdict_live",
        summary: "No material source change was detected.",
        confidence: 0.9,
        claims: [],
        evidenceValid: true,
        latestRetrievedAt: now,
        sourceStates: [],
        reasons: [],
        analyzer: "DETERMINISTIC_REPLAY",
      },
      policy: null,
      executionPreview: null,
    },
    adapters: [
      {
        adapter: "xlayer",
        version: "1",
        status: "AVAILABLE",
        message: "RPC available",
        freshness: { observedAt: now, sourceTimestamp: now, blockNumber: "67980000", ageSeconds: 0, maxAgeSeconds: 120, fresh: true },
        provenance: ["https://rpc.xlayer.tech"],
      },
      {
        adapter: "account",
        version: "1",
        status: "UNAVAILABLE",
        message: "No live account configured",
        freshness: { observedAt: now, sourceTimestamp: null, blockNumber: "67980000", ageSeconds: null, maxAgeSeconds: 120, fresh: false },
        provenance: [],
      },
    ],
    reasons: ["LIVE_DATA_UNAVAILABLE: configure EGRESS_LIVE_ACCOUNT to read a supported Aave position."],
  };
}

function liveAvailable(): LiveApiResponse {
  const now = "2026-08-15T10:00:00.000Z";
  const position = {
    chainId: 196,
    blockNumber: "67980000",
    observedAt: now,
    user: "0x1111111111111111111111111111111111111111",
    collateralToken: "0xAFeab3B85B6A56cF5F02317F0f7A23340eb983D7",
    debtToken: "0xE7B000003A45145decf8a28FC755aD5eC5EA025A",
    aToken: "0xe9e78053f1Ef084f8cD01dBE8ccE95c6b0944d32",
    variableDebtToken: "0xB756Fc7065369602f2cCb8356283E8b997fDfe2a",
    collateralBalanceWei: "50000000000000000000",
    debtBalanceWei: "44050000000000000000",
    totalCollateralBase: "15000000000000",
    totalDebtBase: "13215000000000",
    availableBorrowsBase: "0",
    liquidationThresholdBps: 9000,
    ltvBps: 8800,
    healthFactorWad: "1075000000000000000",
    xbEthPriceBase: "300000000000",
    xethPriceBase: "300000000000",
    singleMarketPosition: true,
    positionScopeReason: "Supported position",
    dataFresh: true,
  };
  const liquidity = {
    chainId: 196,
    blockNumber: "67980000",
    observedAt: now,
    pool: "0x84d4DbEebFf5F77c63F36bD0dCb18121Aa9aC8fc",
    tokenIn: position.collateralToken,
    tokenOut: position.debtToken,
    feeTier: 100,
    amountInWei: "10000000000000000000",
    expectedAmountOutWei: "10100000000000000000",
    oracleReferencePriceWad: "1000000000000000000",
    spotPriceWad: "1000000000000000000",
    executionPriceWad: "1010000000000000000",
    oraclePoolDeviationBps: 0,
    priceImpactBps: 0,
    estimatedSlippageBps: 0,
    activeLiquidity: "100000000000000000000000",
    poolTokenInBalanceWei: "500000000000000000000",
    poolTokenOutBalanceWei: "510000000000000000000",
    quoteGasEstimate: "180000",
    estimatedExecutionGas: "900000",
    gasPriceWei: "100000000",
    estimatedExecutionCostWei: "90000000000000",
    executable: true,
    failureReason: null,
  };
  const plan = {
    repayAmountWei: "9800000000000000000",
    collateralAmountWei: "10000000000000000000",
    expectedSwapOutWei: liquidity.expectedAmountOutWei,
    minimumSwapOutWei: "9999000000000000000",
    projectedPostHealthFactorWad: "1075000000000000000",
    flashLoanPremiumCeilingWei: "4900000000000000",
    executable: true,
    failureReason: null,
  };
  return {
    ...liveUnavailable(),
    status: "AVAILABLE",
    snapshot: {
      schemaVersion: 1,
      mode: "LIVE_READ_ONLY",
      generatedAt: now,
      chain: {
        chainId: 196,
        rpcUrl: "https://rpc.xlayer.tech",
        blockNumber: "67980000",
        blockHash: `0x${"ab".repeat(32)}`,
        blockTimestamp: now,
        rpcHealthy: true,
      },
      account: position.user,
      aave: {
        position,
        collateralReserve: { asset: position.collateralToken, rawData: "0", ltvBps: 8800, liquidationThresholdBps: 9000, liquidationBonusBps: 10500, decimals: 18, active: true, frozen: false, borrowingEnabled: false, paused: false },
        debtReserve: { asset: position.debtToken, rawData: "0", ltvBps: 0, liquidationThresholdBps: 0, liquidationBonusBps: 0, decimals: 18, active: true, frozen: false, borrowingEnabled: true, paused: false },
        flashLoanPremiumBps: 5,
        addressesProviderVerified: true,
        oracleAddressVerified: true,
      },
      tokens: {
        xbEth: { address: position.collateralToken, symbol: "xBETH", name: "xBETH", decimals: 18, walletBalanceWei: "0", aTokenAllowanceWei: "0" },
        xeth: { address: position.debtToken, symbol: "xETH", name: "xETH", decimals: 18, walletBalanceWei: "0", aTokenAllowanceWei: null },
      },
      oracle: {
        xbEth: { asset: position.collateralToken, oracle: "0x91FC11136d5615575a0fC5981Ab5C0C54418E2C6", source: "0x3333333333333333333333333333333333333333", sourceKind: "CAPPED_RATIO", priceBase: position.xbEthPriceBase, decimals: 8, answer: position.xbEthPriceBase, updatedAt: now, roundId: "1", sourceDescription: "xBETH", ratio: "1000000000000000000", snapshotRatio: "1000000000000000000", snapshotTimestamp: now, fresh: true, provenance: ["oracle"] },
        xeth: { asset: position.debtToken, oracle: "0x91FC11136d5615575a0fC5981Ab5C0C54418E2C6", source: "0x3333333333333333333333333333333333333333", sourceKind: "CHAINLINK", priceBase: position.xethPriceBase, decimals: 8, answer: position.xethPriceBase, updatedAt: now, roundId: "1", sourceDescription: "xETH", ratio: null, snapshotRatio: null, snapshotTimestamp: null, fresh: true, provenance: ["oracle"] },
        maxAgeSeconds: 21600,
      },
      uniswap: {
        factory: "0x4B2ab38DBF28D31D467aA8993f6c2585981D6804",
        pool: liquidity.pool,
        token0: position.collateralToken,
        token1: position.debtToken,
        feeTier: 100,
        sqrtPriceX96: "79228162514264337593543950336",
        tick: "0",
        activeLiquidity: liquidity.activeLiquidity,
        poolTokenInBalanceWei: liquidity.poolTokenInBalanceWei,
        poolTokenOutBalanceWei: liquidity.poolTokenOutBalanceWei,
        unlocked: true,
        configurationVerified: true,
        quote: liquidity,
      },
      rwa: { ...liveUnavailable().partial.rwa!, status: "AVAILABLE", riskLevel: "NORMAL", verdictId: "verdict_live", summary: "No material change", confidence: 0.9, claims: [], evidenceValid: true, latestRetrievedAt: now, sourceStates: [], reasons: [], analyzer: "DETERMINISTIC_FILTER" },
      policy: { status: "PREVIEW_ONLY", policy: { targetPostHealthFactorWad: "1075000000000000000" }, reason: "Preview only" },
      marketContext: { position, liquidity, plan },
      executionPreview: { status: "PREVIEW_ONLY", plan, policyEvaluation: { allowed: true }, broadcastPermitted: false, transactionSubmitted: false, reason: "Preview only" },
      freshness: { maxBlockAgeSeconds: 120, maxSourceAgeSeconds: 86400, allRequiredFresh: true },
      adapters: [],
      adapterVersions: {},
      snapshotHash: `0x${"cd".repeat(32)}`,
    } as never,
  };
}
