CREATE TABLE IF NOT EXISTS egress_schema_migrations (
  version integer PRIMARY KEY,
  name text NOT NULL,
  checksum text NOT NULL,
  applied_at timestamptz NOT NULL DEFAULT now()
);

-- egress:statement
CREATE TABLE IF NOT EXISTS egress_live_snapshots (
  snapshot_hash text PRIMARY KEY,
  archive_status text NOT NULL,
  chain_id integer,
  account text,
  observed_block numeric(78, 0),
  block_hash text,
  state_timestamp timestamptz NOT NULL,
  risk_classification text,
  configuration_hash text NOT NULL,
  payload jsonb NOT NULL,
  integrity_hash text NOT NULL,
  created_at timestamptz NOT NULL
);

-- egress:statement
ALTER TABLE egress_live_snapshots
  ADD COLUMN IF NOT EXISTS archive_status text;

-- egress:statement
ALTER TABLE egress_live_snapshots
  ADD COLUMN IF NOT EXISTS chain_id integer;

-- egress:statement
ALTER TABLE egress_live_snapshots
  ADD COLUMN IF NOT EXISTS account text;

-- egress:statement
ALTER TABLE egress_live_snapshots
  ADD COLUMN IF NOT EXISTS observed_block numeric(78, 0);

-- egress:statement
ALTER TABLE egress_live_snapshots
  ADD COLUMN IF NOT EXISTS block_hash text;

-- egress:statement
ALTER TABLE egress_live_snapshots
  ADD COLUMN IF NOT EXISTS state_timestamp timestamptz;

-- egress:statement
ALTER TABLE egress_live_snapshots
  ADD COLUMN IF NOT EXISTS risk_classification text;

-- egress:statement
ALTER TABLE egress_live_snapshots
  ADD COLUMN IF NOT EXISTS configuration_hash text;

-- egress:statement
ALTER TABLE egress_live_snapshots
  ADD COLUMN IF NOT EXISTS payload jsonb;

-- egress:statement
ALTER TABLE egress_live_snapshots
  ADD COLUMN IF NOT EXISTS integrity_hash text;

-- egress:statement
ALTER TABLE egress_live_snapshots
  ADD COLUMN IF NOT EXISTS created_at timestamptz;

-- egress:statement
CREATE TABLE IF NOT EXISTS egress_live_snapshot_observations (
  observation_id text PRIMARY KEY,
  snapshot_hash text NOT NULL REFERENCES egress_live_snapshots(snapshot_hash),
  chain_id integer,
  account text,
  observed_block numeric(78, 0),
  archive_status text,
  observed_at timestamptz NOT NULL
);

-- egress:statement
ALTER TABLE egress_live_snapshot_observations
  ADD COLUMN IF NOT EXISTS chain_id integer;

-- egress:statement
ALTER TABLE egress_live_snapshot_observations
  ADD COLUMN IF NOT EXISTS account text;

-- egress:statement
ALTER TABLE egress_live_snapshot_observations
  ADD COLUMN IF NOT EXISTS observed_block numeric(78, 0);

-- egress:statement
ALTER TABLE egress_live_snapshot_observations
  ADD COLUMN IF NOT EXISTS archive_status text;

-- egress:statement
UPDATE egress_live_snapshot_observations AS observation
SET
  chain_id = snapshot.chain_id,
  account = snapshot.account,
  observed_block = snapshot.observed_block,
  archive_status = snapshot.archive_status
FROM egress_live_snapshots AS snapshot
WHERE observation.snapshot_hash = snapshot.snapshot_hash
  AND (
    observation.chain_id IS NULL OR
    observation.account IS NULL OR
    observation.observed_block IS NULL OR
    observation.archive_status IS NULL
  );

-- egress:statement
CREATE TABLE IF NOT EXISTS egress_live_alerts (
  alert_id text PRIMARY KEY,
  deduplication_key text UNIQUE NOT NULL,
  alert_type text NOT NULL,
  severity text NOT NULL,
  alert_status text NOT NULL DEFAULT 'ACTIVE',
  snapshot_hash text NOT NULL REFERENCES egress_live_snapshots(snapshot_hash),
  previous_snapshot_hash text,
  block_number numeric(78, 0),
  alert_timestamp timestamptz NOT NULL,
  payload jsonb NOT NULL,
  created_at timestamptz NOT NULL
);

-- egress:statement
ALTER TABLE egress_live_alerts
  ADD COLUMN IF NOT EXISTS alert_status text NOT NULL DEFAULT 'ACTIVE';

-- egress:statement
CREATE TABLE IF NOT EXISTS egress_live_alert_deliveries (
  alert_id text NOT NULL REFERENCES egress_live_alerts(alert_id),
  sink_id text NOT NULL,
  idempotency_key text NOT NULL UNIQUE,
  delivery_status text NOT NULL,
  attempts integer NOT NULL DEFAULT 0,
  response_status integer,
  last_error text,
  last_attempt_at timestamptz,
  next_attempt_at timestamptz,
  delivered_at timestamptz,
  lease_id text,
  lease_expires_at timestamptz,
  created_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL,
  PRIMARY KEY (alert_id, sink_id)
);

-- egress:statement
ALTER TABLE egress_live_alert_deliveries
  ADD COLUMN IF NOT EXISTS lease_id text;

-- egress:statement
ALTER TABLE egress_live_alert_deliveries
  ADD COLUMN IF NOT EXISTS lease_expires_at timestamptz;

-- egress:statement
CREATE TABLE IF NOT EXISTS egress_live_operational_events (
  event_id text PRIMARY KEY,
  event_type text NOT NULL,
  health_state text NOT NULL,
  snapshot_hash text,
  observed_block numeric(78, 0),
  started_at timestamptz NOT NULL,
  completed_at timestamptz NOT NULL,
  duration_ms integer NOT NULL,
  payload jsonb NOT NULL,
  created_at timestamptz NOT NULL
);

-- egress:statement
CREATE TABLE IF NOT EXISTS egress_live_retention_audit (
  audit_id text PRIMARY KEY,
  policy_version integer NOT NULL,
  record_type text NOT NULL,
  action text NOT NULL,
  cutoff_at timestamptz,
  affected_records integer NOT NULL,
  reason text NOT NULL,
  created_at timestamptz NOT NULL
);

-- egress:statement
CREATE INDEX IF NOT EXISTS egress_live_snapshots_account_block_time_idx
  ON egress_live_snapshots (account, observed_block DESC, created_at DESC);

-- egress:statement
CREATE INDEX IF NOT EXISTS egress_live_snapshots_hash_idx
  ON egress_live_snapshots (snapshot_hash);

-- egress:statement
CREATE UNIQUE INDEX IF NOT EXISTS egress_live_snapshots_hash_unique_idx
  ON egress_live_snapshots (snapshot_hash);

-- egress:statement
CREATE INDEX IF NOT EXISTS egress_live_snapshots_status_time_idx
  ON egress_live_snapshots (archive_status, created_at DESC);

-- egress:statement
CREATE INDEX IF NOT EXISTS egress_live_observations_account_block_time_idx
  ON egress_live_snapshot_observations (account, observed_block DESC, observed_at DESC);

-- egress:statement
CREATE INDEX IF NOT EXISTS egress_live_observations_snapshot_time_idx
  ON egress_live_snapshot_observations (snapshot_hash, observed_at DESC);

-- egress:statement
CREATE UNIQUE INDEX IF NOT EXISTS egress_live_observations_id_unique_idx
  ON egress_live_snapshot_observations (observation_id);

-- egress:statement
CREATE INDEX IF NOT EXISTS egress_live_observations_time_idx
  ON egress_live_snapshot_observations (observed_at DESC);

-- egress:statement
CREATE INDEX IF NOT EXISTS egress_live_canonical_observation_lookup_idx
  ON egress_live_snapshot_observations (chain_id, account, observed_block DESC, observed_at DESC)
  WHERE account IS NOT NULL;

-- egress:statement
CREATE INDEX IF NOT EXISTS egress_live_alerts_state_time_idx
  ON egress_live_alerts (alert_status, created_at DESC);

-- egress:statement
CREATE UNIQUE INDEX IF NOT EXISTS egress_live_alerts_dedupe_unique_idx
  ON egress_live_alerts (deduplication_key);

-- egress:statement
CREATE INDEX IF NOT EXISTS egress_live_alerts_type_severity_time_idx
  ON egress_live_alerts (alert_type, severity, created_at DESC);

-- egress:statement
CREATE INDEX IF NOT EXISTS egress_live_alert_deliveries_status_time_idx
  ON egress_live_alert_deliveries (delivery_status, updated_at DESC);

-- egress:statement
CREATE INDEX IF NOT EXISTS egress_live_alert_deliveries_retry_idx
  ON egress_live_alert_deliveries (next_attempt_at ASC)
  WHERE delivery_status IN ('PENDING', 'FAILED');

-- egress:statement
CREATE INDEX IF NOT EXISTS egress_live_operational_events_health_time_idx
  ON egress_live_operational_events (health_state, created_at DESC);

-- egress:statement
CREATE INDEX IF NOT EXISTS egress_live_operational_events_type_time_idx
  ON egress_live_operational_events (event_type, created_at DESC);
