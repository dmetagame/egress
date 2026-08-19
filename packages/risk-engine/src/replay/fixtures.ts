import type {
  MarketContext,
  SourceDefinition,
  UserProtectionPolicy,
} from "../domain/schemas.js";

export const REPLAY_SOURCE: SourceDefinition = {
  id: "okx-x-rwa-deposit-withdrawal",
  url: "https://www.okx.com/help/how-does-xasset-work",
  authority: "OKX",
  assetScope: ["X_RWA", "XBETH"],
  enabled: true,
};

function html(body: string): string {
  return `<!doctype html><html><head><title>How do I deposit and withdraw X-RWA?</title><meta name="description" content="Authoritative X-RWA deposit and withdrawal information"></head><body><article><h1>How do I deposit and withdraw X-RWA?</h1>${body}</article></body></html>`;
}

export const REPLAY_REVISIONS = {
  A: html(`
    <h2>What is X-RWA?</h2>
    <p>Each X-RWA, including xBETH, is fully backed by its corresponding underlying asset securely held in OKX custody.</p>
    <h2>Deposit and withdrawal</h2>
    <p>When eligible X-RWA is deposited to an OKX Exchange account, OKX burns the deposited token and credits the corresponding underlying eligible asset.</p>
    <p>Eligible withdrawals are processed under normal operating conditions.</p>
  `),
  B: html(`
    <h2>What is X-RWA?</h2>
    <p>Each X-RWA, including xBETH, is fully backed by its corresponding underlying asset securely held in OKX custody.</p>
    <h2>Deposit and withdrawal</h2>
    <p>When eligible X-RWA is deposited to an OKX Exchange account, OKX burns the deposited token and credits the corresponding underlying eligible asset.</p>
    <p>Eligible withdrawals are processed under normal operating conditions.</p>
    <p>A scheduled maintenance window may create a temporary processing delay of up to two hours.</p>
  `),
  C: html(`
    <h2>What is X-RWA?</h2>
    <p>Each X-RWA, including xBETH, is fully backed by its corresponding underlying asset securely held in OKX custody.</p>
    <h2>Deposit and withdrawal</h2>
    <p>When eligible X-RWA is deposited to an OKX Exchange account, conversion to the corresponding underlying asset is subject to reserve availability.</p>
    <p>Redemptions may be suspended and withdrawal processing may face a material delay during stressed market conditions.</p>
  `),
} as const;

const USER = "0x1111111111111111111111111111111111111111";
const EXECUTOR = "0x2222222222222222222222222222222222222222";
const EGRESS = "0x3333333333333333333333333333333333333333";
const ATTESTOR = "0x19E7E376E7C213B7E7e7e46cc70A5dD086DAff2A";

export function replayPolicy(now = new Date("2026-08-14T10:00:00.000Z")): UserProtectionPolicy {
  return {
    policyId: "policy_demo_xbeth_v1",
    policyVersion: 1,
    user: USER,
    executor: EXECUTOR,
    chainId: 196,
    egressContract: EGRESS,
    approvedRiskAttestor: ATTESTOR,
    riskTrigger: "HIGH",
    minimumConfidence: 0.8,
    triggerHealthFactorWad: "1120000000000000000",
    minimumPostHealthFactorWad: "1150000000000000000",
    targetPostHealthFactorWad: "1200000000000000000",
    maximumRepaymentWei: "10000000000000000000",
    maximumCollateralWei: "11000000000000000000",
    maximumCollateralPercentageBps: 2500,
    maximumSlippageBps: 100,
    maximumPriceImpactBps: 100,
    maximumOraclePoolDeviationBps: 200,
    maximumFlashLoanPremiumBps: 5,
    cooldownSeconds: 3600,
    authorizationExpiresAt: new Date(now.getTime() + 86_400_000).toISOString(),
    intentTtlSeconds: 120,
    verdictMaxAgeSeconds: 300,
    marketMaxAgeSeconds: 30,
    maximumClockSkewSeconds: 15,
    automaticExecutionEnabled: true,
    approvedSourceIds: [REPLAY_SOURCE.id],
  };
}

export function replayMarketContext(
  now = new Date("2026-08-14T10:00:00.000Z"),
): MarketContext {
  return {
    position: {
      chainId: 196,
      blockNumber: "67881241",
      observedAt: now.toISOString(),
      user: USER,
      collateralToken: "0xAFeab3B85B6A56cF5F02317F0f7A23340eb983D7",
      debtToken: "0xE7B000003A45145decf8a28FC755aD5eC5EA025A",
      aToken: "0xe9e78053f1Ef084f8cD01dBE8ccE95c6b0944d32",
      variableDebtToken: "0xB756Fc7065369602f2cCb8356283E8b997fDfe2a",
      collateralBalanceWei: "50000000000000000000",
      debtBalanceWei: "44050000000000000000",
      totalCollateralBase: "150000000000",
      totalDebtBase: "132150000000",
      availableBorrowsBase: "0",
      liquidationThresholdBps: 9000,
      ltvBps: 8800,
      healthFactorWad: "1080000000000000000",
      xbEthPriceBase: "300000000000",
      xethPriceBase: "300000000000",
      singleMarketPosition: true,
      positionScopeReason: "Replay fixture contains only xBETH collateral and xETH debt.",
      dataFresh: true,
    },
    liquidity: {
      chainId: 196,
      blockNumber: "67881241",
      observedAt: now.toISOString(),
      pool: "0x84d4DbEebFf5F77c63F36bD0dCb18121Aa9aC8fc",
      tokenIn: "0xAFeab3B85B6A56cF5F02317F0f7A23340eb983D7",
      tokenOut: "0xE7B000003A45145decf8a28FC755aD5eC5EA025A",
      feeTier: 100,
      amountInWei: "8000000000000000000",
      expectedAmountOutWei: "8050000000000000000",
      oracleReferencePriceWad: "1000000000000000000",
      spotPriceWad: "1007000000000000000",
      executionPriceWad: "1006250000000000000",
      oraclePoolDeviationBps: 70,
      priceImpactBps: 8,
      estimatedSlippageBps: 8,
      activeLiquidity: "100000000000000000000000",
      poolTokenInBalanceWei: "500000000000000000000",
      poolTokenOutBalanceWei: "500000000000000000000",
      quoteGasEstimate: "180000",
      estimatedExecutionGas: "880000",
      gasPriceWei: "100000000",
      estimatedExecutionCostWei: "88000000000000",
      executable: true,
      failureReason: null,
    },
    plan: {
      repayAmountWei: "7900000000000000000",
      collateralAmountWei: "8000000000000000000",
      expectedSwapOutWei: "8050000000000000000",
      minimumSwapOutWei: "7969500000000000000",
      projectedPostHealthFactorWad: "1210000000000000000",
      flashLoanPremiumCeilingWei: "3950000000000000",
      executable: true,
      failureReason: null,
    },
  };
}

export const REPLAY_PRIVATE_KEY =
  "0x1111111111111111111111111111111111111111111111111111111111111111" as const;
