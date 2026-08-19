# Execution modes

Egress has an explicit runtime mode model. The backend and contract/coordinator checks are authoritative; a browser label is not a permission switch.

| Mode | Read state | May broadcast | Phase 7 status |
|---|---:|---:|---|
| `REPLAY` | Fixture/revision pipeline | No | Enabled |
| `LIVE_READ_ONLY` | Current X Layer and OKX data | No | Enabled |
| `FORK_WRITE` | Pinned X Layer fork | Yes, only after explicit local safeguards | Enabled for existing fork scripts/UI path |
| `TESTNET_WRITE` | Manifest-verified X Layer testnet deployment | Yes, only from the isolated worker | Phase 11 staging available; public receipt required for validation |
| `LIVE_MAINNET` | Production state | No | Permanently disabled |

Phase 9 also has a separate worker setting, `EGRESS_EXECUTION_ENVIRONMENT`, which accepts only
`DISABLED`, `FORK_WRITE`, and `TESTNET_WRITE`. `LIVE_MAINNET_WRITE` is explicitly rejected. The
worker setting never changes the observation runtime's `EGRESS_RUNTIME_MODE=LIVE_READ_ONLY`.

## Guards

`assertBroadcastAllowed` rejects `REPLAY` and `LIVE_READ_ONLY` before a write client can be used. It always rejects `LIVE_MAINNET`. Fork writes require a detected local fork and the expected chain ID. Testnet writes require an explicitly verified testnet deployment and matching chain ID. A mismatched chain or missing environment verification returns `EXECUTION_ENVIRONMENT_MISMATCH`.

The execution contract remains the final boundary. Its immutable Aave pool, approved assets and swap pool, policy/account binding, nonce, expiry, revocation epoch, cooldown, execution count, cumulative and per-action limits, health-factor floor, slippage/oracle checks, flash-loan repayment, pause behavior, and atomic rollback are unchanged by the live read-only layer.

## Fork writes

The checked-in fork artifact uses an Anvil endpoint at `http://127.0.0.1:8545`, reset to X Layer mainnet block `67,881,241`. The UI write controls require `NEXT_PUBLIC_EGRESS_ENABLE_FORK_WRITES=true` and then verify the connected chain, executor bytecode, protocol configuration hash, and protected account. The scripts perform the same explicit fork setup and are labelled `PINNED X LAYER FORK SIMULATION`.

Fork results are not live user funds and are not evidence of a production deployment.

## Testnet writes

X Layer testnet is chain `1952` at `https://testrpc.xlayer.tech/terigon`. The verified production addresses in [PROTOCOL_CONFIG.md](./PROTOCOL_CONFIG.md) do not have usable production bytecode there. A testnet write path therefore requires the separately deployed, clearly labelled compatibility stack and content-addressed manifest documented in [PHASE11.md](./PHASE11.md). Configuration alone is insufficient: the worker verifies runtime code hashes, contract relationships, token metadata, keeper identity, deployment provenance, and execution bounds before simulation or submission.

## Live mainnet policy

Phase 7 does not create or expose a live mainnet signer/broadcast path. `LIVE_MAINNET` is rejected in code even if a caller supplies a flag. Live data is useful for observation, risk context, and preview only. Enabling production unattended execution requires a separate reviewed phase, deployment, monitoring, and security approval.
