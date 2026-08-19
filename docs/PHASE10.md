# Phase 10: Pinned-Fork Execution Validation

Phase 10 validates the existing isolated execution staging worker end to end against a pinned X Layer Anvil fork. It does not add an execution mode, contract action, or mainnet capability.

## Boundary

The proof composes existing production modules:

```text
Phase 5 pinned X Layer setup
        |
        v
LiveRiskSnapshotService (same-block reads)
        |
        v
PostgresLiveSnapshotArchive (archive role)
        |
        v
PostgresStagingSnapshotReader (worker role)
        |
        v
EgressExecutionStagingWorker
        |
        v
ViemExecutionSubmitter
        |
        v
local Anvil FORK_WRITE only
```

Observation polling, canonical hashing, risk interpretation, policy evaluation, contract authorization, alerting, and web operations remain unchanged.

## Required configuration

The runner refuses to start unless all of the following are explicit:

```bash
EGRESS_EXECUTION_ENVIRONMENT=FORK_WRITE
EGRESS_EXECUTION_SUBMISSION_ENABLED=true
EGRESS_EXECUTION_RPC_URL=http://127.0.0.1:8545
EGRESS_EXECUTION_CHAIN_ID=196
EGRESS_EXECUTION_FORK_RUNTIME=ANVIL

EGRESS_XLAYER_FORK_RPC_URL=https://<reachable-x-layer-rpc>
EGRESS_PHASE10_ARCHIVE_DATABASE_URL=postgresql://<archive-role>:<secret>@<host>/<database>
EGRESS_DATABASE_URL=postgresql://<execution-worker-role>:<secret>@<host>/<database>
```

The two database URLs must target the same dedicated Phase 10 database through different roles. Migrations must already be applied by a separate migration/admin credential. The runner never invents credentials and does not run migrations.

`EGRESS_EXECUTION_PRIVATE_KEY` is rejected by this harness. The only signing account is the deterministic, unlocked local Anvil keeper. Any live-mainnet broadcast flag is also rejected.

## Pinned environment

- Upstream chain: X Layer mainnet, chain ID `196`.
- Fork block: `67,881,241`.
- Local endpoint: `http://127.0.0.1:8545`.
- Runtime: Anvil, positively identified with `anvil_metadata`.
- Keeper: `0x70997970C51812dc3A010C7d01b50e0d17dc79C8`.
- Protocol addresses: the verified `XLAYER_MAINNET` address book.
- Egress executor: deployed deterministically during the local setup and bound into the signed policy and execution intent.

The runner starts Anvil when the local endpoint is absent. If another service occupies the endpoint, or Anvil cannot bind, it fails closed. The setup resets Anvil to the explicit upstream RPC and pinned block and verifies chain ID, fork block, and fork hash.

## Snapshot linkage

The archived snapshot is built from real fork reads at one explicit local block after the synthetic xBETH/xETH Aave position and bounded Phase 5 policy are registered. Replay revision C is passed through the existing deterministic RWA evidence pipeline so the archived verdict, claims, source revision, semantic diff, policy evaluation, and signed attestation remain linked.

The harness requires:

- `COMPLETE` archive status;
- `CONSISTENT` same-block status;
- valid canonical snapshot and archive integrity hashes;
- snapshot account, chain, block, protocol addresses, and HIGH verdict matching the execution request;
- a worker-role read returning the exact same immutable payload.

The same fixed observation is read twice before archival. Both reads must produce the same snapshot hash.

## Simulation and submission binding

The worker runs the same request twice with submission disabled. Both attempts must return the same intent hash and simulation hash.

For submission, two workers race the same immutable request. PostgreSQL's unique one-per-intent reservation permits one submitter call and rejects the other with `DUPLICATE_EXECUTION`.

The version 2 reservation and submission evidence bind:

- intent hash;
- simulation hash;
- execution fingerprint;
- chain ID and `FORK_WRITE` environment;
- keeper;
- Egress contract;
- `executeAutonomous` selector;
- encoded calldata hash;
- typed contract request hash;
- gas envelope;
- signed policy bounds and deterministic execution amounts through the intent hash.

`ViemExecutionSubmitter` recomputes and verifies this binding immediately before calling the wallet client. Modified calldata, contract, chain, keeper, bounds, intent, or simulation evidence is rejected.

## State and evidence checks

A successful run verifies:

- one and only one wallet submission;
- confirmed `Deleveraged` event;
- xETH debt decreases;
- health factor improves;
- no post-event user permit is consumed;
- Egress retains no xETH, xBETH, or aXbETH balance;
- reservation, submission, intent, simulation, and transaction hashes remain linked;
- replay after execution cannot produce a second confirmed action;
- canonical snapshot, observation, migration, and OKX source-history counts do not change while the execution worker runs.

Success artifacts are written to:

- `reports/phase10/pinned-fork-execution.json`
- `reports/phase10/pinned-fork-execution.md`

Run with:

```bash
npm run phase10:fork
```

Do not treat the harness as passed unless it reaches a confirmed local-fork receipt and writes the success report. Missing PostgreSQL configuration, unreachable X Layer RPC, or local port restrictions are infrastructure blockers, not reasons to substitute another chain or bypass durable evidence.

## Security invariants

- `LIVE_MAINNET_WRITE` remains unsupported.
- `LIVE MAINNET EXECUTION: DISABLED` remains the operator-visible state.
- The observation process has no signer, private key, permit, allowance, wallet client, or broadcast path.
- The execution worker accepts only `AAVE_XBETH_XETH_DELEVERAGE` typed intents.
- The worker role cannot mutate canonical observations or OKX source revisions.
- The client bundle receives no database or execution credentials.
- AI output does not determine repayment, collateral, swap, slippage, or health-factor bounds.
