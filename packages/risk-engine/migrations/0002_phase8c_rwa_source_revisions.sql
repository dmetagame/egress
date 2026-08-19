CREATE TABLE IF NOT EXISTS egress_rwa_source_revisions (
  revision_id text PRIMARY KEY,
  source_id text NOT NULL,
  source_url text NOT NULL,
  source_version integer NOT NULL CHECK (source_version > 0),
  retrieved_at timestamptz NOT NULL,
  content_hash text NOT NULL,
  raw_content_hash text NOT NULL,
  previous_revision_id text REFERENCES egress_rwa_source_revisions(revision_id),
  diff_id text NOT NULL,
  extraction_status text NOT NULL CHECK (
    extraction_status IN ('PENDING', 'ANALYZED', 'FAILED', 'SKIPPED')
  ),
  payload jsonb NOT NULL,
  created_at timestamptz NOT NULL
);

-- egress:statement
CREATE TABLE IF NOT EXISTS egress_rwa_source_diffs (
  diff_id text PRIMARY KEY,
  source_id text NOT NULL,
  from_revision_id text,
  to_revision_id text NOT NULL REFERENCES egress_rwa_source_revisions(revision_id),
  generated_at timestamptz NOT NULL,
  diff_kind text NOT NULL CHECK (diff_kind IN ('INITIAL', 'CHANGED')),
  cosmetic_only boolean NOT NULL,
  payload jsonb NOT NULL,
  created_at timestamptz NOT NULL
);

-- egress:statement
CREATE UNIQUE INDEX IF NOT EXISTS egress_rwa_source_revisions_source_version_idx
  ON egress_rwa_source_revisions (source_id, source_version);

-- egress:statement
CREATE INDEX IF NOT EXISTS egress_rwa_source_revisions_latest_idx
  ON egress_rwa_source_revisions (source_id, source_version DESC, retrieved_at DESC, revision_id DESC);

-- egress:statement
CREATE INDEX IF NOT EXISTS egress_rwa_source_revisions_content_hash_idx
  ON egress_rwa_source_revisions (source_id, content_hash);

-- egress:statement
CREATE INDEX IF NOT EXISTS egress_rwa_source_revisions_extraction_status_idx
  ON egress_rwa_source_revisions (extraction_status, retrieved_at DESC);

-- egress:statement
CREATE INDEX IF NOT EXISTS egress_rwa_source_diffs_source_time_idx
  ON egress_rwa_source_diffs (source_id, generated_at DESC, diff_id DESC);

-- egress:statement
CREATE INDEX IF NOT EXISTS egress_rwa_source_diffs_revision_idx
  ON egress_rwa_source_diffs (to_revision_id);
