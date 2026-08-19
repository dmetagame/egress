import { encodeAbiParameters, keccak256, type Address, type Hex } from "viem";
import type { ArchivedLiveSnapshot } from "../live/archive-schemas.js";
import type { ExecutionProtocolIdentity } from "./schemas.js";

export function executionProtocolConfigHash(protocol: ExecutionProtocolIdentity): Hex {
  return keccak256(encodeAbiParameters(
    [
      { type: "address" },
      { type: "address" },
      { type: "address" },
      { type: "address" },
      { type: "address" },
      { type: "address" },
      { type: "address" },
      { type: "address" },
      { type: "address" },
      { type: "address" },
      { type: "uint24" },
    ],
    [
      protocol.aavePool as Address,
      protocol.addressesProvider as Address,
      protocol.aaveOracle as Address,
      protocol.xeth as Address,
      protocol.xbEth as Address,
      protocol.aXbEth as Address,
      protocol.variableDebtXeth as Address,
      protocol.uniswapFactory as Address,
      protocol.swapRouter as Address,
      protocol.swapPool as Address,
      protocol.poolFee,
    ],
  ));
}

export function snapshotMatchesProtocol(
  snapshot: ArchivedLiveSnapshot,
  protocol: ExecutionProtocolIdentity,
): string[] {
  const reasons: string[] = [];
  const position = snapshot.position;
  const oracle = snapshot.oracle;
  const liquidity = snapshot.liquidity;
  const envelopeSnapshot = snapshot.envelope.snapshot;
  if (!position || !oracle || !liquidity || !envelopeSnapshot) {
    return ["Snapshot does not contain complete protocol state."];
  }
  const addressChecks: Array<[string, string, string]> = [
    ["xBETH collateral", position.collateralToken, protocol.xbEth],
    ["xETH debt", position.debtToken, protocol.xeth],
    ["Aave aToken", position.aToken, protocol.aXbEth],
    ["Aave variable debt token", position.variableDebtToken, protocol.variableDebtXeth],
    ["oracle", oracle.xbEth.oracle, protocol.aaveOracle],
    ["xBETH oracle asset", oracle.xbEth.asset, protocol.xbEth],
    ["xETH oracle asset", oracle.xeth.asset, protocol.xeth],
    ["Uniswap pool", liquidity.pool, protocol.swapPool],
    ["Uniswap token in", liquidity.tokenIn, protocol.xbEth],
    ["Uniswap token out", liquidity.tokenOut, protocol.xeth],
    ["Uniswap fee", String(liquidity.feeTier), String(protocol.poolFee)],
    ["snapshot reserve", envelopeSnapshot.aave.collateralReserve.asset, protocol.xbEth],
    ["snapshot debt reserve", envelopeSnapshot.aave.debtReserve.asset, protocol.xeth],
    ["snapshot pool", envelopeSnapshot.uniswap.pool, protocol.swapPool],
    ["snapshot pool token0", envelopeSnapshot.uniswap.token0, protocol.xbEth],
    ["snapshot pool token1", envelopeSnapshot.uniswap.token1, protocol.xeth],
    ["snapshot pool fee", String(envelopeSnapshot.uniswap.feeTier), String(protocol.poolFee)],
    ["snapshot factory", envelopeSnapshot.uniswap.factory, protocol.uniswapFactory],
  ];
  for (const [label, actual, expected] of addressChecks) {
    if (actual.toLowerCase() !== expected.toLowerCase()) {
      reasons.push(`${label} mismatch: expected ${expected}, received ${actual}.`);
    }
  }
  if (!envelopeSnapshot.aave.addressesProviderVerified || !envelopeSnapshot.aave.oracleAddressVerified) {
    reasons.push("Snapshot Aave configuration was not verified.");
  }
  if (!envelopeSnapshot.uniswap.configurationVerified) {
    reasons.push("Snapshot Uniswap configuration was not verified.");
  }
  return reasons;
}
