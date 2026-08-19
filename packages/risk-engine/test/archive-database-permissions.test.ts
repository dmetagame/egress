import { describe, expect, it } from "vitest";
import { validateArchiveDatabasePrivileges } from "../src/index.js";

describe("archive PostgreSQL permissions", () => {
  it("accepts only the snapshot-append least-privilege archive role", async () => {
    const report = await validateArchiveDatabasePrivileges(clientFor(validRole()));
    expect(report).toEqual({
      roleName: "egress_phase11_archive",
      missingRequired: [],
      forbiddenGranted: [],
    });
  });

  it("rejects a role that cannot append or read snapshot observations", async () => {
    await expect(validateArchiveDatabasePrivileges(clientFor({
      ...validRole(),
      read_snapshot_observations: false,
      insert_snapshot_observations: false,
    }))).rejects.toThrow(
      /missing required privileges: read_snapshot_observations, insert_snapshot_observations/i,
    );
  });

  it("rejects canonical mutation, source-history access, and execution-staging access", async () => {
    await expect(validateArchiveDatabasePrivileges(clientFor({
      ...validRole(),
      update_snapshots: true,
      insert_source_revisions: true,
      read_execution_staging: true,
    }))).rejects.toThrow(
      /forbidden privileges granted:.*update_snapshots.*insert_source_revisions.*read_execution_staging/i,
    );
  });

  it("rejects role administration, ownership, grant options, and credential-catalog access", async () => {
    await expect(validateArchiveDatabasePrivileges(clientFor({
      ...validRole(),
      create_role: true,
      protected_table_ownership: true,
      grantable_privileges: true,
      read_auth_credentials: true,
    }))).rejects.toThrow(
      /forbidden privileges granted:.*create_role.*protected_table_ownership.*grantable_privileges.*read_auth_credentials/i,
    );
  });
});

function clientFor(row: Record<string, unknown>) {
  return { query: async () => [row] };
}

function validRole(): Record<string, unknown> {
  return {
    role_name: "egress_phase11_archive",
    database_connect: true,
    schema_usage: true,
    read_migrations: true,
    read_snapshots: true,
    insert_snapshots: true,
    read_snapshot_observations: true,
    insert_snapshot_observations: true,
    superuser: false,
    create_role: false,
    create_database: false,
    replication: false,
    bypass_rls: false,
    create_database_objects: false,
    create_schema_objects: false,
    database_ownership: false,
    schema_ownership: false,
    protected_table_ownership: false,
    role_memberships: false,
    grantable_privileges: false,
    read_auth_credentials: false,
    write_migrations: false,
    update_snapshots: false,
    delete_snapshots: false,
    truncate_snapshots: false,
    update_snapshot_observations: false,
    delete_snapshot_observations: false,
    truncate_snapshot_observations: false,
    read_source_revisions: false,
    insert_source_revisions: false,
    update_source_revisions: false,
    delete_source_revisions: false,
    truncate_source_revisions: false,
    read_source_diffs: false,
    insert_source_diffs: false,
    update_source_diffs: false,
    delete_source_diffs: false,
    truncate_source_diffs: false,
    read_execution_staging: false,
    insert_execution_staging: false,
    update_execution_staging: false,
    delete_execution_staging: false,
    truncate_execution_staging: false,
    access_live_alerts: false,
    access_alert_deliveries: false,
    access_operational_events: false,
    access_retention_audit: false,
  };
}
