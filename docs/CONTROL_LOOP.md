# Egress Phase 4 control loop

## Outcome

Phase 4 connects the evidence pipeline to the existing bounded Solidity executor without giving the model, risk attestor or keeper arbitrary fund authority.

```text
OKX source revision
        |
        v
structured evidence-backed verdict
        |
        v
signed risk attestation (provenance, not spending authority)
        |
        v
same-block Aave position + oracle + Uniswap quote
        |
        v
deterministic policy checks
        |
        v
exact bounded Egress authorization
        |
        v
user EIP-712 signature + exact aXbETH permit
        |
        v
current onchain state re-read + policy re-evaluation
        |
        v
mandatory EgressExecutor simulation
        |
        v
TEST/REPLAY-only fork transaction
        |
        v
validated Deleveraged event + canonical audit record
```

## Canonical system contract

`RiskEventRecord` is the canonical correlation object. It retains:

- risk-event, source-revision and diff identifiers;
- structured analysis, exact evidence and signed verdict attestation;
- the complete user policy and runtime authorization state;
- current position, liquidity quote and deterministic execution plan;
- the bounded execution intent and its object hash;
- transaction status, hash, block, gas and parsed `Deleveraged` event.

No free-form model field is converted into calldata. Only `intent.authorization`, generated from deterministic market math and policy caps, is converted to the fixed `EgressExecutor.execute` tuple.

## Final execution gate

Immediately before simulation, `EgressExecutionCoordinator` verifies:

1. Canonical IDs, user, chain and executor links still match.
2. Intent and user authorization have not expired.
3. RPC chain ID is X Layer and the configured signer is the policy-approved executor.
4. The user signed the exact EIP-712 authorization.
5. Current revocation epoch, nonce-use status and pause status remain valid.
6. Exact collateral allowance exists or the aXbETH permit digest recovers to the user.
7. Deterministic policy still produces the identical authorization.
8. `EgressExecutor.execute` simulates successfully.

Broadcast is simulation-only by default. It is allowed only when explicitly requested for a `TEST` or `REPLAY` event. `LIVE` is always rejected in Phase 4.

## Reproducible fork proof

Start Anvil:

```bash
anvil \
  --fork-url https://rpc.xlayer.tech \
  --fork-block-number 67881241 \
  --chain-id 196 \
  --port 8545 \
  --silent
```

Then run:

```bash
forge build
npm run phase4:fork
```

The script resets Anvil to the pinned block before each run, deploys an ephemeral `EgressExecutor`, creates a synthetic 50 xBETH / 44.05 xETH Aave position using real forked contracts, and runs revisions A/B/C.

- A: `NORMAL` and rejected.
- B: `MEDIUM` and rejected.
- C: `HIGH`, then requires the user's two exact signatures before execution.

The output is `reports/phase4/fork-control-loop.{json,md}`, labelled `PINNED X LAYER FORK SIMULATION`.

## Aave rounding

`Pool.repay` must return the exact flash-loan amount. Aave's ray-scaled variable-debt token can nevertheless report a balance delta one wei above or below that amount as its index is converted back to token units. The executor therefore permits only a one-wei debt-balance tolerance while retaining exact repayment-return, collateral-delta, slippage, premium and health-factor checks.

Position observations made in a later confirmation block also include newly accrued variable-debt interest. The report records both the exact Egress/Aave repayment and the later observed net debt reduction rather than conflating them.
