# Phase 11: X Layer Testnet Validation

Phase 11 validates the existing isolated execution worker against X Layer testnet, chain `1952`.
It does not add an execution action, alter `EgressExecutor`, or introduce a mainnet write mode.

## Boundary

The three environments remain separate:

```text
production observation  -> read-only, no signer, no broadcast
FORK_WRITE              -> local Anvil, chain 196 fork only
TESTNET_WRITE           -> isolated worker, chain 1952 only
```

`LIVE_MAINNET_WRITE` remains unsupported. The operator page continues to state
`LIVE MAINNET EXECUTION: DISABLED` and exposes no control that can change it.

## Testnet identity

`TESTNET_WRITE` is accepted only when all of these independently agree:

- `EGRESS_EXECUTION_ENVIRONMENT=TESTNET_WRITE`;
- `EGRESS_EXECUTION_ENVIRONMENT_ID=xlayer-testnet-1952`;
- RPC chain ID `1952` from a non-local HTTPS endpoint;
- deployment block and hash;
- content-addressed deployment manifest and configured manifest hash;
- Egress, keeper, Aave, token, router, quoter, factory, and pool addresses;
- runtime bytecode hashes;
- Egress immutable addresses and `PROTOCOL_CONFIG_HASH`;
- Aave provider/pool/oracle and reserve-token links;
- Uniswap factory/router/quoter/pool/token/fee links;
- token names, symbols, and decimals;
- positive configured oracle prices;
- flash-loan premium within the manifest bound;
- worker wallet address equal to the manifest and signed-policy keeper.

The manifest also pins an independent maximum execution-policy envelope. A signed policy broader
than that envelope is rejected even if it is otherwise valid onchain.

The deployer (recorded as manifest `guardian`), keeper, borrower, and risk attestor must all be
present, valid EVM addresses, and pairwise distinct after checksum normalization. The deployment
script enforces this before creating RPC clients or sending configuration transactions, and manifest
creation and verification reuse the same non-overridable validation.

## Required worker configuration

Use a worker-only environment. Never load it into Next.js, the observation poller, or alerting.
Keep the deployment credential set and the worker credential set in separate secret environments;
the combined reference template is not intended to be sourced wholesale.

```bash
EGRESS_EXECUTION_ENVIRONMENT=TESTNET_WRITE
EGRESS_EXECUTION_SUBMISSION_ENABLED=false
EGRESS_EXECUTION_ENVIRONMENT_ID=xlayer-testnet-1952
EGRESS_EXECUTION_CHAIN_ID=1952
EGRESS_EXECUTION_RPC_URL=https://testrpc.xlayer.tech/terigon

EGRESS_EXECUTION_EGRESS_CONTRACT=0x...
EGRESS_EXECUTION_KEEPER_ADDRESS=0x...
EGRESS_EXECUTION_ANCHOR_BLOCK=...
EGRESS_EXECUTION_ANCHOR_BLOCK_HASH=0x...
EGRESS_EXECUTION_TESTNET_MANIFEST_PATH=/absolute/path/xlayer-testnet.json
EGRESS_EXECUTION_TESTNET_MANIFEST_HASH=0x...
EGRESS_EXECUTION_CREDENTIAL_REFERENCE=secret://egress/xlayer-testnet-keeper-v1

EGRESS_DATABASE_URL=postgresql://<worker-role>:<password>@<host>/<database>
# Set only for the single submission pass:
# EGRESS_EXECUTION_PRIVATE_KEY=0x...
```

Every `EGRESS_EXECUTION_*` protocol-address variable in
`packages/risk-engine/.env.execution.example` is also required and must exactly match the manifest.
Keep `EGRESS_EXECUTION_SUBMISSION_ENABLED=false` through deployment and verification. Change it to
`true` only for the single controlled E2E submission after snapshot, policy, simulation, database,
funding, and runtime verification succeed.

The simulation-only pass does not load a keeper private key, construct a wallet client, or require
the keeper to have gas. The borrower and risk-attestor keys are still required by this controlled
proof harness to reproduce the manifest-pinned policy signature and deterministic risk attestation.

`EGRESS_EXECUTION_CREDENTIAL_REFERENCE` is a non-secret operator identifier. The actual key remains
only in `EGRESS_EXECUTION_PRIVATE_KEY` inside the isolated worker secret store. Neither value is
written to snapshots, manifests, execution evidence, logs, health responses, or browser bundles.

## Compatibility deployment

The production X Layer Aave/xBETH/Uniswap addresses have no bytecode on chain `1952`. Phase 11
therefore includes a clearly labelled testnet-only compatibility stack in
`src/testnet/Phase11Compatibility.sol`. It implements only the interfaces required by the unchanged
keeper and `EgressExecutor` flow:

- test xBETH and xETH tokens;
- aToken permit and variable-debt token;
- addresses provider, oracle, and bounded Aave-compatible pool;
- factory, pool, router, and quoter with deterministic test liquidity;
- the unchanged production `EgressExecutor` contract.

The deployment script requires a funded testnet deployer, the matching test-scenario borrower key,
an explicit keeper address, and a JSON execution-bound envelope. It deploys the compatibility stack
and registers the exact borrower-signed policy recorded in the manifest. It never prints a private
key. Policy registration is part of this explicit deployment step, so a later simulation-only worker
run cannot create a hidden setup transaction.

```bash
export EGRESS_EXECUTION_RPC_URL=https://testrpc.xlayer.tech/terigon
export EGRESS_PHASE11_DEPLOYER_PRIVATE_KEY=0x...
export EGRESS_PHASE11_BORROWER_PRIVATE_KEY=0x...
export EGRESS_EXECUTION_KEEPER_ADDRESS=0x...
export EGRESS_PHASE11_BORROWER_ADDRESS=0x...
export EGRESS_PHASE11_RISK_ATTESTOR_ADDRESS=0x...
export EGRESS_PHASE11_COMPATIBILITY_LABEL='Egress Phase 11 compatibility deployment v1'
export EGRESS_PHASE11_EXECUTION_BOUNDS_JSON='{"minimumRiskLevel":3,"maxRepaymentPerExecution":"12000000000000000000","maxCollateralPerExecution":"12000000000000000000","maxCumulativeRepayment":"12000000000000000000","maxCumulativeCollateral":"12500000000000000000","maxCollateralPercentageBps":"2500","maxPositionDebt":"46000000000000000000","maxSlippageBps":"100","maxOracleDeviationBps":"125","maxFlashLoanPremiumBps":"5","maxPreHealthFactor":"1050000000000000000","minPostHealthFactor":"1065000000000000000","minCooldownSeconds":"0","maxExecutions":"1","maxRiskAgeSeconds":"86400","maxClockSkewSeconds":"60"}'
export EGRESS_PHASE11_MANIFEST_PATH=deployments/phase11/xlayer-testnet.json
export EGRESS_PHASE11_STARTING_NONCE=<exact-deployer-pending-nonce>
# Optional; defaults to deployments/phase11/xlayer-testnet.json.journal.json
# export EGRESS_PHASE11_JOURNAL_PATH=deployments/phase11/xlayer-testnet.pending.json
npm run phase11:deploy
```

`EGRESS_PHASE11_STARTING_NONCE` is mandatory. Immediately before creating the journal, the script
queries the deployer's pending nonce and refuses deployment unless it exactly matches the configured
value. It never silently adopts a different nonce.

## Deployment journal

The deployment is intentionally non-resumable. Before transaction 1 can be broadcast, the script
atomically creates a mode-`0600` pending journal. The default path is
`<EGRESS_PHASE11_MANIFEST_PATH>.journal.json`; an explicit `EGRESS_PHASE11_JOURNAL_PATH` is allowed,
but it must not resolve to the final manifest path.

The journal records schema version, deployment ID, chain/environment identity, deployer, starting
nonce, configuration hash, the expected 26-step sequence, timestamps, overall status, and every
step's sender, nonce, target, value, calldata hash, transaction hash, receipt status, block number,
block hash, and created-contract address. It never records private keys, seed phrases, RPC
credentials, or signed credential material.

Each future transaction follows this durable, finality-aware sequence:

```text
persist INTENDED -> broadcast -> persist transaction hash/BROADCAST_UNKNOWN
                 -> persist INITIAL_UNSAFE receipt
                 -> wait/read safe tag -> persist SAFE_CANONICAL evidence
                 -> wait/read finalized tag -> persist FINALIZED_CANONICAL evidence
```

The initial receipt block hash is never overwritten by safe or finalized evidence. Every canonical
stage re-fetches the receipt, transaction, and containing block and checks the hash, block number,
transaction index, sender, nonce, target, value, calldata hash, receipt status, and CREATE address.
The `safe` tag must cover the transaction before safe evidence is accepted, and the configured
publication policy requires `finalized` coverage for all 26 steps before a manifest can be published.
Until each required stage is durably recorded, the journal remains non-terminal. A broadcast
exception with no returned hash is recorded as `UNKNOWN`; receipt timeout, RPC interruption, a
duplicate hash, a finality-head gap, or any evidence mismatch stops the deployment. No step is
rebroadcast and no later step is attempted.

The authoritative deployment order is:

```text
01 DEPLOY_XBETH                    14 SET_XBETH_ORACLE_PRICE
02 DEPLOY_XETH                     15 SET_XETH_ORACLE_PRICE
03 DEPLOY_ADDRESSES_PROVIDER       16 DEPLOY_SWAP_FACTORY
04 DEPLOY_ORACLE                   17 DEPLOY_SWAP_ROUTER
05 DEPLOY_AAVE_POOL                18 DEPLOY_QUOTER
06 DEPLOY_ATOKEN                   19 DEPLOY_SWAP_POOL
07 DEPLOY_VARIABLE_DEBT_TOKEN      20 CONFIGURE_SWAP_FACTORY
08 CONFIGURE_PROVIDER              21 MINT_XBETH_SWAP_LIQUIDITY
09 CONFIGURE_POOL_RESERVES         22 MINT_XETH_SWAP_LIQUIDITY
10 ENABLE_XBETH_MINTER             23 SEED_BORROWER_POSITION
11 ENABLE_XETH_MINTER              24 SEED_FLASH_LIQUIDITY
12 ENABLE_ATOKEN_MINTER            25 DEPLOY_EGRESS_EXECUTOR
13 ENABLE_DEBT_TOKEN_MINTER        26 REGISTER_PROTECTION_POLICY
```

Call targets and deployment addresses are derived from the configured deployer and nonce sequence
and checked before broadcast. Future journals use schema version 3 and keep separate initial,
safe-canonical, and finalized-canonical inclusion objects. The v4 manifest is written only after
all 26 finalized records and the existing full runtime deployment verifier succeed. It contains
the complete ordered provenance, including all three evidence stages, unique transaction hashes,
contiguous nonces, and required block hashes. The manifest is flushed and atomically created
without overwrite; only then is the completed journal marked `FINALIZED` with the manifest hash.

The preserved Phase 11 deployment at the legacy v2 journal path is immutable evidence. A v2 journal
does not contain the transaction-index and staged-finality fields required by the v3/v4 model and
must never be retrofitted or silently upgraded into a production manifest. Reconcile it with the
read-only command below; the command writes a separate, exclusive artifact and leaves the journal
byte-for-byte unchanged:

```bash
npm run phase11:reconcile
```

The default artifact is `<manifest-path>.journal.json.reconciliation.json`; set
`EGRESS_PHASE11_RECONCILIATION_PATH` to an explicit path when needed. The artifact records
`INITIAL_UNSAFE_BLOCK_HASH`, `SAFE_CANONICAL_BLOCK_HASH`, and
`FINALIZED_CANONICAL_BLOCK_HASH` for every transaction, the original journal SHA-256, re-inclusion
status, validation results, and a tamper-evident artifact hash. It is never overwritten.

After a `PASS` reconciliation artifact has independently established finalized canonical evidence for
all 26 transactions, publish the legacy deployment's schema-v4 manifest with the signer-free command:

```bash
npm run phase11:publish-manifest
```

The publisher refuses any private-key, seed, or mnemonic environment variable; uses only read-only RPC
methods; verifies the immutable journal and reconciliation artifact digests; verifies the complete
runtime stack; writes and fsyncs a same-directory temporary file; independently verifies its serialized
contents; and creates the final manifest with an exclusive no-overwrite link. The original unsafe block
evidence remains referenced separately from safe and finalized canonical evidence, including explicit
re-inclusion classification where an unsafe block was replaced.

The output manifest also records chain ID, final deployment block/hash, addresses, keeper, guardian,
protocol configuration hash, token identities, runtime bytecode hashes, execution bounds, policy ID,
and the policy-registration transaction. Its `manifestHash` is deterministic and must be copied to
`EGRESS_EXECUTION_TESTNET_MANIFEST_HASH`.

## Interrupted deployment recovery

Any existing journal, including `PENDING`, `RECONCILIATION_REQUIRED`, `COMPLETE`, or `FINALIZED`,
causes `phase11:deploy` to refuse startup. Any existing final manifest also causes refusal. There is
no automatic resume or cleanup path.

The supported recovery procedure is:

1. Stop the deployment process and preserve the pending journal unchanged.
2. Resolve every recorded transaction externally using sender, nonce, and transaction hash.
3. Reconcile confirmed, failed, and unknown steps; for `UNKNOWN`, inspect the sender and nonce rather
   than guessing whether a broadcast occurred.
4. Independently inspect all resulting onchain contracts and configuration state.
5. Determine through review whether the partial deployment can be abandoned safely.
6. Do not manually replay configuration calls and do not rerun `phase11:deploy` against the same path.
7. If the deployment is abandoned, use a fresh explicitly pinned nonce, manifest path, and journal
   path; these inputs produce a new deployment ID.
8. Any future recovery/resume mechanism must be explicit, reviewed, and separately validated before use.

After a successful deployment, durably back up the final manifest and run independent read-only
verification. Only after both succeed should the deployer key be removed from the deployment
environment. It must never be copied into the execution-worker environment.

Verify the completed deployment without a signer:

```bash
npm run phase11:verify
```

`phase11:reconcile` is also signer-free and read-only. It does not create a wallet client, read a
private key, submit a transaction, mutate the journal, or publish a manifest. A reconciliation is
accepted only when all 26 transactions are present on the same safe and finalized canonical
history and the deployed runtime checks pass. Otherwise it fails closed and the deployment remains
blocked for review.

Verification checks every manifest transaction receipt, the registered policy state, deployment
anchor, runtime bytecode, Egress immutables, protocol links, token metadata, oracle state, keeper,
and policy envelope. `npm run phase11:testnet` does not directly register or submit anything while
`EGRESS_EXECUTION_SUBMISSION_ENABLED=false`; it exits successfully after printing the snapshot,
intent, and simulation hashes. Only the isolated staging worker owns the final execution submission
path.

## PostgreSQL roles

Phase 11 reuses migrations `0001` through `0004`; no schema change is required. Use:

- `EGRESS_PHASE11_ARCHIVE_DATABASE_URL` for the role that appends the testnet-compatible snapshot;
- `EGRESS_DATABASE_URL` for the least-privilege execution worker role.

Both roles target the same dedicated database and must have distinct usernames. The grants in
[DATABASE.md](./DATABASE.md) remain authoritative. The worker cannot update canonical snapshots,
observations, OKX revisions/diffs, migration metadata, or existing staging evidence.

## Completion proof

Phase 11 is complete only after one controlled public testnet transaction produces a successful
receipt and the resulting debt/health state and immutable evidence chain are verified:

```text
snapshot -> intent -> simulation -> fingerprint -> reservation
         -> transaction -> receipt -> resulting state
```

Deployment readiness, unit simulation, a local compatibility test, or the Phase 10 fork are not a
substitute for that receipt. Missing testnet funding, credentials, PostgreSQL URLs, deployment, or a
fresh chain-1952 snapshot is an infrastructure blocker and must be reported as such.

## Security invariants

- No mainnet transaction is created or submitted.
- Observation and web processes reject execution/deployment private keys.
- Browser-visible environment variables may not contain signer, credential, or database secrets.
- RPC/API failure text is operationally redacted before it enters simulation evidence, worker events,
  health responses, or logs.
- The submitter still accepts only the exact simulated `executeAutonomous` request.
- Snapshot, intent, simulation, transaction binding, fingerprint, reservation, and submission
  integrity checks remain unchanged.
- AI output cannot select repayment, collateral, slippage, deadline, or policy bounds.
