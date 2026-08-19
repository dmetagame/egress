# Egress

Egress is an AI-powered, non-custodial circuit breaker for xBETH-backed xETH
debt on Aave X Layer.

It monitors relevant risk signals, validates deterministic protection
boundaries, simulates bounded deleveraging, and presents evidence before any
user-authorized execution path. Egress is protection infrastructure, not a
trading interface.

## What Is Verified

- AI-assisted interpretation is confined to structured, allowlisted evidence.
- Deterministic policy checks enforce the user-defined asset, amount, health,
  liquidity, freshness, and timing limits.
- Simulation is required before a protection path can be presented as ready.
- Wallet authorization and any keeper submission are separate from analysis;
  the public web build is read-only and does not create a signer.
- Phase 11 is a finalized, testnet-only compatibility deployment on X Layer
  chain `1952`. It is historical deployment evidence, not a claim that a live
  autonomous keeper is operating or that a production Aave market exists on
  testnet.

## Architecture

```text
Vercel: Next.js web + read-only API
                  |
        Managed PostgreSQL archive
                  ^
Persistent observation worker: npm run live:poll
```

The observer is a long-running process. It owns polling and archive writes and
must run on a container, VM, or equivalent persistent service with a restart
policy. It must not be placed inside a Vercel serverless function. The public
web runtime reads PostgreSQL only and fails closed when the archive or required
evidence is unavailable.

The execution/keeper worker is isolated from both the web runtime and the
observation worker. Its credentials are not part of this public application.
`LIVE_MAINNET_WRITE` is unsupported.

## Current Public Release Status

The public Vercel deployment is a read-only UI/API. Until a managed PostgreSQL
archive and one persistent observer worker are provisioned, live endpoints
fail closed as `UNAVAILABLE`; historical evidence remains available and is
never presented as a current position.

The checked-in live observer profile targets the supported X Layer mainnet
market on chain `196` and validates that protocol address book on every read.
The Phase 11 RPCs for X Layer testnet chain `1952` are used for historical
deployment verification and are not interchangeable with the mainnet live
profile. A chain-`1952` live observer requires a separately reviewed protocol
configuration and is intentionally not enabled by this release.

## Repository Layout

- `apps/web`: Next.js App Router application and read-only API routes.
- `packages/risk-engine`: adapters, evidence validation, policy engine,
  PostgreSQL archive, poller, and isolated execution tooling.
- `src`, `test`, `foundry.toml`: EVM contracts and Foundry tests.
- `deployments/phase11`: immutable testnet deployment, reconciliation, and
  manifest evidence.
- `docs`: protocol, operations, database, execution, and release guidance.
- `deploy/worker`: persistent observer container definition.

## Local Development

Use Node `22.22.0` (see `.nvmrc` and `.node-version`), then:

```bash
npm ci
npm run typecheck
npm run test:all
npm run build
npm run fmt:solidity:check
npm run test:solidity
npm run dev:web
```

The web application is available at `http://localhost:3000` unless that port
is occupied. The default UI is safe to run without a live account: incomplete
live data is shown as unavailable rather than inferred.

For local observation, copy `apps/web/.env.example` to an ignored local env
file and configure a deliberately selected public account. Never load
`packages/risk-engine/.env.execution.example` into the web application.

## Production Deployment

The supported production topology is:

1. Create the Vercel project with Root Directory `apps/web`. The package-local
   [`apps/web/vercel.json`](apps/web/vercel.json) installs the root npm
   workspace and builds the risk-engine dependency before Next.js.
2. Provision managed PostgreSQL and apply migrations `0001` through `0004`
   with a separate migration role.
3. Configure the Vercel web/API runtime with the archive read role and
   `EGRESS_WEB_INLINE_POLLING=false`.
4. Build and run `deploy/worker/Dockerfile` as one persistent observer process
   with the archive writer role and read-only X Layer RPC access.
5. Configure an ordered `EGRESS_XLAYER_RPC_URLS` failover list containing only
   approved HTTPS providers. Each provider is chain-checked before use.
6. Verify `GET /api/health` (an alias of `/api/operations/health`) for database
   state, poller state, RPC head, indexed-through block, index lag, freshness,
   and archive integrity.

See [docs/PRODUCTION.md](docs/PRODUCTION.md) for environment separation,
backups, recovery, health checks, and the worker restart procedure. No paid
database or worker service is provisioned by this repository.

## Public Demo

The public demo is EVM-only and read-only:

`Landing → Open Egress → Overview → protection state → policy bounds →
simulation preview → evidence`

The overview exposes a machine-readable Phase 11 evidence endpoint at
`/api/deployment/phase11`. It identifies X Layer testnet chain `1952`, the
finalized deployment anchor, all `26/26` finalized records, and the five
unsafe-head re-inclusions. It does not imply a current user position, submit a
transaction, or fabricate balances, risk scores, or confirmations.

The current live observer path is a separately configured read-only service.
When it has no complete current snapshot, the UI displays `UNAVAILABLE` and
does not reuse historical values as current. The older pinned-fork fixture is
shown only as historical simulation evidence and is labeled as such.
The replay endpoint serves the checked-in replay evidence artifact and
reconstructs its source/diff identities without creating a signer at request
time.

The public deployment does not claim autonomous live execution. Policy
preparation is refused in the hosted read-only runtime, and no signer or
transaction-submission credential is loaded.

## Database and Observer

PostgreSQL is required for hosted operation. Migrations are checksummed and
the runtime refuses missing, reordered, or modified schemas. Snapshot and
observation writes are content-addressed and idempotent; alert delivery uses
durable leases. The observer should run as a singleton until an external leader
lease is introduced. Restarting it is safe: the persisted archive and
checkpoint/evidence identities prevent duplicate canonical records.

```bash
npm run db:migrate
npm run live:poll -- --once
npm run live:poll
```

The poller is strictly `LIVE_READ_ONLY`; it does not create a signer or submit
a blockchain transaction.

## Phase 11 Evidence

The finalized X Layer testnet compatibility deployment is preserved at:

- `deployments/phase11/xlayer-testnet.json.journal.json`
- `deployments/phase11/xlayer-testnet.json.journal.json.reconciliation.json`
- `deployments/phase11/xlayer-testnet.json`

The release check verifies their immutable SHA-256 values before publication:

- journal: `f1b7dc9a4d4b03f05a0850cd67f23166ceb3b616b5cf574b49ff6b749000fa8a`
- reconciliation: `113036b609e8847b546a9d5936c844cfa687645730f3d19cd0d1f3937d4a8bdb`
- manifest: `2d14c91dc10ca7a5cd1356e822151d6c44b95f0d673ece251db6e52056804eac`

The legacy journal remains unsafe-head historical evidence. The schema-v4
manifest accepts only separately reconciled safe/finalized canonical evidence.
Do not rerun the deployment or manually replay a configuration call.

## Security Model

- No private key belongs in the web, browser bundle, Vercel environment, or
  observation worker.
- Variables prefixed `NEXT_PUBLIC_` are public and must never contain database,
  signer, webhook, credential, or token secrets.
- The web/API is read-only. Wallet controls are disabled in production builds.
- Mainnet write mode is unsupported; Phase 11 is testnet-only.
- Risk analysis does not grant authority. Policy enforcement and contract
  verification remain deterministic boundaries.

See [SECURITY.md](SECURITY.md), [docs/OPERATIONS.md](docs/OPERATIONS.md), and
[docs/EXECUTION_STAGING.md](docs/EXECUTION_STAGING.md).

## Testing

```bash
npm run security:scan
npm run verify:phase11-evidence
npm run typecheck
npm run test:all
npm run test:web:e2e
npm run build
npm run fmt:solidity:check
npm run test:solidity
```

Tests use deterministic fixtures and isolated local forks where required. No
release check submits a blockchain transaction.

## License

Egress is released under the MIT license. See [LICENSE](LICENSE).
