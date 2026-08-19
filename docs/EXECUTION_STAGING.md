# Execution Staging Operations

## Start

The staging worker consumes a JSON request containing a snapshot hash, risk event, signed onchain policy, policy signature, risk attestation, environment, and request timestamp:

```bash
npm run execution:stage -- --request ./request.json
```

The worker must run in a process environment separate from the observation poller and web service. Start with `EGRESS_EXECUTION_ENVIRONMENT=DISABLED` and `EGRESS_EXECUTION_SUBMISSION_ENABLED=false`; enable a write environment only for a controlled fork or correctly configured testnet.

The worker process must receive its own PostgreSQL credential through its isolated `EGRESS_DATABASE_URL`. That database role should have `SELECT` access to schema migrations and canonical snapshots, plus `SELECT`/`INSERT` access to Phase 9 staging tables. It must not have `INSERT`, `UPDATE`, `DELETE`, or `TRUNCATE` privileges on canonical observation, alert, or OKX source-revision tables. Do not reuse the poller/archive writer role for a submission-enabled worker.

## Environment identity

`FORK_WRITE` requires:

- chain ID `196`;
- local Anvil runtime metadata;
- X Layer fork chain ID `196`;
- configured fork block number and hash;
- matching Egress protocol configuration.

`TESTNET_WRITE` requires X Layer testnet chain `1952`, a non-local HTTPS RPC, an explicit protocol address book, and a positively matching configured anchor block hash. A missing, ambiguous, or mismatched identity fails closed.

There is no `LIVE_MAINNET_WRITE` mode in Phase 9.

Phase 10 does not add another mode. Its `npm run phase10:fork` harness accepts only the existing
`FORK_WRITE` environment, positively identifies local Anvil, and pins X Layer block `67,881,241`.
See [PHASE10.md](PHASE10.md) for the complete proof sequence and external prerequisites.

## Intent boundary

Only `AAVE_XBETH_XETH_DELEVERAGE` is accepted. The intent records:

- archived snapshot and integrity hashes;
- chain, observed block, environment, and protocol identity;
- RWA verdict, evidence, source revision/diff, and attestation hashes;
- user, keeper, attestor, policy nonce, revocation nonce, and signed policy bounds;
- deterministic market state hash;
- typed repayment, collateral, swap output, minimum output, deadline, and execution nonce;
- typed contract request hash.

The worker rejects stale snapshots and requests, invalid evidence, invalid signatures, policy widening, revoked or expired policies, changed protocol addresses, mismatched tokens/pools, insufficient liquidity, exceeded bounds, failed simulation, and expired intents.

## Submission

Simulation is always recorded before a submission attempt. A passing simulation is not sufficient by itself: the worker re-identifies the environment and checks the intent deadline immediately before submission. The submitter accepts only the typed simulated Egress request and does not accept arbitrary calldata.

Submission reservations are unique per intent. A duplicate attempt is rejected before the wallet client is called. A reverted or failed submission is recorded as an immutable result.

Migration `0004_phase10_execution_binding.sql` records a version 2 reservation/submission with the
simulation hash, execution fingerprint, and transaction binding. The submitter recomputes the
typed calldata envelope and fingerprint immediately before the wallet call. A changed chain,
keeper, contract, selector, calldata, gas envelope, request hash, simulation, or intent fails
closed.

## Health

`GET /api/operations/health` and `/operations` expose execution staging separately from observation and archive health:

- worker configured state;
- environment;
- worker health;
- latest intent and simulation;
- latest submission and error;
- whether staging submission is configured;
- the invariant `LIVE MAINNET EXECUTION: DISABLED`.

These surfaces never expose a private key or a signing credential and cannot enable submission.
