# Egress Phase 4 control-loop report

> **PINNED X LAYER FORK SIMULATION** - This is a local transaction against real contracts and state forked from X Layer mainnet. It is not a live-mainnet transaction and does not involve real user funds.

- Fork block: `67881241`
- Egress executor: `0x2de080e97b0cae9825375d31f5d0ed5751fdf16d`
- Transaction: `0xf2d33b90354c43985d8e2a2087be8dd0b015df0fac878615400c5da2f261382e`
- Risk transition: `NORMAL -> MEDIUM -> HIGH`
- Final policy state: `READY_FOR_SUBMISSION`

## Position

- Before: 50 xBETH collateral, 44.050000000000000001 xETH debt, HF 1.034610466510276321
- After: 39.196557026162792102 xBETH collateral, 33.234736611423127126 xETH debt, HF 1.074999978433710209

## Execution

- Debt repaid: 10.815264055315765101 xETH
- Observed net debt reduction after the confirmation block: 10.815263388576872875 xETH (the difference is variable-debt interest accrued between observations)
- Collateral sold: 10.803442973837207898 xBETH
- Swap output: 10.929971401356992914 xETH
- Flash-loan premium: 0.005407632027657883 xETH
- Surplus returned: 0.10929971401356993 xETH
- Gas used: 909253
- Authorization nonce consumed: `4001`
- Remaining aXbETH allowance: `0`

The deterministic replay analyzer classified changed evidence. The deterministic policy engine then calculated and bounded the action from the live forked Aave position and Uniswap quote. The user separately signed the exact Egress authorization and exact aXbETH permit. The model/attestor never held a transaction key or arbitrary-call authority.
