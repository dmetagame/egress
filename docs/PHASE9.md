# Phase 9: Isolated Execution Staging

Phase 9 adds a separately configured execution staging worker. It consumes an immutable archived snapshot hash, refreshes deterministic market state, rechecks the signed policy and risk evidence, simulates the typed Egress action, and records the result. Submission is available only for an explicitly identified fork or testnet environment.

## Boundary

The Phase 8C observation service remains read-only. It does not import the worker entrypoint, create a wallet client, read `EGRESS_EXECUTION_PRIVATE_KEY`, generate permits, create allowances, or submit transactions. The web application can display staging health, but it has no control that enables submission.

Phase 9 accepts only:

- `DISABLED` — default; no staging worker;
- `FORK_WRITE` — a local Anvil fork positively identified by X Layer chain ID, fork block number, and fork block hash;
- `TESTNET_WRITE` — X Layer testnet chain `1952` with an explicit address book and matching anchor block hash.

`LIVE_MAINNET_WRITE` is unsupported and rejected during configuration parsing. `LIVE_MAINNET_BROADCAST` remains disabled.

## Worker flow

```text
archived snapshot hash
        -> integrity and freshness validation
        -> positive environment identification
        -> deterministic market refresh
        -> risk, policy, authorization, and bounds checks
        -> typed AAVE_XBETH_XETH_DELEVERAGE intent
        -> exact contract simulation
        -> immutable simulation record
        -> optional fork/testnet submission
```

The worker receives one typed action: `AAVE_XBETH_XETH_DELEVERAGE`. The submitter receives the exact typed request returned by simulation and validates its Egress contract address and request hash before calling `executeAutonomous`. There is no arbitrary calldata or generic transaction endpoint.

## Evidence and replay safety

The worker checks the archived snapshot hash and integrity hash, uses the immutable observed block timestamp for snapshot age, requires `COMPLETE` and same-block evidence, binds the account, protocol address book, RWA verdict, source revisions/diffs, and policy evaluation, and rejects a replay-mode risk event.

The request timestamp, intent age, contract request hash, execution deadline, risk attestation, and policy signature are all checked. A final environment identity and deadline check occurs immediately before a submission reservation and again immediately before the submitter call.

Execution reservations are unique per immutable intent. Repeated attempts cannot create a second submission for the same intent. The execution worker has read-only access to the observation snapshot reader and cannot mutate canonical snapshots or OKX revision history.

## Configuration

Use `packages/risk-engine/.env.execution.example` for the isolated worker. The web example contains only non-secret staging metadata for operations health. Do not put `EGRESS_EXECUTION_PRIVATE_KEY` in the web or observation environment.

Required enabled-worker values include:

- `EGRESS_EXECUTION_ENVIRONMENT`;
- `EGRESS_EXECUTION_RPC_URL`;
- `EGRESS_EXECUTION_CHAIN_ID`;
- `EGRESS_EXECUTION_EGRESS_CONTRACT`;
- `EGRESS_EXECUTION_KEEPER_ADDRESS`;
- `EGRESS_EXECUTION_ANCHOR_BLOCK` and `EGRESS_EXECUTION_ANCHOR_BLOCK_HASH`;
- `EGRESS_DATABASE_URL`;
- the explicit protocol address book for `TESTNET_WRITE`.

Submission additionally requires `EGRESS_EXECUTION_SUBMISSION_ENABLED=true` and a worker-only `EGRESS_EXECUTION_PRIVATE_KEY` whose derived address equals `EGRESS_EXECUTION_KEEPER_ADDRESS`. This credential is never loaded by the observation runtime.

## Database

Migration `0003_phase9_execution_staging.sql` adds immutable JSONB payload tables for intents, simulations, submission reservations, submissions, and worker events. The migration is checksummed and validated with the existing Phase 8C migration runner. Direct parameterized SQL is used; no ORM was added.

## Current status

Fork execution remains dependent on the existing pinned X Layer fork infrastructure and RPC access. No live-mainnet transaction is submitted by Phase 9, and Phase 5 fork behavior remains a separate explicit demo path.
