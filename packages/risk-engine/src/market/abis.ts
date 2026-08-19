import { parseAbi } from "viem";

export const aavePoolAbi = parseAbi([
  "function getUserAccountData(address user) view returns (uint256 totalCollateralBase,uint256 totalDebtBase,uint256 availableBorrowsBase,uint256 currentLiquidationThreshold,uint256 ltv,uint256 healthFactor)",
  "function getConfiguration(address asset) view returns (uint256 data)",
  "function FLASHLOAN_PREMIUM_TOTAL() view returns (uint128)",
]);

export const aaveAddressesProviderAbi = parseAbi([
  "function getPool() view returns (address)",
  "function getPriceOracle() view returns (address)",
]);

export const aaveOracleAbi = parseAbi([
  "function getAssetPrice(address asset) view returns (uint256)",
  "function getSourceOfAsset(address asset) view returns (address)",
]);

export const erc20Abi = parseAbi([
  "function balanceOf(address account) view returns (uint256)",
  "function allowance(address owner,address spender) view returns (uint256)",
  "function decimals() view returns (uint8)",
  "function symbol() view returns (string)",
  "function name() view returns (string)",
]);

export const aTokenPermitAuthorizationAbi = parseAbi([
  "function allowance(address owner,address spender) view returns (uint256)",
  "function nonces(address owner) view returns (uint256)",
  "function DOMAIN_SEPARATOR() view returns (bytes32)",
  "function PERMIT_TYPEHASH() view returns (bytes32)",
]);

export const egressExecutorStateAbi = parseAbi([
  "function revocationNonces(address user) view returns (uint256)",
  "function authorizationUsed(address user,uint256 nonce) view returns (bool)",
  "function paused() view returns (bool)",
]);

export const uniswapPoolAbi = parseAbi([
  "function slot0() view returns (uint160 sqrtPriceX96,int24 tick,uint16 observationIndex,uint16 observationCardinality,uint16 observationCardinalityNext,uint8 feeProtocol,bool unlocked)",
  "function liquidity() view returns (uint128)",
  "function factory() view returns (address)",
  "function token0() view returns (address)",
  "function token1() view returns (address)",
  "function fee() view returns (uint24)",
]);

export const uniswapFactoryAbi = parseAbi([
  "function getPool(address tokenA,address tokenB,uint24 fee) view returns (address)",
]);

export const oracleAggregatorAbi = parseAbi([
  "function latestRoundData() view returns (uint80 roundId,int256 answer,uint256 startedAt,uint256 updatedAt,uint80 answeredInRound)",
  "function latestAnswer() view returns (int256)",
  "function decimals() view returns (uint8)",
  "function description() view returns (string)",
]);

export const priceCapAdapterAbi = parseAbi([
  "function BASE_TO_USD_AGGREGATOR() view returns (address)",
  "function RATIO_PROVIDER() view returns (address)",
  "function getRatio() view returns (uint256)",
  "function getSnapshotRatio() view returns (uint256)",
  "function getSnapshotTimestamp() view returns (uint256)",
]);

export const quoterV2Abi = parseAbi([
  "function quoteExactInputSingle((address tokenIn,address tokenOut,uint256 amountIn,uint24 fee,uint160 sqrtPriceLimitX96) params) returns (uint256 amountOut,uint160 sqrtPriceX96After,uint32 initializedTicksCrossed,uint256 gasEstimate)",
]);
