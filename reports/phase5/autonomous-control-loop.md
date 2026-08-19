# Egress Phase 5 autonomous control-loop report

> **PINNED X LAYER FORK SIMULATION** - Real X Layer contracts and liquidity are used inside a local fork. This is not live-mainnet execution.

- Mode: `EXECUTED_FORK`
- Fork block: `67881241`
- Egress executor: `0x2de080e97b0cae9825375d31f5d0ed5751fdf16d`
- Policy: `0x31678480d8ae6478094b200d976ae73bae1ebedac64fa22699276563093d7cf1`
- Risk transition: `NORMAL -> MEDIUM -> HIGH`
- Keeper decision: `WOULD_EXECUTE`

## Authorization

The user signed the bounded policy and setup-time collateral permit before the source revisions were replayed. The keeper, AI, and attestor cannot mutate policy limits. Permit nonce after setup and after the risk event: `1` and `1`.

## Position

- Before: 50 xBETH, 44.050000081309619885 xETH, HF 1.034610464600521702
- After: 39.196556492948698657 xBETH, 33.2347360617354773 xETH, HF 1.074999981589751047

## Execution

- Transaction: `0xc448b90dc7ebd190c44cef4e9f641062a23483689a4c4c2eb5d83b421d318ca5`
- Debt repaid: 10.815264588741485975 xETH
- Collateral sold: 10.803443507051301343 xBETH
- Swap output: 10.929971940440259312 xETH
- Flash premium: 0.005407632294370743 xETH
- Surplus returned: 0.109299719404402594 xETH
- Gas: 964117
- Block: 67881249

The AI interprets the source revision. The deterministic keeper computes the action from fresh Aave and Uniswap state. The contract independently verifies the pre-authorized policy, attestation, oracle-relative output floor, cooldown, nonce, allowance, and health-factor floor.
