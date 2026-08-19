# Scenario A - Moderate position

> **FORK SIMULATION** - This is a deterministic X Layer mainnet fork result, not a live user transaction.

- Chain ID: `196`
- Fork block: `67881241`
- Egress executor (ephemeral fork deployment): `0x5615dEB798BB3E4dFa0139dFa1b3D433Cc23b72f`

## Position before

- Collateral: `50.000000 xBETH`
- Debt: `44.050000 xETH`
- Health factor: `1.034610`
- xBETH oracle price: `$1908.9408`
- xETH oracle price: `$1884.8734`
- Pool balances: `56.931890 xBETH / 373.206278 xETH`
- Active V3 liquidity: `15594426199185294931217`

## Execution

- Flash loan / debt repaid: `11.100000 xETH`
- Collateral withdrawn and sold: `11.000000 xBETH`
- Quoted swap output: `11.128689 xETH`
- Actual swap output: `11.128689 xETH`
- Swap price: `1.011699 xETH/xBETH`
- Price impact versus current pool spot: `0.08%`
- Realized slippage versus quote: `0.00%`
- Uniswap fee: `0.001100 xBETH`
- Flash-loan premium: `0.005550 xETH`
- Surplus returned to user: `0.023139 xETH`
- Gas used: `868312`

## Position after

- Collateral: `39.000000 xBETH`
- Debt: `32.950000 xETH`
- Health factor: `1.078852`

## Economics

- Estimated gas cost: `$0.0017` at pinned-block base fee and OKB oracle price
- Flash premium: `$10.4610`
- Uniswap fee: `$2.0998` (informational; already included in swap execution loss)
- Swap execution loss versus pre-swap spot, including LP fee and curve impact: `$16.9863`
- Total measured execution cost: `$27.4491`
- Estimated 2.00% e-mode liquidation penalty on the repaid debt value: `$418.4419`
- Estimated net economic benefit: `$390.9927`

The liquidation comparison is an estimate, not a guarantee: it applies the pinned e-mode liquidation bonus to the repaid debt value and excludes market movement, liquidation close-factor behavior, oracle/DEX divergence, and external redemption costs. The Uniswap fee is shown separately for transparency but is not added twice to total execution cost.
