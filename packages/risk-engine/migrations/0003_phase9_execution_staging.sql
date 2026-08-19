CREATE TABLE IF NOT EXISTS egress_execution_staging_intents (
  intent_hash text PRIMARY KEY,
  request_hash text NOT NULL UNIQUE,
  snapshot_hash text NOT NULL REFERENCES egress_live_snapshots(snapshot_hash),
  environment text NOT NULL CHECK (environment IN ('FORK_WRITE', 'TESTNET_WRITE')),
  chain_id integer NOT NULL,
  observed_block numeric(78, 0) NOT NULL,
  payload jsonb NOT NULL,
  integrity_hash text NOT NULL,
  created_at timestamptz NOT NULL
);

-- egress:statement
CREATE TABLE IF NOT EXISTS egress_execution_staging_simulations (
  simulation_hash text PRIMARY KEY,
  intent_hash text NOT NULL UNIQUE REFERENCES egress_execution_staging_intents(intent_hash),
  snapshot_hash text NOT NULL REFERENCES egress_live_snapshots(snapshot_hash),
  environment text NOT NULL CHECK (environment IN ('FORK_WRITE', 'TESTNET_WRITE')),
  simulation_status text NOT NULL CHECK (simulation_status IN ('PASSED', 'FAILED')),
  payload jsonb NOT NULL,
  integrity_hash text NOT NULL,
  created_at timestamptz NOT NULL
);

-- egress:statement
CREATE TABLE IF NOT EXISTS egress_execution_staging_submission_reservations (
  reservation_id uuid PRIMARY KEY,
  intent_hash text NOT NULL UNIQUE REFERENCES egress_execution_staging_intents(intent_hash),
  environment text NOT NULL CHECK (environment IN ('FORK_WRITE', 'TESTNET_WRITE')),
  payload jsonb NOT NULL,
  integrity_hash text NOT NULL,
  created_at timestamptz NOT NULL
);

-- egress:statement
CREATE TABLE IF NOT EXISTS egress_execution_staging_submissions (
  submission_hash text PRIMARY KEY,
  intent_hash text NOT NULL UNIQUE REFERENCES egress_execution_staging_intents(intent_hash),
  environment text NOT NULL CHECK (environment IN ('FORK_WRITE', 'TESTNET_WRITE')),
  submission_status text NOT NULL CHECK (submission_status IN ('CONFIRMED', 'REVERTED', 'FAILED')),
  transaction_hash text,
  block_number numeric(78, 0),
  gas_used numeric(78, 0),
  payload jsonb NOT NULL,
  integrity_hash text NOT NULL,
  created_at timestamptz NOT NULL
);

-- egress:statement
CREATE TABLE IF NOT EXISTS egress_execution_worker_events (
  event_hash text PRIMARY KEY,
  event_type text NOT NULL,
  environment text NOT NULL CHECK (environment IN ('DISABLED', 'FORK_WRITE', 'TESTNET_WRITE')),
  health_state text NOT NULL CHECK (health_state IN ('HEALTHY', 'DEGRADED', 'UNAVAILABLE')),
  intent_hash text,
  snapshot_hash text,
  event_code text,
  payload jsonb NOT NULL,
  created_at timestamptz NOT NULL
);

-- egress:statement
CREATE INDEX IF NOT EXISTS egress_execution_intents_snapshot_time_idx
  ON egress_execution_staging_intents (snapshot_hash, created_at DESC);

-- egress:statement
CREATE INDEX IF NOT EXISTS egress_execution_intents_environment_time_idx
  ON egress_execution_staging_intents (environment, created_at DESC);

-- egress:statement
CREATE INDEX IF NOT EXISTS egress_execution_intents_chain_block_idx
  ON egress_execution_staging_intents (chain_id, observed_block DESC, created_at DESC);

-- egress:statement
CREATE UNIQUE INDEX IF NOT EXISTS egress_execution_intents_request_hash_idx
  ON egress_execution_staging_intents (request_hash);

-- egress:statement
CREATE INDEX IF NOT EXISTS egress_execution_simulations_status_time_idx
  ON egress_execution_staging_simulations (simulation_status, created_at DESC);

-- egress:statement
CREATE INDEX IF NOT EXISTS egress_execution_submissions_status_time_idx
  ON egress_execution_staging_submissions (submission_status, created_at DESC);

-- egress:statement
CREATE INDEX IF NOT EXISTS egress_execution_worker_events_state_time_idx
  ON egress_execution_worker_events (health_state, created_at DESC);

-- egress:statement
CREATE INDEX IF NOT EXISTS egress_execution_worker_events_type_time_idx
  ON egress_execution_worker_events (event_type, created_at DESC);
