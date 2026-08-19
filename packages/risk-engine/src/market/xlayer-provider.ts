import {
  createPublicClient,
  defineChain,
  http,
  type Address,
  type PublicClient,
} from "viem";
import type {
  ExecutionPlan,
  LiquidityQuote,
  MarketContext,
  PositionState,
  UserProtectionPolicy,
} from "../domain/schemas.js";
import {
  aaveOracleAbi,
  aavePoolAbi,
  erc20Abi,
  quoterV2Abi,
  uniswapPoolAbi,
} from "./abis.js";
import { XLAYER_MAINNET, type XLayerProtocolConfig } from "./config.js";
import {
  differenceBps,
  downsideBps,
  executionPriceWad,
  maximumRepayCoveredBySwap,
  minimumSwapOut,
  percentMulUp,
  projectedHealthFactor,
  ratioWad,
  sqrtPriceX96ToPriceWad,
  tokenValueBase,
} from "./math.js";
import type { MarketContextProvider } from "./provider.js";

interface RawQuote {
  amountOut: bigint;
  sqrtPriceX96After: bigint;
  gasEstimate: bigint;
}

const DEFAULT_EXECUTOR_OVERHEAD_GAS = 700_000n;

export class XLayerMarketContextProvider implements MarketContextProvider {
  private readonly client: PublicClient;

  constructor(
    private readonly config: XLayerProtocolConfig = XLAYER_MAINNET,
    options: {
      rpcUrl?: string;
      client?: PublicClient;
      now?: () => Date;
      isolationToleranceBps?: number;
      plannerIterations?: number;
      executionOverheadGas?: bigint;
    } = {},
  ) {
    const chain = defineChain({
      id: config.chainId,
      name: config.chainId === XLAYER_MAINNET.chainId ? "X Layer" : `Egress execution chain ${config.chainId}`,
      nativeCurrency: { name: "Native", symbol: "NATIVE", decimals: 18 },
      rpcUrls: { default: { http: [options.rpcUrl ?? config.rpcUrl] } },
      blockExplorers: {
        default: { name: "Explorer", url: config.explorerUrl },
      },
    });
    this.client =
      options.client ??
      createPublicClient({ chain, transport: http(options.rpcUrl ?? config.rpcUrl) });
    this.now = options.now ?? (() => new Date());
    this.isolationToleranceBps = options.isolationToleranceBps ?? 100;
    this.plannerIterations = options.plannerIterations ?? 64;
    this.executionOverheadGas = options.executionOverheadGas ?? DEFAULT_EXECUTOR_OVERHEAD_GAS;
  }

  private readonly now: () => Date;
  private readonly isolationToleranceBps: number;
  private readonly plannerIterations: number;
  private readonly executionOverheadGas: bigint;

  async getContext(user: Address, policy: UserProtectionPolicy): Promise<MarketContext> {
    const blockNumber = await this.client.getBlockNumber();
    return this.getContextAtBlock(user, policy, blockNumber);
  }

  /**
   * Reads every market value at a caller-supplied block. Live snapshots use
   * this method so the position, oracle and quote share one chain boundary.
   */
  async getContextAtBlock(
    user: Address,
    policy: UserProtectionPolicy,
    blockNumber: bigint,
  ): Promise<MarketContext> {
    const position = await this.getPositionAtBlock(user, blockNumber);
    const { liquidity, plan } = await this.getLiquidityAndPlanAtBlock(
      position,
      policy,
      blockNumber,
    );
    return { position, liquidity, plan };
  }

  async getPositionAtBlock(user: Address, blockNumber: bigint): Promise<PositionState> {
    const contracts = this.config.contracts;
    const [account, collateralBalance, debtBalance, xbEthPrice, xethPrice] =
      await Promise.all([
        this.client.readContract({
          address: contracts.aavePool,
          abi: aavePoolAbi,
          functionName: "getUserAccountData",
          args: [user],
          blockNumber,
        }),
        this.client.readContract({
          address: contracts.aXbEth,
          abi: erc20Abi,
          functionName: "balanceOf",
          args: [user],
          blockNumber,
        }),
        this.client.readContract({
          address: contracts.variableDebtXeth,
          abi: erc20Abi,
          functionName: "balanceOf",
          args: [user],
          blockNumber,
        }),
        this.client.readContract({
          address: contracts.aaveOracle,
          abi: aaveOracleAbi,
          functionName: "getAssetPrice",
          args: [contracts.xbEth],
          blockNumber,
        }),
        this.client.readContract({
          address: contracts.aaveOracle,
          abi: aaveOracleAbi,
          functionName: "getAssetPrice",
          args: [contracts.xeth],
          blockNumber,
        }),
      ]);

    const [
      totalCollateralBase,
      totalDebtBase,
      availableBorrowsBase,
      currentLiquidationThreshold,
      ltv,
      healthFactor,
    ] = account;
    const expectedCollateralBase = tokenValueBase(collateralBalance, xbEthPrice);
    const expectedDebtBase = tokenValueBase(debtBalance, xethPrice);
    const collateralDifference = differenceBps(totalCollateralBase, expectedCollateralBase);
    const debtDifference = differenceBps(totalDebtBase, expectedDebtBase);
    const singleMarketPosition =
      collateralDifference <= this.isolationToleranceBps &&
      debtDifference <= this.isolationToleranceBps;

    return {
      chainId: this.config.chainId,
      blockNumber: blockNumber.toString(),
      observedAt: this.now().toISOString(),
      user,
      collateralToken: contracts.xbEth,
      debtToken: contracts.xeth,
      aToken: contracts.aXbEth,
      variableDebtToken: contracts.variableDebtXeth,
      collateralBalanceWei: collateralBalance.toString(),
      debtBalanceWei: debtBalance.toString(),
      totalCollateralBase: totalCollateralBase.toString(),
      totalDebtBase: totalDebtBase.toString(),
      availableBorrowsBase: availableBorrowsBase.toString(),
      liquidationThresholdBps: Number(currentLiquidationThreshold),
      ltvBps: Number(ltv),
      healthFactorWad: healthFactor.toString(),
      xbEthPriceBase: xbEthPrice.toString(),
      xethPriceBase: xethPrice.toString(),
      singleMarketPosition,
      positionScopeReason: singleMarketPosition
        ? "Aave account totals match the configured xBETH collateral and xETH variable debt within tolerance."
        : `Unsupported additional exposure detected (collateral difference ${collateralDifference} bps, debt difference ${debtDifference} bps).`,
      dataFresh: true,
    };
  }

  async getLiquidityAndPlanAtBlock(
    position: PositionState,
    policy: UserProtectionPolicy,
    blockNumber: bigint,
  ): Promise<{ liquidity: LiquidityQuote; plan: ExecutionPlan }> {
    return this.findPlan(position, policy, blockNumber);
  }

  private async findPlan(
    position: PositionState,
    policy: UserProtectionPolicy,
    blockNumber: bigint,
  ): Promise<{ liquidity: LiquidityQuote; plan: ExecutionPlan }> {
    const collateralBalance = BigInt(position.collateralBalanceWei);
    const debtBalance = BigInt(position.debtBalanceWei);
    const percentageCap =
      (collateralBalance * BigInt(policy.maximumCollateralPercentageBps)) / 10_000n;
    const upperBound = minBigInt(
      collateralBalance,
      BigInt(policy.maximumCollateralWei),
      percentageCap,
    );

    if (upperBound === 0n || debtBalance === 0n) {
      const liquidity = await this.quoteLiquidity(
        0n,
        blockNumber,
        position,
        "No deleveraging capacity or debt.",
      );
      return {
        liquidity,
        plan: failedPlan("No deleveraging capacity or xETH debt is available."),
      };
    }

    const upperQuote = await this.quoteLiquidity(upperBound, blockNumber, position);
    const upperPlan = this.planFromQuote(position, policy, upperQuote);
    if (
      !upperPlan.executable ||
      BigInt(upperPlan.projectedPostHealthFactorWad) < BigInt(policy.targetPostHealthFactorWad)
    ) {
      return {
        liquidity: upperQuote,
        plan: {
          ...upperPlan,
          executable: false,
          failureReason:
            upperPlan.failureReason ??
            "Policy caps and current liquidity cannot reach the target health factor.",
        },
      };
    }

    let low = 1n;
    let high = upperBound;
    let selectedQuote = upperQuote;
    let selectedPlan = upperPlan;
    let iteration = 0;
    while (low < high && iteration < this.plannerIterations) {
      const midpoint = (low + high) / 2n;
      const quote = await this.quoteLiquidity(midpoint, blockNumber, position);
      const plan = this.planFromQuote(position, policy, quote);
      if (
        plan.executable &&
        BigInt(plan.projectedPostHealthFactorWad) >= BigInt(policy.targetPostHealthFactorWad)
      ) {
        high = midpoint;
        selectedQuote = quote;
        selectedPlan = plan;
      } else {
        low = midpoint + 1n;
      }
      iteration += 1;
    }

    if (low < high) {
      return {
        liquidity: selectedQuote,
        plan: {
          ...selectedPlan,
          executable: false,
          failureReason: "Safe deleveraging planner did not converge within its bounded iteration budget.",
        },
      };
    }

    if (low !== BigInt(selectedQuote.amountInWei)) {
      selectedQuote = await this.quoteLiquidity(low, blockNumber, position);
      selectedPlan = this.planFromQuote(position, policy, selectedQuote);
    }
    return { liquidity: selectedQuote, plan: selectedPlan };
  }

  private planFromQuote(
    position: PositionState,
    policy: UserProtectionPolicy,
    quote: LiquidityQuote,
  ): ExecutionPlan {
    if (!quote.executable) return failedPlan(quote.failureReason ?? "Swap quote failed.");
    const amountIn = BigInt(quote.amountInWei);
    const expectedOut = BigInt(quote.expectedAmountOutWei);
    const minOut = minimumSwapOut(expectedOut, BigInt(policy.maximumSlippageBps));
    const repay = minBigInt(
      BigInt(position.debtBalanceWei),
      BigInt(policy.maximumRepaymentWei),
      maximumRepayCoveredBySwap(minOut, BigInt(policy.maximumFlashLoanPremiumBps)),
    );
    if (repay === 0n) return failedPlan("The quote cannot safely cover a non-zero repayment.");

    const projected = projectedHealthFactor({
      totalCollateralBase: BigInt(position.totalCollateralBase),
      totalDebtBase: BigInt(position.totalDebtBase),
      collateralRemovedWei: amountIn,
      debtRepaidWei: repay,
      collateralPriceBase: BigInt(position.xbEthPriceBase),
      debtPriceBase: BigInt(position.xethPriceBase),
      liquidationThresholdBps: BigInt(position.liquidationThresholdBps),
    });

    return {
      repayAmountWei: repay.toString(),
      collateralAmountWei: amountIn.toString(),
      expectedSwapOutWei: expectedOut.toString(),
      minimumSwapOutWei: minOut.toString(),
      projectedPostHealthFactorWad: projected.toString(),
      flashLoanPremiumCeilingWei: percentMulUp(
        repay,
        BigInt(policy.maximumFlashLoanPremiumBps),
      ).toString(),
      executable: projected > 0n,
      failureReason: projected > 0n ? null : "Projected position state is invalid.",
    };
  }

  private async quoteLiquidity(
    amountIn: bigint,
    blockNumber: bigint,
    position: PositionState,
    forcedFailureReason?: string,
  ): Promise<LiquidityQuote> {
    const contracts = this.config.contracts;
    const observedAt = this.now().toISOString();
    const [slot0, activeLiquidity, poolTokenInBalance, poolTokenOutBalance, gasPrice] =
      await Promise.all([
        this.client.readContract({
          address: contracts.swapPool,
          abi: uniswapPoolAbi,
          functionName: "slot0",
          blockNumber,
        }),
        this.client.readContract({
          address: contracts.swapPool,
          abi: uniswapPoolAbi,
          functionName: "liquidity",
          blockNumber,
        }),
        this.client.readContract({
          address: contracts.xbEth,
          abi: erc20Abi,
          functionName: "balanceOf",
          args: [contracts.swapPool],
          blockNumber,
        }),
        this.client.readContract({
          address: contracts.xeth,
          abi: erc20Abi,
          functionName: "balanceOf",
          args: [contracts.swapPool],
          blockNumber,
        }),
        this.client.getGasPrice(),
      ]);
    const [sqrtPriceX96] = slot0;
    const spotPrice = sqrtPriceX96ToPriceWad(sqrtPriceX96);
    const oracleReferencePrice = ratioWad(
      BigInt(position.xbEthPriceBase),
      BigInt(position.xethPriceBase),
    );
    const oraclePoolDeviationBps = differenceBps(spotPrice, oracleReferencePrice);

    let raw: RawQuote | null = null;
    let failureReason = forcedFailureReason ?? null;
    if (amountIn > 0n && !forcedFailureReason) {
      try {
        const simulation = await this.client.simulateContract({
          address: contracts.quoterV2,
          abi: quoterV2Abi,
          functionName: "quoteExactInputSingle",
          args: [
            {
              tokenIn: contracts.xbEth,
              tokenOut: contracts.xeth,
              amountIn,
              fee: this.config.poolFee,
              sqrtPriceLimitX96: 0n,
            },
          ],
          blockNumber,
        });
        const [amountOut, sqrtPriceX96After, , gasEstimate] = simulation.result;
        raw = { amountOut, sqrtPriceX96After, gasEstimate };
      } catch (error) {
        failureReason = `Uniswap quote failed: ${errorMessage(error)}`;
      }
    }

    const expectedOutput = raw?.amountOut ?? 0n;
    const executionPrice = executionPriceWad(amountIn, expectedOutput);
    const priceImpactBps = downsideBps(spotPrice, executionPrice);
    const estimatedExecutionGas =
      (raw?.gasEstimate ?? 0n) + (amountIn > 0n ? this.executionOverheadGas : 0n);
    return {
      chainId: this.config.chainId,
      blockNumber: blockNumber.toString(),
      observedAt,
      pool: contracts.swapPool,
      tokenIn: contracts.xbEth,
      tokenOut: contracts.xeth,
      feeTier: this.config.poolFee,
      amountInWei: amountIn.toString(),
      expectedAmountOutWei: expectedOutput.toString(),
      oracleReferencePriceWad: oracleReferencePrice.toString(),
      spotPriceWad: spotPrice.toString(),
      executionPriceWad: executionPrice.toString(),
      oraclePoolDeviationBps,
      priceImpactBps,
      estimatedSlippageBps: priceImpactBps,
      activeLiquidity: activeLiquidity.toString(),
      poolTokenInBalanceWei: poolTokenInBalance.toString(),
      poolTokenOutBalanceWei: poolTokenOutBalance.toString(),
      quoteGasEstimate: (raw?.gasEstimate ?? 0n).toString(),
      estimatedExecutionGas: estimatedExecutionGas.toString(),
      gasPriceWei: gasPrice.toString(),
      estimatedExecutionCostWei: (estimatedExecutionGas * gasPrice).toString(),
      executable: raw !== null && expectedOutput > 0n,
      failureReason,
    };
  }
}

function minBigInt(...values: bigint[]): bigint {
  return values.reduce((minimum, value) => (value < minimum ? value : minimum));
}

function failedPlan(reason: string): ExecutionPlan {
  return {
    repayAmountWei: "0",
    collateralAmountWei: "0",
    expectedSwapOutWei: "0",
    minimumSwapOutWei: "0",
    projectedPostHealthFactorWad: "0",
    flashLoanPremiumCeilingWei: "0",
    executable: false,
    failureReason: reason,
  };
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message.split("\n")[0] ?? error.name : String(error);
}
