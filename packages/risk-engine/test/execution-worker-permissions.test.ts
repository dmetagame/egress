import { describe, expect, it } from "vitest";
import { validateExecutionWorkerDatabasePrivileges } from "../src/index.js";

describe("execution worker PostgreSQL permissions", () => {
  it("accepts only the append-only least-privilege worker role", async () => {
    const report = await validateExecutionWorkerDatabasePrivileges(clientFor(validRole()));
    expect(report).toEqual({
      roleName: "egress_execution_worker",
      missingRequired: [],
      forbiddenGranted: [],
    });
  });

  it("rejects a role that cannot append staging evidence", async () => {
    await expect(validateExecutionWorkerDatabasePrivileges(clientFor({
      ...validRole(),
      insert_submissions: false,
    }))).rejects.toThrow(/missing required privileges: insert_submissions/i);
  });

  it("rejects canonical-history writes and database administration privileges", async () => {
    await expect(validateExecutionWorkerDatabasePrivileges(clientFor({
      ...validRole(),
      write_live_snapshots: true,
      write_source_revisions: true,
      create_schema_objects: true,
    }))).rejects.toThrow(/forbidden privileges granted:.*create_schema_objects.*write_live_snapshots.*write_source_revisions/i);
  });
});

function clientFor(row: Record<string, unknown>) {
  return { query: async () => [row] };
}

function validRole(): Record<string, unknown> {
  return {
    role_name: "egress_execution_worker",
    schema_usage: true,
    read_migrations: true,
    read_snapshots: true,
    read_source_revisions: true,
    read_source_diffs: true,
    read_intents: true,
    insert_intents: true,
    read_simulations: true,
    insert_simulations: true,
    read_reservations: true,
    insert_reservations: true,
    read_submissions: true,
    insert_submissions: true,
    read_worker_events: true,
    insert_worker_events: true,
    superuser: false,
    create_database_objects: false,
    create_schema_objects: false,
    write_migrations: false,
    write_live_snapshots: false,
    write_live_observations: false,
    write_live_alerts: false,
    write_alert_deliveries: false,
    write_operational_events: false,
    write_retention_audit: false,
    write_source_revisions: false,
    write_source_diffs: false,
    mutate_staging_history: false,
  };
}
