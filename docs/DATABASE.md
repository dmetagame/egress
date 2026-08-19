# Database Operations

Phase 8C uses direct parameterized SQL against PostgreSQL. No ORM is used.

## Configuration

Set `EGRESS_DATABASE_URL` on the server only. Hosted production also requires either `VERCEL` or `EGRESS_DEPLOYMENT_ENV=production`; filesystem archives are rejected in that mode.

Run migrations explicitly before starting the poller:

```bash
npm run db:migrate
```

The migration runner records the version, name, and SHA-256 checksum in `egress_schema_migrations`. Runtime archive access validates that every expected migration is present and unchanged. Missing, newer, or modified migrations fail closed.

## Tables

- `egress_live_snapshots`: immutable, content-addressed canonical snapshot payloads.
- `egress_live_snapshot_observations`: append-only observations of a canonical snapshot.
- `egress_live_alerts`: immutable evidence-backed alerts with deterministic deduplication.
- `egress_live_alert_deliveries`: per-alert, per-sink delivery state, retry timing, and lease ownership.
- `egress_live_operational_events`: poller, archive, and delivery health events.
- `egress_live_retention_audit`: future explicit retention review/pruning audit records.
- `egress_rwa_source_revisions`: append-only OKX source revisions, raw/normalized payloads,
  content hashes, provenance, and extraction lifecycle state.
- `egress_rwa_source_diffs`: append-only semantic diffs linked to the source revision that they describe.
- `egress_execution_staging_intents`: immutable typed execution intents.
- `egress_execution_staging_simulations`: immutable simulation outcomes, one per intent.
- `egress_execution_staging_submission_reservations`: idempotent one-per-intent submission locks.
- `egress_execution_staging_submissions`: immutable fork/testnet submission outcomes.
- `egress_execution_worker_events`: redacted staging worker lifecycle and failure events.

Migration `2` (`phase8c_rwa_source_revisions`) makes the OKX revision store durable alongside
the live snapshot archive. When `EGRESS_DATABASE_URL` is configured, the live risk pipeline uses
PostgreSQL for both stores. `EGRESS_RISK_STORE_PATH` is only a local development/test fallback;
it is never selected by a hosted runtime.

The snapshot hash is the canonical state identity. A repeated hash never overwrites the payload. A later observation receives its own observation record and timestamp.

Source revisions use the same fail-closed rule. A repeated revision ID is idempotent and returns
the already-persisted canonical payload. Extraction status may move through its lifecycle, but
raw content, normalized content, source version, and content hashes are not replaced. Missing,
newer, or checksum-mismatched migrations prevent either archive from being used.

Migration `3` (`phase9_execution_staging`) is required before an enabled staging worker can
read or write staging records. It does not alter historical observations or OKX source revisions.
Staging payloads are validated against their deterministic integrity hashes after every read.

Migration `4` (`phase10_execution_binding`) adds immutable simulation/submission linkage fields
and unique execution-fingerprint indexes. The migration binds each reservation and submission to
the exact simulation hash and transaction envelope without modifying any Phase 8 observation or
OKX source table.

## Execution worker role

Use a distinct PostgreSQL role for the isolated execution worker. The worker role needs:

- `SELECT` on `egress_schema_migrations` and `egress_live_snapshots`;
- `SELECT` and `INSERT` on the five Phase 9 execution-staging tables;
- no write privilege on live snapshots, observations, alerts, operational events, retention audit,
  OKX source revisions, or OKX source diffs.

The worker and observation services may both use the variable name `EGRESS_DATABASE_URL`, but
their values should identify different database roles in their separate process environments.
Database migrations must continue to run with a dedicated migration credential, not either
runtime role.

For the Phase 10 proof, a third archive credential is supplied as
`EGRESS_PHASE10_ARCHIVE_DATABASE_URL`. It may append the deterministic fork snapshot and its
observation, while the worker-specific `EGRESS_DATABASE_URL` is independently audited before any
simulation or submission. Both URLs must target the same dedicated database through different
roles.

Phase 11 uses the same privilege split with `EGRESS_PHASE11_ARCHIVE_DATABASE_URL`. The archive role
may append the single testnet-compatible canonical snapshot and observation. The execution worker
continues to use its own `EGRESS_DATABASE_URL` and the grants below. No Phase 11 migration or broader
database privilege is required.

### Minimum Phase 10/11 archive-role grants

Run these grants as a database administrator after migrations `0001` through `0004` are applied.
Replace `egress` and `egress_phase11_archive` with the actual database and role names. This role is
only for the controlled proof harness; do not reuse the migration, observation-service, or worker
credential.

```sql
REVOKE ALL ON DATABASE egress FROM egress_phase11_archive;
GRANT CONNECT ON DATABASE egress TO egress_phase11_archive;

REVOKE ALL ON SCHEMA public FROM egress_phase11_archive;
GRANT USAGE ON SCHEMA public TO egress_phase11_archive;

REVOKE ALL ON ALL TABLES IN SCHEMA public FROM egress_phase11_archive;

GRANT SELECT ON TABLE
  public.egress_schema_migrations
TO egress_phase11_archive;

GRANT SELECT, INSERT ON TABLE
  public.egress_live_snapshots,
  public.egress_live_snapshot_observations
TO egress_phase11_archive;

REVOKE UPDATE, DELETE, TRUNCATE ON TABLE
  public.egress_live_snapshots,
  public.egress_live_snapshot_observations
FROM egress_phase11_archive;
```

The archive URL and worker URL must identify distinct role names and the same database. The archive
role needs no sequence privileges because both tables use application-generated identifiers. A
missing `SELECT` or `INSERT` grant on `egress_live_snapshot_observations` causes the proof to fail
closed before execution staging.

The Phase 10 and Phase 11 harnesses run a PostgreSQL privilege audit through the archive credential
before archiving a snapshot. The audit requires exactly database `CONNECT`, schema `USAGE`, migration
metadata `SELECT`, and snapshot/observation `SELECT` plus `INSERT`. It rejects superuser,
`CREATEDB`, `CREATEROLE`, replication, `BYPASSRLS`, database/schema creation, ownership or role
membership that could confer ownership, grant options, credential-catalog reads, migration writes,
snapshot mutation, all OKX revision/diff access, all execution-staging access, and access to alert or
operations tables. The archive role must not own the database, schema, or any Egress table.

### Archive-role runtime integration test

The destructive-negative privilege suite is opt-in and must target a dedicated test database. It is
skipped when neither variable is present and fails closed when only one is present, when the exact
acknowledgement is wrong, when the database name is not explicitly test-scoped, when the target looks
production-like, or when the URL reuses a configured runtime credential.

```bash
export EGRESS_ARCHIVE_PRIVILEGE_TEST_DATABASE_URL='postgresql://<archive-test-role>:<secret>@<host>/egress_phase11_test'
export EGRESS_ARCHIVE_PRIVILEGE_TEST_ACKNOWLEDGE='I_UNDERSTAND_THIS_IS_A_DEDICATED_TEST_DATABASE'
npm run test:database-privileges
```

The test never reads `EGRESS_DATABASE_URL`. It validates migrations and runtime grants, proves the
real `PostgresLiveSnapshotArchive` can append and read valid snapshots and observations, and verifies
that protected reads, writes, truncation, ownership operations, and credential-catalog reads fail.
It appends two uniquely content-addressed fixtures to the dedicated test database. Destructive probes
either fail with `insufficient_privilege` or are deliberately rolled back in the same statement. Test
output does not include the URL or password.

### Snapshot observation integrity boundary

Migration `0001` provides these database-level guarantees:

- `egress_live_snapshots.snapshot_hash` is a primary key;
- `egress_live_snapshot_observations.observation_id` is a primary key;
- every observation `snapshot_hash` must reference an existing snapshot.

The foreign key rejects an orphan observation and the primary key rejects an exact duplicate
observation ID. PostgreSQL does not derive the observation ID, compare observation chain/account/block
or archive status with the referenced snapshot, or impose uniqueness on
`(snapshot_hash, observed_at)`. The observation table does not contain a block-hash column. Therefore,
a direct SQL client with `INSERT` can reference the wrong existing snapshot, supply inconsistent
observation metadata, or create a second ID for the same snapshot and timestamp without violating
the current schema.

The supported archive path prevents those semantic inconsistencies at the application boundary:
`PostgresLiveSnapshotArchive.archive()` first verifies the complete archived snapshot, derives the
observation ID deterministically from the verified snapshot hash and observation timestamp, and copies
chain, account, block, and archive status from that parsed snapshot. The runtime integration test proves
the database constraints and records the application-only cases without granting `UPDATE` or `DELETE`
or changing historical migration `0001`.

### Minimum execution-worker grants

Run grants as a database administrator and replace `egress_execution_worker` with the deployment
role. Do not make this role a schema owner.

```sql
REVOKE ALL ON DATABASE egress FROM egress_execution_worker;
GRANT CONNECT ON DATABASE egress TO egress_execution_worker;

REVOKE ALL ON SCHEMA public FROM egress_execution_worker;
GRANT USAGE ON SCHEMA public TO egress_execution_worker;

REVOKE ALL ON ALL TABLES IN SCHEMA public FROM egress_execution_worker;

GRANT SELECT ON TABLE
  public.egress_schema_migrations,
  public.egress_live_snapshots,
  public.egress_rwa_source_revisions,
  public.egress_rwa_source_diffs
TO egress_execution_worker;

GRANT SELECT, INSERT ON TABLE
  public.egress_execution_staging_intents,
  public.egress_execution_staging_simulations,
  public.egress_execution_staging_submission_reservations,
  public.egress_execution_staging_submissions,
  public.egress_execution_worker_events
TO egress_execution_worker;

REVOKE UPDATE, DELETE, TRUNCATE ON TABLE
  public.egress_execution_staging_intents,
  public.egress_execution_staging_simulations,
  public.egress_execution_staging_submission_reservations,
  public.egress_execution_staging_submissions,
  public.egress_execution_worker_events
FROM egress_execution_worker;
```

The runtime privilege audit also rejects superuser, database `CREATE`, schema `CREATE`, migration
writes, any canonical snapshot/observation/alert/operations write, any OKX revision/diff write, and
any update/delete/truncate privilege on staging history. The staging tables do not use PostgreSQL
sequences, so the worker needs no sequence grants.

## Failure behavior

Database initialization and archive reads fail closed. The service never falls back to a process filesystem in hosted production and never promotes the previous snapshot to current after a database failure.

The staging worker also fails closed on database initialization, migration, read, reservation, or
append failures. A database outage cannot create a write capability or bypass simulation.

## Backups and recovery

Use the managed PostgreSQL provider's point-in-time backup policy for production. Canonical snapshots can also be exported independently:

```bash
npm run live:archive -- export --hash 0x... --output snapshot.json
npm run live:archive -- import --input snapshot.json
```

Export parsing verifies the complete integrity hash and canonical state hash before import. Importing the same snapshot is idempotent and creates only a new observation when its observation timestamp is new.
