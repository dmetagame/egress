# Scenario B - Larger position

> **FORK SIMULATION** - This is a deterministic X Layer mainnet fork result, not a live user transaction.

- Chain ID: `196`
- Fork block: `67881241`
- Egress executor (ephemeral fork deployment): `0x5615dEB798BB3E4dFa0139dFa1b3D433Cc23b72f`

## Position before

- Collateral: `344.000000 xBETH`
- Debt: `300.000000 xETH`
- Health factor: `1.045177`
- xBETH oracle price: `$1908.9408`
- xETH oracle price: `$1884.8734`
- Pool balances: `56.931890 xBETH / 373.206278 xETH`
- Active V3 liquidity: `15594426199185294931217`

## Execution

- Flash loan / debt repaid: `58.800000 xETH`
- Collateral withdrawn and sold: `58.500000 xBETH`
- Quoted swap output: `59.003695 xETH`
- Actual swap output: `59.003695 xETH`
- Swap price: `1.008610 xETH/xBETH`
- Price impact versus current pool spot: `0.38%`
- Realized slippage versus quote: `0.00%`
- Uniswap fee: `0.005850 xBETH`
- Flash-loan premium: `0.029400 xETH`
- Surplus returned to user: `0.174295 xETH`
- Gas used: `868556`

## Position after

- Collateral: `285.500000 xBETH`
- Debt: `241.200000 xETH`
- Health factor: `1.078900`

## Economics

- Estimated gas cost: `$0.0017` at pinned-block base fee and OKB oracle price
- Flash premium: `$55.4152`
- Uniswap fee: `$11.1673` (informational; already included in swap execution loss)
- Swap execution loss versus pre-swap spot, including LP fee and curve impact: `$430.9292`
- Total measured execution cost: `$486.3462`
- Estimated 2.00% e-mode liquidation penalty on the repaid debt value: `$2216.6112`
- Estimated net economic benefit: `$1730.2649`

The liquidation comparison is an estimate, not a guarantee: it applies the pinned e-mode liquidation bonus to the repaid debt value and excludes market movement, liquidation close-factor behavior, oracle/DEX divergence, and external redemption costs. The Uniswap fee is shown separately for transparency but is not added twice to total execution cost.
