ALTER TABLE egress_execution_staging_submission_reservations
  ADD COLUMN IF NOT EXISTS simulation_hash text REFERENCES egress_execution_staging_simulations(simulation_hash),
  ADD COLUMN IF NOT EXISTS execution_fingerprint text,
  ADD COLUMN IF NOT EXISTS transaction_binding jsonb,
  ADD CONSTRAINT egress_execution_reservation_binding_check CHECK (
    (simulation_hash IS NULL AND execution_fingerprint IS NULL AND transaction_binding IS NULL)
    OR (simulation_hash IS NOT NULL AND execution_fingerprint IS NOT NULL AND transaction_binding IS NOT NULL)
  );

-- egress:statement
ALTER TABLE egress_execution_staging_submissions
  ADD COLUMN IF NOT EXISTS simulation_hash text REFERENCES egress_execution_staging_simulations(simulation_hash),
  ADD COLUMN IF NOT EXISTS execution_fingerprint text,
  ADD COLUMN IF NOT EXISTS transaction_binding jsonb,
  ADD CONSTRAINT egress_execution_submission_binding_check CHECK (
    (simulation_hash IS NULL AND execution_fingerprint IS NULL AND transaction_binding IS NULL)
    OR (simulation_hash IS NOT NULL AND execution_fingerprint IS NOT NULL AND transaction_binding IS NOT NULL)
  );

-- egress:statement
CREATE UNIQUE INDEX IF NOT EXISTS egress_execution_reservations_fingerprint_idx
  ON egress_execution_staging_submission_reservations (execution_fingerprint)
  WHERE execution_fingerprint IS NOT NULL;

-- egress:statement
CREATE UNIQUE INDEX IF NOT EXISTS egress_execution_submissions_fingerprint_idx
  ON egress_execution_staging_submissions (execution_fingerprint)
  WHERE execution_fingerprint IS NOT NULL;
