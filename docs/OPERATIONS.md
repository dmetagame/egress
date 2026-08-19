# Observation Operations

The Phase 8C service is a production observation process for one configured public account on X Layer. It reads chain state, evaluates the existing RWA/risk pipeline, archives canonical snapshots, and emits evidence-backed alerts.

## Runtime

The only production observation mode is `LIVE_READ_ONLY`. The runtime always reports:

- `broadcastPermitted: false`
- `transactionSubmitted: false`
- `LIVE MAINNET EXECUTION: DISABLED`

No signer, private key, permit, allowance, keeper transaction, or autonomous mainnet execution is created.

Server-only configuration:

| Variable | Purpose | Default / rule |
| --- | --- | --- |
| `EGRESS_RUNTIME_MODE` | Observation runtime mode | `LIVE_READ_ONLY`; all other values rejected |
| `EGRESS_DEPLOYMENT_ENV` | Marks a production host | `production` requires PostgreSQL |
| `EGRESS_DATABASE_URL` | Durable PostgreSQL archive | Required in hosted production |
| `EGRESS_XLAYER_RPC_URL` | X Layer read-only RPC | Official HTTPS RPC |
| `EGRESS_LIVE_ACCOUNT` | Public observation account | Required for a complete position snapshot |
| `EGRESS_LIVE_EGRESS_SPENDER` | Optional allowance observation target | Read-only address; does not authorize Egress |
| `EGRESS_LIVE_OBSERVATION_BLOCK` | Optional reproducibility pin | Positive block number |
| `EGRESS_LIVE_OBSERVATION_BLOCK_HASH` | Hash paired with the pinned block | Rejected without the block number |
| `EGRESS_LIVE_MAX_BLOCK_AGE_SECONDS` | X Layer block freshness ceiling | 120 |
| `EGRESS_LIVE_MAX_ORACLE_AGE_SECONDS` | Oracle freshness ceiling | 21600 |
| `EGRESS_LIVE_MAX_SOURCE_AGE_SECONDS` | Official OKX source freshness ceiling | 86400 |
| `EGRESS_RISK_STORE_PATH` | Local OKX source revision store fallback | `.data/egress-risk.json`; ignored when PostgreSQL is configured |
| `EGRESS_LIVE_ARCHIVE_PATH` | Local development archive | `.data/live-archive`; never hosted fallback |
| `EGRESS_LIVE_POLL_INTERVAL_SECONDS` | Poll cadence | 300; minimum 60 |
| `EGRESS_LIVE_POLL_READ_TIMEOUT_MS` | Adapter-cycle deadline | 120000 |
| `EGRESS_LIVE_POLL_ARCHIVE_TIMEOUT_MS` | Archive operation deadline | 30000 |
| `EGRESS_LIVE_POLL_MAX_ATTEMPTS` | Bounded adapter attempts | 2; maximum 5 |
| `EGRESS_LIVE_POLL_RETRY_BACKOFF_MS` | Initial retry delay | 500 |
| `EGRESS_LIVE_POLL_MAX_RETRY_BACKOFF_MS` | Maximum retry delay | 5000 |
| `EGRESS_LIVE_POLL_FAILURE_THRESHOLD` | Unavailable threshold | 3 consecutive failures |
| `EGRESS_ALERT_CONSOLE_ENABLED` | Structured console sink | true |
| `EGRESS_ALERT_WEBHOOK_URL` | Generic webhook endpoint | Optional; HTTPS required |
| `EGRESS_ALERT_WEBHOOK_SECRET` | HMAC signing secret | Optional pair; minimum 32 characters |
| `EGRESS_ALERT_WEBHOOK_SINK_ID` | Stable webhook sink identity | Optional; provider-neutral identifier |
| `EGRESS_ALERT_DELIVERY_TIMEOUT_MS` | Per-attempt webhook timeout | 10000 |
| `EGRESS_ALERT_MAX_ATTEMPTS_PER_RUN` | Retry bound per cycle | 3 |
| `EGRESS_ALERT_MAX_TOTAL_ATTEMPTS` | Durable total attempt bound | 6 |
| `EGRESS_ALERT_RETRY_BACKOFF_MS` | Initial delivery retry delay | 1000 |
| `EGRESS_ALERT_MAX_RETRY_BACKOFF_MS` | Maximum delivery retry delay | 60000 |
| `EGRESS_ALERT_DELIVERY_LEASE_MS` | Worker delivery lease | 120000 |

`EGRESS_LIVE_MAINNET_BROADCAST` and `LIVE_MAINNET_BROADCAST` must be false or unset. Server credentials must never use a `NEXT_PUBLIC_` prefix.

## Poll cycle

Each cycle reads the latest X Layer block, Aave position, oracle state, xBETH/xETH state, Uniswap liquidity/quote, and official OKX evidence. It builds one canonical snapshot, validates freshness and same-block consistency, writes the snapshot and observation, evaluates deterministic alerts, then attempts configured alert delivery.

Poll cycles are single-flight. Adapter reads use a bounded timeout and deterministic retry/backoff. A failed cycle is recorded as degraded or unavailable; it does not reuse the previous snapshot as current and does not publish a fabricated risk level.

## Health

The read-only operator endpoint is `GET /api/operations/health`. The `/operations` page exposes poller, archive, database, RPC, oracle, OKX source, delivery, freshness, current-position, and counter state. It contains no action that can enable broadcasting.

It also exposes the isolated Phase 9 execution-staging state: worker configuration, explicit
environment, latest typed intent, latest simulation, latest submission, last worker error, and
submission capability. This is separate from observation health. The page always displays
`LIVE MAINNET EXECUTION: DISABLED`.

Health states:

- `HEALTHY`: recent complete observation and no current operational failure;
- `DEGRADED`: a bounded failure, stale/invalid snapshot, or delivery problem is present;
- `UNAVAILABLE`: no usable current observation or a critical dependency is unavailable.

The operator health calculation also applies a bounded age window derived from the configured poll interval:
an observation older than two poll intervals is `DEGRADED`, and one older than three poll intervals is
`UNAVAILABLE`. A stopped poller therefore cannot leave an old observation looking healthy indefinitely.
Snapshot age measures time since observation; archive lag separately measures the delay between the canonical
state timestamp and the immutable observation record.

Run the CLI poller as one production worker. Single-flight protection prevents overlap within that worker;
PostgreSQL content-addressing, alert deduplication, UUID delivery leases, and append-only source revision
storage keep restarts and duplicate worker attempts from overwriting canonical state. A deployment that runs
multiple active poller replicas should add an external singleton/leader lease at the process supervisor layer.

The Phase 9 staging worker is a separate process and must not share its private-key environment
with the observation poller or web runtime. The observation deployment remains singleton until an
external leader lease is added; the process-local poller lock is not sufficient for horizontal replicas.

Operational errors are redacted before persistence or display. Account identifiers and secrets are not included in operator metrics.

## Phase 11 testnet proof

### Deployment provenance and reconciliation

X Layer testnet uses replaceable unsafe-head blocks. Deployment receipts therefore have three
distinct provenance stages: `INITIAL_UNSAFE`, `SAFE_CANONICAL`, and `FINALIZED_CANONICAL`. The
initial receipt hash is retained as historical evidence; it is never replaced by a later canonical
hash. A transaction is not eligible for the Phase 11 manifest until its block is covered by the
`safe` tag and then the `finalized` tag, with receipt, transaction, block, index, sender, nonce,
target, calldata, status, and CREATE-address checks passing at each stage.

The existing legacy v2 journal is immutable and cannot be upgraded in place. Run the signer-free,
read-only reconciliation command to produce a separate append-only artifact:

```bash
npm run phase11:reconcile
```

It hashes the journal before parsing, rechecks that hash throughout processing, uses only public
RPC reads, and refuses to overwrite an existing reconciliation artifact. It does not create a
manifest unless a future, explicitly reviewed publication path proves the configured finality
policy. Never rerun `phase11:deploy` against an existing journal and never manually replay a
deployment call.

Run Phase 11 only from an isolated worker host with a dedicated chain-1952 wallet. Start from
`packages/risk-engine/.env.execution.example`; do not load that file into Next.js, the observation
poller, or alert delivery.

1. Apply migrations `0001` through `0004` with the migration role, then provision distinct archive
   and execution-worker roles using the grants in [DATABASE.md](./DATABASE.md).
2. Fund the dedicated deployer and keeper with X Layer testnet gas only. Configure the matching
   test borrower key, explicit borrower/keeper/risk-attestor addresses, complete bounded-policy JSON,
   and the deployer's exact pending nonce in `EGRESS_PHASE11_STARTING_NONCE`.
3. Run `npm run phase11:deploy` once from the isolated deployment environment. It deploys the
   compatibility contracts and registers the exact borrower-signed bounded policy. If any journal is
   left behind, stop and follow the recovery procedure in [PHASE11.md](./PHASE11.md); rerun and manual
   configuration replay are forbidden.
4. Durably back up the generated manifest, then run `npm run phase11:verify`. This is read-only and verifies chain `1952`, every deployment receipt,
   registered policy, runtime bytecode, contract identities, token metadata, protocol links, keeper,
   and policy bounds. After verification succeeds, remove the deployer key from the deployment
   environment; never move it into the execution worker.
5. Fill the manifest-pinned worker variables. Run `npm run typecheck:phase11`, then
   `npm run phase11:testnet` with submission still disabled. A
   successful deterministic simulation exits without creating a wallet client or requiring keeper gas,
   and prints the snapshot, intent, and simulation hashes for review.
6. After reviewing the simulation and worker/database identities, set
   `EGRESS_EXECUTION_SUBMISSION_ENABLED=true` only in the isolated worker and run
   `npm run phase11:testnet` once. Preserve `reports/phase11/xlayer-testnet-execution.json` and return
   submission to `false` immediately afterward.

The deployment private key is not permitted in the execution worker after deployment. The
simulation-only pass needs the borrower and risk-attestor keys but not the keeper key. The controlled
submission pass additionally needs the dedicated keeper key. The runner strips all keys before
reading staging configuration and never writes them to the manifest, snapshot, database evidence,
report, health output, or logs. A successful Phase 10 fork run is not a substitute for a successful
public X Layer testnet receipt.
