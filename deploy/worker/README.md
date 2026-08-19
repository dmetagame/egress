# Egress observation worker

The observation poller is a persistent, read-only process. It owns polling and
all archive writes; the Vercel web/API runtime only reads PostgreSQL.

Build from the repository root:

```bash
docker build -f deploy/worker/Dockerfile -t egress-observer:release .
```

Required runtime configuration is supplied by the host secret manager, never
copied into the image:

- `EGRESS_DATABASE_URL`: PostgreSQL URL for the archive/poller role;
- `EGRESS_XLAYER_RPC_URL`: primary HTTPS X Layer read-only RPC;
- `EGRESS_XLAYER_RPC_URLS`: optional comma-separated HTTPS failover RPCs;
- `EGRESS_LIVE_ACCOUNT`: deliberately selected public observation account;
- the bounded freshness and alert variables documented in
  [`apps/web/.env.example`](../../apps/web/.env.example).

The worker must not receive `NEXT_PUBLIC_*` secrets, signer variables, private
keys, or execution-submission credentials. Apply migrations with the separate
migration role before starting it. Use the web `GET /api/operations/health`
endpoint for database, poller, RPC-head, indexed-through, and lag checks. A
process supervisor must restart the worker and alert on missing successful poll
events; run only one active poller until an external leader lease is added.

The current observer address book is X Layer mainnet, chain `196`. The Phase 11
chain-`1952` testnet RPC endpoints are reserved for historical deployment
verification and cannot be used by this worker until a separately reviewed
testnet protocol profile is implemented.
