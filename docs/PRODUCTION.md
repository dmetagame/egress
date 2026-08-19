# Production Runbook

This runbook describes the supported read-only production topology. It does
not provision infrastructure and does not authorize blockchain writes.

## Topology

```text
Browser
  |
  v
Vercel Next.js web/API  --read-->  Managed PostgreSQL
                                         ^
                                         |
                              Persistent observer worker
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

### Persistent observer

The worker uses a role permitted to append canonical observations, operational
events, alerts, and source revisions. It receives no wallet key. Run exactly
one active poller until an external leader lease is implemented.

### Migration role

Apply migrations with a separate administrative role before starting either
runtime. The application validates versions, names, and checksums and refuses
to create or silently upgrade an ambiguous schema.

## Startup

```bash
npm ci
npm run db:migrate
npm run live:poll
```

The container equivalent is defined in
[`deploy/worker/Dockerfile`](../deploy/worker/Dockerfile). Use the host's
restart policy and log-based alerting for worker liveness.

## Health and Recovery

`GET /api/operations/health` is the read-only operational check. A healthy
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
