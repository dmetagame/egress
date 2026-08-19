import { neon } from "@neondatabase/serverless";
import { validateDatabaseMigrations, type DatabaseQueryClient } from "../live/database-migrations.js";

const REQUIRED_PRIVILEGES = [
  "schema_usage",
  "read_migrations",
  "read_snapshots",
  "read_source_revisions",
  "read_source_diffs",
  "read_intents",
  "insert_intents",
  "read_simulations",
  "insert_simulations",
  "read_reservations",
  "insert_reservations",
  "read_submissions",
  "insert_submissions",
  "read_worker_events",
  "insert_worker_events",
] as const;

const FORBIDDEN_PRIVILEGES = [
  "superuser",
  "create_database_objects",
  "create_schema_objects",
  "write_migrations",
  "write_live_snapshots",
  "write_live_observations",
  "write_live_alerts",
  "write_alert_deliveries",
  "write_operational_events",
  "write_retention_audit",
  "write_source_revisions",
  "write_source_diffs",
  "mutate_staging_history",
] as const;

const ARCHIVE_REQUIRED_PRIVILEGES = [
  "database_connect",
  "schema_usage",
  "read_migrations",
  "read_snapshots",
  "insert_snapshots",
  "read_snapshot_observations",
  "insert_snapshot_observations",
] as const;

const ARCHIVE_FORBIDDEN_PRIVILEGES = [
  "superuser",
  "create_role",
  "create_database",
  "replication",
  "bypass_rls",
  "create_database_objects",
  "create_schema_objects",
  "database_ownership",
  "schema_ownership",
  "protected_table_ownership",
  "role_memberships",
  "grantable_privileges",
  "read_auth_credentials",
  "write_migrations",
  "update_snapshots",
  "delete_snapshots",
  "truncate_snapshots",
  "update_snapshot_observations",
  "delete_snapshot_observations",
  "truncate_snapshot_observations",
  "read_source_revisions",
  "insert_source_revisions",
  "update_source_revisions",
  "delete_source_revisions",
  "truncate_source_revisions",
  "read_source_diffs",
  "insert_source_diffs",
  "update_source_diffs",
  "delete_source_diffs",
  "truncate_source_diffs",
  "read_execution_staging",
  "insert_execution_staging",
  "update_execution_staging",
  "delete_execution_staging",
  "truncate_execution_staging",
  "access_live_alerts",
  "access_alert_deliveries",
  "access_operational_events",
  "access_retention_audit",
] as const;

export interface ExecutionWorkerDatabasePrivilegeReport {
  roleName: string;
  missingRequired: string[];
  forbiddenGranted: string[];
}

export interface ArchiveDatabasePrivilegeReport {
  roleName: string;
  missingRequired: string[];
  forbiddenGranted: string[];
}

export async function assertExecutionWorkerDatabasePrivileges(
  databaseUrl: string,
): Promise<ExecutionWorkerDatabasePrivilegeReport> {
  if (!databaseUrl.trim()) throw new Error("EGRESS_DATABASE_URL is required for execution staging.");
  const sql = neon(databaseUrl);
  const client: DatabaseQueryClient = {
    query: (queryText, params) => sql.query(queryText, params) as Promise<Record<string, unknown>[]>,
  };
  await validateDatabaseMigrations(client);
  return validateExecutionWorkerDatabasePrivileges(client);
}

export async function validateExecutionWorkerDatabasePrivileges(
  client: DatabaseQueryClient,
): Promise<ExecutionWorkerDatabasePrivilegeReport> {
  const rows = await client.query(EXECUTION_WORKER_PRIVILEGE_QUERY);
  const row = rows[0];
  if (!row) throw new Error("Execution worker database privilege audit returned no role state.");
  const missingRequired = REQUIRED_PRIVILEGES.filter((name) => !booleanValue(row[name]));
  const forbiddenGranted = FORBIDDEN_PRIVILEGES.filter((name) => booleanValue(row[name]));
  const report = {
    roleName: String(row.role_name ?? "unknown"),
    missingRequired: [...missingRequired],
    forbiddenGranted: [...forbiddenGranted],
  };
  if (missingRequired.length > 0 || forbiddenGranted.length > 0) {
    const reasons = [
      missingRequired.length > 0 ? `missing required privileges: ${missingRequired.join(", ")}` : null,
      forbiddenGranted.length > 0 ? `forbidden privileges granted: ${forbiddenGranted.join(", ")}` : null,
    ].filter(Boolean).join("; ");
    throw new Error(`Execution worker PostgreSQL role ${report.roleName} violates the least-privilege boundary (${reasons}).`);
  }
  return report;
}

export async function assertArchiveDatabasePrivileges(
  databaseUrl: string,
): Promise<ArchiveDatabasePrivilegeReport> {
  if (!databaseUrl.trim()) throw new Error("An archive database URL is required for controlled snapshot archiving.");
  const sql = neon(databaseUrl);
  const client: DatabaseQueryClient = {
    query: (queryText, params) => sql.query(queryText, params) as Promise<Record<string, unknown>[]>,
  };
  await validateDatabaseMigrations(client);
  return validateArchiveDatabasePrivileges(client);
}

export async function validateArchiveDatabasePrivileges(
  client: DatabaseQueryClient,
): Promise<ArchiveDatabasePrivilegeReport> {
  const rows = await client.query(ARCHIVE_DATABASE_PRIVILEGE_QUERY);
  const row = rows[0];
  if (!row) throw new Error("Archive database privilege audit returned no role state.");
  const missingRequired = ARCHIVE_REQUIRED_PRIVILEGES.filter((name) => !booleanValue(row[name]));
  const forbiddenGranted = ARCHIVE_FORBIDDEN_PRIVILEGES.filter((name) => booleanValue(row[name]));
  const report = {
    roleName: String(row.role_name ?? "unknown"),
    missingRequired: [...missingRequired],
    forbiddenGranted: [...forbiddenGranted],
  };
  if (missingRequired.length > 0 || forbiddenGranted.length > 0) {
    const reasons = [
      missingRequired.length > 0 ? `missing required privileges: ${missingRequired.join(", ")}` : null,
      forbiddenGranted.length > 0 ? `forbidden privileges granted: ${forbiddenGranted.join(", ")}` : null,
    ].filter(Boolean).join("; ");
    throw new Error(`Archive PostgreSQL role ${report.roleName} violates the least-privilege boundary (${reasons}).`);
  }
  return report;
}

const writePrivilege = (table: string) => `(
  has_table_privilege(current_user, 'public.${table}', 'INSERT') OR
  has_table_privilege(current_user, 'public.${table}', 'UPDATE') OR
  has_table_privilege(current_user, 'public.${table}', 'DELETE') OR
  has_table_privilege(current_user, 'public.${table}', 'TRUNCATE')
)`;

const stagingMutationPrivilege = (table: string) => `(
  has_table_privilege(current_user, 'public.${table}', 'UPDATE') OR
  has_table_privilege(current_user, 'public.${table}', 'DELETE') OR
  has_table_privilege(current_user, 'public.${table}', 'TRUNCATE')
)`;

const tableSelectPrivilege = (table: string) => `(
  has_table_privilege(current_user, '${table}', 'SELECT') OR
  has_any_column_privilege(current_user, '${table}', 'SELECT')
)`;

const tableInsertPrivilege = (table: string) => `(
  has_table_privilege(current_user, '${table}', 'INSERT') OR
  has_any_column_privilege(current_user, '${table}', 'INSERT')
)`;

const tableUpdatePrivilege = (table: string) => `(
  has_table_privilege(current_user, '${table}', 'UPDATE') OR
  has_any_column_privilege(current_user, '${table}', 'UPDATE')
)`;

const tableDeletePrivilege = (table: string) =>
  `has_table_privilege(current_user, '${table}', 'DELETE')`;

const tableTruncatePrivilege = (table: string) =>
  `has_table_privilege(current_user, '${table}', 'TRUNCATE')`;

const tableWritePrivilege = (table: string) => `(
  ${tableInsertPrivilege(table)} OR
  ${tableUpdatePrivilege(table)} OR
  ${tableDeletePrivilege(table)} OR
  ${tableTruncatePrivilege(table)}
)`;

const tableAnyPrivilege = (table: string) => `(
  ${tableSelectPrivilege(table)} OR
  ${tableInsertPrivilege(table)} OR
  ${tableUpdatePrivilege(table)} OR
  ${tableDeletePrivilege(table)} OR
  ${tableTruncatePrivilege(table)} OR
  has_table_privilege(current_user, '${table}', 'REFERENCES') OR
  has_any_column_privilege(current_user, '${table}', 'REFERENCES') OR
  has_table_privilege(current_user, '${table}', 'TRIGGER')
)`;

const anyTablePrivilege = (
  tables: readonly string[],
  privilege: (table: string) => string,
) => `(${tables.map((table) => privilege(`public.${table}`)).join(" OR\n")})`;

const EXECUTION_STAGING_TABLES = [
  "egress_execution_staging_intents",
  "egress_execution_staging_simulations",
  "egress_execution_staging_submission_reservations",
  "egress_execution_staging_submissions",
  "egress_execution_worker_events",
] as const;

const EXECUTION_WORKER_PRIVILEGE_QUERY = `SELECT
  current_user AS role_name,
  has_schema_privilege(current_user, 'public', 'USAGE') AS schema_usage,
  has_table_privilege(current_user, 'public.egress_schema_migrations', 'SELECT') AS read_migrations,
  has_table_privilege(current_user, 'public.egress_live_snapshots', 'SELECT') AS read_snapshots,
  has_table_privilege(current_user, 'public.egress_rwa_source_revisions', 'SELECT') AS read_source_revisions,
  has_table_privilege(current_user, 'public.egress_rwa_source_diffs', 'SELECT') AS read_source_diffs,
  has_table_privilege(current_user, 'public.egress_execution_staging_intents', 'SELECT') AS read_intents,
  has_table_privilege(current_user, 'public.egress_execution_staging_intents', 'INSERT') AS insert_intents,
  has_table_privilege(current_user, 'public.egress_execution_staging_simulations', 'SELECT') AS read_simulations,
  has_table_privilege(current_user, 'public.egress_execution_staging_simulations', 'INSERT') AS insert_simulations,
  has_table_privilege(current_user, 'public.egress_execution_staging_submission_reservations', 'SELECT') AS read_reservations,
  has_table_privilege(current_user, 'public.egress_execution_staging_submission_reservations', 'INSERT') AS insert_reservations,
  has_table_privilege(current_user, 'public.egress_execution_staging_submissions', 'SELECT') AS read_submissions,
  has_table_privilege(current_user, 'public.egress_execution_staging_submissions', 'INSERT') AS insert_submissions,
  has_table_privilege(current_user, 'public.egress_execution_worker_events', 'SELECT') AS read_worker_events,
  has_table_privilege(current_user, 'public.egress_execution_worker_events', 'INSERT') AS insert_worker_events,
  current_setting('is_superuser') = 'on' AS superuser,
  has_database_privilege(current_user, current_database(), 'CREATE') AS create_database_objects,
  has_schema_privilege(current_user, 'public', 'CREATE') AS create_schema_objects,
  ${tableWritePrivilege("public.egress_schema_migrations")} AS write_migrations,
  ${writePrivilege("egress_live_snapshots")} AS write_live_snapshots,
  ${writePrivilege("egress_live_snapshot_observations")} AS write_live_observations,
  ${writePrivilege("egress_live_alerts")} AS write_live_alerts,
  ${writePrivilege("egress_live_alert_deliveries")} AS write_alert_deliveries,
  ${writePrivilege("egress_live_operational_events")} AS write_operational_events,
  ${writePrivilege("egress_live_retention_audit")} AS write_retention_audit,
  ${writePrivilege("egress_rwa_source_revisions")} AS write_source_revisions,
  ${writePrivilege("egress_rwa_source_diffs")} AS write_source_diffs,
  (
    ${stagingMutationPrivilege("egress_execution_staging_intents")} OR
    ${stagingMutationPrivilege("egress_execution_staging_simulations")} OR
    ${stagingMutationPrivilege("egress_execution_staging_submission_reservations")} OR
    ${stagingMutationPrivilege("egress_execution_staging_submissions")} OR
    ${stagingMutationPrivilege("egress_execution_worker_events")}
  ) AS mutate_staging_history`;

const ARCHIVE_DATABASE_PRIVILEGE_QUERY = `WITH current_role_state AS (
  SELECT oid, rolsuper, rolcreatedb, rolcreaterole, rolreplication, rolbypassrls
  FROM pg_catalog.pg_roles
  WHERE rolname = current_user
)
SELECT
  current_user AS role_name,
  has_database_privilege(current_user, current_database(), 'CONNECT') AS database_connect,
  has_schema_privilege(current_user, 'public', 'USAGE') AS schema_usage,
  has_table_privilege(current_user, 'public.egress_schema_migrations', 'SELECT') AS read_migrations,
  has_table_privilege(current_user, 'public.egress_live_snapshots', 'SELECT') AS read_snapshots,
  has_table_privilege(current_user, 'public.egress_live_snapshots', 'INSERT') AS insert_snapshots,
  has_table_privilege(current_user, 'public.egress_live_snapshot_observations', 'SELECT') AS read_snapshot_observations,
  has_table_privilege(current_user, 'public.egress_live_snapshot_observations', 'INSERT') AS insert_snapshot_observations,
  (SELECT rolsuper FROM current_role_state) AS superuser,
  (SELECT rolcreaterole FROM current_role_state) AS create_role,
  (SELECT rolcreatedb FROM current_role_state) AS create_database,
  (SELECT rolreplication FROM current_role_state) AS replication,
  (SELECT rolbypassrls FROM current_role_state) AS bypass_rls,
  has_database_privilege(current_user, current_database(), 'CREATE') AS create_database_objects,
  has_schema_privilege(current_user, 'public', 'CREATE') AS create_schema_objects,
  EXISTS (
    SELECT 1 FROM pg_catalog.pg_database
    WHERE datname = current_database() AND pg_has_role(current_user, datdba, 'MEMBER')
  ) AS database_ownership,
  EXISTS (
    SELECT 1 FROM pg_catalog.pg_namespace
    WHERE nspname = 'public' AND pg_has_role(current_user, nspowner, 'MEMBER')
  ) AS schema_ownership,
  EXISTS (
    SELECT 1
    FROM pg_catalog.pg_class relation
    JOIN pg_catalog.pg_namespace namespace ON namespace.oid = relation.relnamespace
    WHERE namespace.nspname = 'public'
      AND relation.relname LIKE 'egress_%'
      AND relation.relkind IN ('r', 'p')
      AND pg_has_role(current_user, relation.relowner, 'MEMBER')
  ) AS protected_table_ownership,
  EXISTS (
    SELECT 1 FROM pg_catalog.pg_roles candidate
    WHERE candidate.oid <> (SELECT oid FROM current_role_state)
      AND pg_has_role(current_user, candidate.oid, 'MEMBER')
  ) AS role_memberships,
  (
    EXISTS (
      SELECT 1
      FROM pg_catalog.pg_database database_entry
      CROSS JOIN LATERAL aclexplode(COALESCE(
        database_entry.datacl,
        acldefault('d', database_entry.datdba)
      )) privilege
      WHERE database_entry.datname = current_database()
        AND privilege.grantee = (SELECT oid FROM current_role_state)
        AND privilege.is_grantable
    ) OR
    EXISTS (
      SELECT 1
      FROM pg_catalog.pg_namespace namespace
      CROSS JOIN LATERAL aclexplode(COALESCE(
        namespace.nspacl,
        acldefault('n', namespace.nspowner)
      )) privilege
      WHERE namespace.nspname = 'public'
        AND privilege.grantee = (SELECT oid FROM current_role_state)
        AND privilege.is_grantable
    ) OR
    EXISTS (
      SELECT 1
      FROM pg_catalog.pg_class relation
      JOIN pg_catalog.pg_namespace namespace ON namespace.oid = relation.relnamespace
      CROSS JOIN LATERAL aclexplode(COALESCE(
        relation.relacl,
        acldefault('r', relation.relowner)
      )) privilege
      WHERE namespace.nspname = 'public'
        AND relation.relname LIKE 'egress_%'
        AND relation.relkind IN ('r', 'p')
        AND privilege.grantee = (SELECT oid FROM current_role_state)
        AND privilege.is_grantable
    )
  ) AS grantable_privileges,
  (
    ${tableSelectPrivilege("pg_catalog.pg_authid")} OR
    ${tableSelectPrivilege("pg_catalog.pg_shadow")}
  ) AS read_auth_credentials,
  ${writePrivilege("egress_schema_migrations")} AS write_migrations,
  ${tableUpdatePrivilege("public.egress_live_snapshots")} AS update_snapshots,
  ${tableDeletePrivilege("public.egress_live_snapshots")} AS delete_snapshots,
  ${tableTruncatePrivilege("public.egress_live_snapshots")} AS truncate_snapshots,
  ${tableUpdatePrivilege("public.egress_live_snapshot_observations")} AS update_snapshot_observations,
  ${tableDeletePrivilege("public.egress_live_snapshot_observations")} AS delete_snapshot_observations,
  ${tableTruncatePrivilege("public.egress_live_snapshot_observations")} AS truncate_snapshot_observations,
  ${tableSelectPrivilege("public.egress_rwa_source_revisions")} AS read_source_revisions,
  ${tableInsertPrivilege("public.egress_rwa_source_revisions")} AS insert_source_revisions,
  ${tableUpdatePrivilege("public.egress_rwa_source_revisions")} AS update_source_revisions,
  ${tableDeletePrivilege("public.egress_rwa_source_revisions")} AS delete_source_revisions,
  ${tableTruncatePrivilege("public.egress_rwa_source_revisions")} AS truncate_source_revisions,
  ${tableSelectPrivilege("public.egress_rwa_source_diffs")} AS read_source_diffs,
  ${tableInsertPrivilege("public.egress_rwa_source_diffs")} AS insert_source_diffs,
  ${tableUpdatePrivilege("public.egress_rwa_source_diffs")} AS update_source_diffs,
  ${tableDeletePrivilege("public.egress_rwa_source_diffs")} AS delete_source_diffs,
  ${tableTruncatePrivilege("public.egress_rwa_source_diffs")} AS truncate_source_diffs,
  ${anyTablePrivilege(EXECUTION_STAGING_TABLES, tableSelectPrivilege)} AS read_execution_staging,
  ${anyTablePrivilege(EXECUTION_STAGING_TABLES, tableInsertPrivilege)} AS insert_execution_staging,
  ${anyTablePrivilege(EXECUTION_STAGING_TABLES, tableUpdatePrivilege)} AS update_execution_staging,
  ${anyTablePrivilege(EXECUTION_STAGING_TABLES, tableDeletePrivilege)} AS delete_execution_staging,
  ${anyTablePrivilege(EXECUTION_STAGING_TABLES, tableTruncatePrivilege)} AS truncate_execution_staging,
  ${tableAnyPrivilege("public.egress_live_alerts")} AS access_live_alerts,
  ${tableAnyPrivilege("public.egress_live_alert_deliveries")} AS access_alert_deliveries,
  ${tableAnyPrivilege("public.egress_live_operational_events")} AS access_operational_events,
  ${tableAnyPrivilege("public.egress_live_retention_audit")} AS access_retention_audit`;

function booleanValue(value: unknown): boolean {
  return value === true || value === "t" || value === "true" || value === 1 || value === "1";
}
