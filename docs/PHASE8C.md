# Phase 8C: Production Observation Operations

Phase 8C hardens the live read-only circuit-breaker observation path without changing the risk model or execution authority.

## Delivered

- explicit PostgreSQL migration and checksum validation;
- immutable content-addressed snapshots plus append-only observations;
- durable PostgreSQL OKX source revisions and semantic diffs with an explicit second migration;
- versioned retention policy with canonical evidence retained indefinitely;
- single-flight poller with bounded timeouts, retries, and health states;
- deterministic operational events and metrics;
- thresholded alert hysteresis for continuous debt accrual and small health-factor movement;
- console and HMAC webhook alert sinks with durable leases and idempotency keys;
- read-only operator health endpoint and page;
- deterministic snapshot export/import with integrity verification;
- redacted server-only configuration and failure messages.

The hosted live path selects PostgreSQL for both canonical observations and the source revision
pipeline. Local JSON source storage remains available only for development and tests. Source writes
are idempotent and return the canonical persisted revision/diff, which prevents concurrent ingestion
from analyzing a non-canonical orphan revision.

## Required environment

Core values:

- `EGRESS_XLAYER_RPC_URL`
- `EGRESS_LIVE_ACCOUNT`
- `EGRESS_DATABASE_URL` in hosted/production deployment
- `EGRESS_RUNTIME_MODE=LIVE_READ_ONLY` (default and only accepted production value)
- `EGRESS_LIVE_MAINNET_BROADCAST=false` or unset

Operational values include `EGRESS_LIVE_POLL_INTERVAL_SECONDS`, poll timeout/retry variables, and the optional `EGRESS_ALERT_WEBHOOK_URL` plus `EGRESS_ALERT_WEBHOOK_SECRET`. See `docs/DATABASE.md` and `docs/ALERT_DELIVERY.md`.

## Security boundary

AI remains an interpretation layer. Deterministic policy and execution code remain authoritative for transaction amounts. Phase 8C adds no write client and no transaction path. `LIVE_MAINNET` remains disabled, and replay/fork execution paths are unchanged.

## Failure modes

RPC, Aave, oracle, Uniswap, OKX, archive, database, consistency, configuration, or alert-delivery failures remain explicit operational states. Missing data is never converted into `LOW`, `NORMAL`, or a protected state. The previous snapshot may be inspected as history but is never reused as current.
