# Live snapshot archive

Phase 8B makes the Phase 8A live read-only observation durable and auditable. The archive is still strictly observational: it never creates a signer, permit, allowance, authorization, keeper transaction, or mainnet broadcast.

## Storage model

The archive has two immutable layers:

```text
canonical snapshot (one row/file per snapshotHash)
        |
        +-- observation 1 (when this state was seen)
        +-- observation 2 (same state seen again)
```

Local development and tests use `FilesystemLiveSnapshotArchive`:

```text
EGRESS_LIVE_ARCHIVE_PATH/
  snapshots/<snapshot-hash>.json
  observations/<observation-id>.json
  alerts/<alert-id>.json
```

Each canonical snapshot file is created with exclusive write semantics and is never overwritten. Re-reading the same state returns `inserted: false`; a new observation pointer can still be recorded. This is useful when a block-pinned state is observed more than once.

Hosted production requires `EGRESS_DATABASE_URL` and uses direct Neon/PostgreSQL SQL without an ORM. Run `npm run db:migrate` before starting the service. Runtime access validates the recorded migration checksums and never silently creates application tables:

- `egress_live_snapshots`: immutable canonical payload, status, provenance, integrity hash, and indexed state fields;
- `egress_live_snapshot_observations`: append-only observation timestamps linked to a canonical hash;
- `egress_live_alerts`: immutable evidence-backed alerts with a unique deduplication key.
- `egress_rwa_source_revisions`: durable OKX raw/normalized revisions and extraction state.
- `egress_rwa_source_diffs`: durable semantic diffs used by the evidence validator.

Filesystem storage is intentionally rejected when `VERCEL` is set without PostgreSQL. An ephemeral function filesystem must not be presented as durable production history.

## Snapshot status

Every polling result maps to one of four states:

| Status | Meaning | Current risk classification |
|---|---|---|
| `COMPLETE` | Complete, fresh, same-block, integrity-verified live state | Allowed from the verified RWA verdict |
| `STALE` | A critical adapter exceeded its freshness limit | `null`; no risk level is inferred |
| `INVALID` | Integrity, configuration, or same-block validation failed | `null`; no risk level is inferred |
| `UNAVAILABLE` | RPC, source, account, Aave, pool, or other required data was unavailable | `null`; no risk level is inferred |

`CURRENT` always means the latest observation, even if it is unavailable. A prior `COMPLETE` record is visible only through `HISTORY`.

## Canonical identity and integrity

`liveSnapshotStateHash` uses a stable, sorted-key serialization. It includes state-defining values:

- X Layer chain, block number, block hash, and block timestamp;
- the supported Aave position, reserves, tokens, oracle answers/sources/rounds, and Uniswap pool/quote;
- OKX source revision IDs, content hashes, semantic diff, evidence claims, and risk result;
- policy limits, approved identities, protocol configuration, and adapter versions.

It excludes retrieval timestamps, age counters, generated verdict/intent IDs, and relative preview deadlines. Those values stay in the archived payload and observation metadata. Therefore the same underlying state hashes identically even when it is read again, while a new block, position, oracle, liquidity, evidence revision, policy limit, or verified configuration produces a new hash.

The archive also stores `integrityHash`, which covers the complete persisted record. `integrityValid` records whether a supplied snapshot hash matched the canonical state projection. A tampered payload or hash mismatch is rejected at archive parsing and/or stored as `INVALID` for alerting, never silently converted to usable state.

## Polling

`LiveSnapshotPoller.pollOnce()`:

1. Reads the latest current observation.
2. Runs the existing `LiveRiskSnapshotService`.
3. Validates the envelope, canonical identity, freshness, and same-block consistency.
4. Archives both complete and failed observations.
5. Evaluates deterministic state transitions and alerts.
6. Stores alerts idempotently.

The CLI supports a reproducible one-shot run and a conservative interval loop:

```bash
EGRESS_LIVE_ACCOUNT=0x... \
EGRESS_RISK_STORE_PATH=/absolute/path/egress-risk.json \
EGRESS_LIVE_ARCHIVE_PATH=/absolute/path/live-archive \
npm run live:poll -- --once
```

The `EGRESS_RISK_STORE_PATH` line is for local development only. With `EGRESS_DATABASE_URL`
configured, the poller stores source revisions in PostgreSQL and does not read or write the JSON
revision store. Hosted runtimes reject filesystem fallback when the database is absent.

Without `--once`, the interval is `EGRESS_LIVE_POLL_INTERVAL_SECONDS` and defaults to 300 seconds. Polling errors are logged as failures; no previous snapshot is substituted as current.

## API provenance

`GET /api/live/current` exposes the latest archive status, snapshot hash, block/hash, timestamp, risk/evidence state, freshness, provenance, immutable record, and read-only flags.

`GET /api/live/history` exposes chronological observation summaries with block/hash, risk classification, position values, source revisions, and integrity hash.

`GET /api/live/alerts` exposes alert type, severity, current/previous snapshot hashes, block, timestamp, structured evidence, and previous/current state.

All responses are read-only and use `cache-control: no-store`.
