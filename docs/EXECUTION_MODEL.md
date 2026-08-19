# Egress execution model

## Trust boundaries

Egress separates four authorities:

- The AI interprets source revisions and emits structured evidence. It never selects transaction amounts or holds a key.
- The risk attestor signs the exact policy ID, risk event, verdict/evidence hashes, risk level and validity window.
- Deterministic software refreshes Aave and Uniswap state, calculates the bounded action and requires an exact contract simulation.
- The smart contract is the final authority. It enforces the user-signed policy independently of the AI, backend, attestor and keeper.

The user retains the Aave position and remaining collateral. Egress has no arbitrary-call function, no upgrade path and no method to send collateral to the keeper.

## Setup-time authorization

The user signs an EIP-712 `ProtectionPolicy` that binds:

- one Aave account/user and one keeper;
- one approved risk attestor;
- the immutable Aave Pool, oracle, xBETH, xETH, aXbETH, debt token, Uniswap factory/router/pool and fee through `protocolConfigHash`;
- HIGH or CRITICAL minimum risk;
- per-execution and cumulative repayment/collateral budgets;
- a collateral percentage budget relative to enrollment collateral;
- a current-position debt ceiling;
- slippage, oracle-deviation and flash-premium ceilings;
- pre-action trigger and post-action health-factor limits;
- expiry, cooldown, maximum execution count, risk TTL, policy nonce and revocation epoch.

The user also signs one aXbETH EIP-2612 permit for the cumulative collateral budget. A relayer can register both signatures. Registration snapshots enrollment collateral/debt and stores policy counters by the EIP-712 policy digest.

This setup permit creates a token allowance to the immutable Egress contract. Revoking the policy prevents Egress from using it, but the ERC-20 allowance remains until consumed, expired through a new permit, or reset by the user. The UI must disclose this and offer an allowance-reset transaction.

## Autonomous sequence

1. OKX source revisions are ingested and diffed.
2. The AI produces structured claims and an evidence-backed HIGH/CRITICAL verdict.
3. The independent attestor signs the policy-bound verdict metadata.
4. The keeper re-reads policy state, revocation, cooldown, execution count, allowance and risk-event replay state.
5. The keeper refreshes the Aave position, Aave oracle prices and Uniswap quote at one block.
6. Deterministic code calculates repayment, collateral, minimum output and target health factor.
7. The exact autonomous call must simulate successfully.
8. For the Phase 5 fork only, the keeper broadcasts without a new user signature.
9. Solidity rechecks policy hash/state, keeper, attestor, risk level/freshness, nonce, cooldown, limits, allowance, current debt and pre-action health factor.
10. Solidity anchors minimum output to both the submitted quote and the immutable Aave oracle ratio.
11. Aave flash-loans xETH.
12. Egress repays variable xETH debt, pulls only the bounded aXbETH amount, withdraws xBETH and swaps through the immutable 1 bp pool.
13. Egress requires the actual post-action health factor to meet the policy floor, repays the flash loan and returns surplus xETH to the user.
14. Any failed check reverts the complete transaction and all policy counters atomically.

## Replay protection

- The policy nonce can be registered once.
- The user revocation epoch invalidates all older policies and manual authorizations.
- Each policy has an execution counter and maximum execution count.
- The keeper must submit the exact next execution nonce.
- Each risk-event hash can be consumed once per policy.
- Cooldown and expiry are enforced onchain.
- Counters and risk-event use roll back if the flash-loan transaction reverts.

## What Egress can do

- Reduce the authorized user's variable xETH debt within signed per-action and cumulative limits.
- Sell bounded aXbETH/xBETH collateral through the immutable pool.
- Execute after a policy-bound HIGH/CRITICAL attestation without another user signature.
- Return swap surplus to the user.

## What Egress cannot do

- Take custody of remaining collateral or send it to the keeper.
- Increase policy limits, change the keeper/attestor, or mutate approved protocol addresses.
- Borrow or sell an arbitrary asset.
- Call an arbitrary contract.
- Execute above the pre-action health-factor trigger or below the post-action health-factor floor.
- Bypass expiry, cooldown, revocation, execution count or risk-event replay protection.
- Guarantee backing, redemption, solvency or avoidance of liquidation.

The Phase 4 exact-authorization path remains available as a manual fallback. It still requires a fresh user signature and exact permit for each action.
