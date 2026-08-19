const BPS = 10_000n;
const WAD = 10n ** 18n;
const Q192 = 2n ** 192n;

export function percentMul(value: bigint, percentageBps: bigint): bigint {
  return (value * percentageBps + BPS / 2n) / BPS;
}

/**
 * Computes a percentage ceiling. Protocol fee calculations use this because
 * Aave may charge the indivisible-wei remainder upward.
 */
export function percentMulUp(value: bigint, percentageBps: bigint): bigint {
  return (value * percentageBps + BPS - 1n) / BPS;
}

export function mulDiv(value: bigint, multiplier: bigint, denominator: bigint): bigint {
  if (denominator === 0n) throw new Error("division by zero");
  return (value * multiplier) / denominator;
}

export function minimumSwapOut(expectedOutput: bigint, slippageBps: bigint): bigint {
  if (slippageBps > BPS) throw new Error("slippage exceeds 10,000 bps");
  return (expectedOutput * (BPS - slippageBps)) / BPS;
}

export function maximumRepayCoveredBySwap(
  minimumOutput: bigint,
  maximumPremiumBps: bigint,
): bigint {
  let repay = (minimumOutput * BPS) / (BPS + maximumPremiumBps);
  while (repay > 0n && repay + percentMulUp(repay, maximumPremiumBps) > minimumOutput) {
    repay -= 1n;
  }
  return repay;
}

export function tokenValueBase(amountWei: bigint, oraclePrice: bigint): bigint {
  return mulDiv(amountWei, oraclePrice, WAD);
}

export function projectedHealthFactor(input: {
  totalCollateralBase: bigint;
  totalDebtBase: bigint;
  collateralRemovedWei: bigint;
  debtRepaidWei: bigint;
  collateralPriceBase: bigint;
  debtPriceBase: bigint;
  liquidationThresholdBps: bigint;
}): bigint {
  const collateralRemovedBase = tokenValueBase(
    input.collateralRemovedWei,
    input.collateralPriceBase,
  );
  const debtRepaidBase = tokenValueBase(input.debtRepaidWei, input.debtPriceBase);
  if (
    collateralRemovedBase > input.totalCollateralBase ||
    debtRepaidBase > input.totalDebtBase
  ) {
    return 0n;
  }
  const collateralAfter = input.totalCollateralBase - collateralRemovedBase;
  const debtAfter = input.totalDebtBase - debtRepaidBase;
  if (debtAfter === 0n) return 2n ** 256n - 1n;
  return mulDiv(
    collateralAfter * input.liquidationThresholdBps,
    WAD,
    debtAfter * BPS,
  );
}

export function sqrtPriceX96ToPriceWad(sqrtPriceX96: bigint): bigint {
  return mulDiv(sqrtPriceX96 * sqrtPriceX96, WAD, Q192);
}

export function executionPriceWad(amountIn: bigint, amountOut: bigint): bigint {
  return amountIn === 0n ? 0n : mulDiv(amountOut, WAD, amountIn);
}

export function downsideBps(reference: bigint, execution: bigint): number {
  if (reference === 0n || execution >= reference) return 0;
  const result = ((reference - execution) * BPS) / reference;
  return Number(result > BigInt(Number.MAX_SAFE_INTEGER) ? BigInt(Number.MAX_SAFE_INTEGER) : result);
}

export function differenceBps(actual: bigint, expected: bigint): number {
  if (expected === 0n) return actual === 0n ? 0 : 10_000;
  const difference = actual >= expected ? actual - expected : expected - actual;
  return Number((difference * BPS) / expected);
}

export function ratioWad(numerator: bigint, denominator: bigint): bigint {
  return denominator === 0n ? 0n : mulDiv(numerator, WAD, denominator);
}

export const MARKET_BPS = BPS;
export const MARKET_WAD = WAD;
