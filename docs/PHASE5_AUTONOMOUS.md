# Egress Phase 5 autonomous circuit breaker

## Canonical loop

```text
OKX source revision
        |
        v
RiskEventRecord + evidence-backed verdict
        |
        v
EIP-712 risk attestation bound to policy/event/verdict/evidence
        |
        v
Fresh Aave position + Aave oracle + Uniswap liquidity
        |
        v
EgressShadowKeeper deterministic checks and execution calculation
        |
        v
WOULD_EXECUTE + exact simulation
        |
        v
EgressExecutor.executeAutonomous
        |
        v
Aave flash loan -> debt repayment -> aXbETH withdrawal -> Uniswap swap
        |
        v
Flash repayment + surplus return + improved health factor
```

## Policy schema

`ProtectionPolicy` is signed by the user and hashed by the EIP-712 domain of the deployed Egress contract. It binds the user, keeper, attestor, protocol configuration, minimum risk level, per-execution and cumulative budgets, collateral percentage, position debt ceiling, slippage/oracle/premium ceilings, health-factor trigger/floor, cooldown, execution count, risk freshness, expiry, nonce and revocation epoch.

The policy is registered once. The contract snapshots enrollment collateral/debt and creates policy counters. The user signs a cumulative aXbETH permit during setup. No permit is accepted by the autonomous execution function.

## Attestation schema

The attestor signs:

```text
policyId
riskEventId
verdictHash
evidenceHash
riskLevel (HIGH or CRITICAL)
issuedAt
expiresAt
```

The domain is `Egress Risk Attestor`, version `1`, the X Layer chain ID and the Egress contract address. Solidity rejects a wrong signer, policy, event, risk level, lifetime or stale/future-dated attestation.

## Keeper behavior

`EgressShadowKeeper` does not own user funds. It refreshes all deterministic state and returns a structured decision:

- `WOULD_EXECUTE`: every check passed and the exact autonomous calldata simulated successfully;
- `WOULD_NOT_EXECUTE`: any check failed, with named checks and reasons.

The default CLI is shadow-only. `phase5-fork.ts --execute` is an explicit local-fork exception used for the hackathon proof. `LIVE` events are rejected.

## Gas model

The MVP has no reimbursement contract, paymaster or keeper token. The keeper pays the transaction gas. This removes an additional fund-flow and accounting surface while correctness is being demonstrated. The Phase 5 fork execution used `964,117` gas at the pinned block and returned the swap surplus to the user.

## Verification

- TypeScript: `42` tests passed
- Solidity: `73` tests passed, including `32` autonomous security/fork tests
- Contract runtime size: `17,244` bytes, with `7,332` bytes of EIP-170 margin
- Replay: `NORMAL -> MEDIUM -> HIGH`, with only the HIGH revision eligible
- Production dependency audit: `0` known vulnerabilities

## Verified fork result

Report: `reports/phase5/autonomous-control-loop.json`

- Fork block: `67,881,241`
- Risk transition: `NORMAL -> MEDIUM -> HIGH`
- User signed policy and setup permit before replay
- Permit nonce: `1` after setup and `1` after execution
- Keeper decision: `WOULD_EXECUTE`
- Transaction: `0xc448b90dc7ebd190c44cef4e9f641062a23483689a4c4c2eb5d83b421d318ca5`
- Health factor: `1.0346104646 -> 1.0749999826`
- Debt repaid: `10.8152645887 xETH`
- Collateral sold: `10.8034435071 xBETH`
- Gas: `964,117`

All numbers above are pinned-fork simulation results, not live user funds.

## Failure and fallback strategy

- Source unavailable: produce no attestation and `WOULD_NOT_EXECUTE`.
- AI unavailable or unsupported evidence: retain the last observation for audit, but do not execute.
- Attestor unavailable: monitor only; a stale attestation cannot execute.
- RPC/market refresh unavailable: do not use cached execution amounts; simulate only after a fresh read.
- Quoter failure or insufficient liquidity: no execution; the flash loan makes partial execution impossible.
- Keeper unavailable: funds remain with the user; a fresh policy can authorize a replacement keeper.
- Contract simulation failure: do not broadcast.
- Revert after broadcast: Aave/Uniswap and policy counters roll back atomically; the keeper loses only gas.
- Policy revocation: contract state wins over backend state and rejects the request.
