# Production Runbook

This runbook describes the supported read-only production topology. It does
not provision infrastructure and does not authorize blockchain writes.

## Current Release Gate

The repository contains the web/API and singleton observer implementation. A
live-data deployment requires PostgreSQL, one observer runtime, and a
deliberately selected public observation account. With any dependency absent
or stale, the API must report `UNAVAILABLE` rather than reuse historical data.

The public demo uses managed PostgreSQL and a free GitHub Actions schedule that
executes the observer's `--once` mode every five minutes. This scheduled
topology is not equivalent to an always-resident worker: GitHub-hosted schedules
are best-effort and may be delayed during platform load. It is suitable for a
read-only demo, but should be replaced by a persistent worker for stricter
poll-timing guarantees.

The current observer address book is X Layer mainnet, chain `196`. The Phase 11
testnet endpoints (`https://testrpc.xlayer.tech/terigon` and
`https://xlayertestrpc.okx.com/terigon`) are chain-`1952` infrastructure for
read-only deployment evidence. Do not place them in the current live observer
environment: the mainnet adapter will reject the chain mismatch. Enabling live
testnet observation requires a separately reviewed protocol profile, including
all Aave, oracle, token, and Uniswap addresses.

## Topology

```text
Browser
  |
  v
Vercel Next.js web/API  --read-->  Managed PostgreSQL
                                         ^
                                         |
                         Singleton observer worker or scheduler
                                         |
                              Approved X Layer RPCs (read-only)
```

Set the Vercel project Root Directory to `apps/web`. The package-local
`vercel.json` runs `npm ci` from the repository root, then `npm run build` from
the web workspace. The web package's `prebuild` compiles `@egress/risk-engine`
before Next.js, so a clean checkout does not depend on an untracked `dist`
directory.

## Environment Separation

### Vercel web/API

Required server-only values include:

- `EGRESS_RUNTIME_MODE=LIVE_READ_ONLY`;
- `EGRESS_DEPLOYMENT_ENV=production`;
- `EGRESS_DATABASE_URL` using a read-only archive role;
- `EGRESS_WEB_INLINE_POLLING=false`;
- approved `EGRESS_XLAYER_RPC_URL` and optional
  `EGRESS_XLAYER_RPC_URLS` values;
- the selected public observation account and freshness limits.

Do not configure private keys, `EGRESS_EXECUTION_PRIVATE_KEY`, or execution
submission credentials in Vercel. Do not prefix database or webhook values with
`NEXT_PUBLIC_`.

### Observer runtime

The worker uses a role permitted to append canonical observations, operational
events, alerts, and source revisions. It receives no wallet key. Run exactly
one active poller until an external leader lease is implemented. Prefer a
persistent process. Where the host only provides scheduled jobs, run
`live-poll.js --once` at the configured cadence and prevent overlap.

The current public-demo scheduler is
`.github/workflows/live-observer.yml`. It runs only from `main`, uses a
repository secret named `EGRESS_OBSERVER_DATABASE_URL`, and serializes runs
with a workflow concurrency group. The secret must contain the PostgreSQL URL
for the observer/archive role, not the web read-only role and not a migration
or owner credential. Keep the stopped Railway service out of the active
topology until a persistent worker deployment is available.

### Migration role

Apply migrations with a separate administrative role before starting either
runtime. The application validates versions, names, and checksums and refuses
to create or silently upgrade an ambiguous schema.

## Startup

```bash
npm ci
npm run db:migrate
npm run live:poll
# Scheduled alternative:
npm run live:poll -- --once
```

The container equivalent is defined in
[`deploy/worker/Dockerfile`](../deploy/worker/Dockerfile). Use the host's
restart policy and log-based alerting for worker liveness.

## Health and Recovery

`GET /api/health` and `GET /api/operations/health` are equivalent read-only
operational checks. A healthy
release should report:

- `runtimeMode=LIVE_READ_ONLY`;
- `broadcastPermitted=false` and `transactionSubmitted=false`;
- a healthy database;
- a recent successful poll;
- RPC provider, current RPC head, indexed-through block, and index lag;
- fresh oracle/source evidence;
- an intact current archive record.

If the worker stops, the web runtime must eventually report `DEGRADED` or
`UNAVAILABLE`; it must not present the last complete observation as current
forever. Restart the same worker against the same database. Do not delete
archive records or reset checkpoints to recover from an RPC outage.

If an RPC provider fails, the configured ordered failover list is tried. Every
provider must independently pass the expected chain and block identity checks.
Remove a provider from configuration if its identity or history is ambiguous;
do not substitute an arbitrary endpoint.

## Backups

Back up PostgreSQL using the managed provider's encrypted, point-in-time
facility. Preserve the Phase 11 deployment files separately and verify their
release hashes. Never regenerate or rewrite those files as part of routine
operations.

## Deployment Sequence

1. Review the diff and run the local release checks.
2. Apply database migrations with the migration role.
3. Deploy the Vercel web/API artifact.
4. Start the singleton observer worker.
5. Check `/api/operations/health` and the browser console.
6. Test the read-only demo flow and `/api/deployment/phase11`.
7. Keep execution staging disabled unless a separately authorized, isolated
   test is being performed.
