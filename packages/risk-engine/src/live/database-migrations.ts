import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { neon } from "@neondatabase/serverless";

const MIGRATION_DEFINITIONS = [
  {
    version: 1,
    name: "phase8c_observation_operations",
    file: "0001_phase8c_observation_operations.sql",
  },
  {
    version: 2,
    name: "phase8c_rwa_source_revisions",
    file: "0002_phase8c_rwa_source_revisions.sql",
  },
  {
    version: 3,
    name: "phase9_execution_staging",
    file: "0003_phase9_execution_staging.sql",
  },
  {
    version: 4,
    name: "phase10_execution_binding",
    file: "0004_phase10_execution_binding.sql",
  },
] as const;

// Keep each migration URL as a separate static import-time expression. The
// Next/Turbopack server bundler can only trace dynamically read assets
// reliably when their paths are statically discoverable. A template URL based
// on `definition.file` was bundled as one asset in production, causing every
// migration to be checked against migration 0001.
const MIGRATION_ASSET_URLS = {
  1: new URL("../../migrations/0001_phase8c_observation_operations.sql", import.meta.url),
  2: new URL("../../migrations/0002_phase8c_rwa_source_revisions.sql", import.meta.url),
  3: new URL("../../migrations/0003_phase9_execution_staging.sql", import.meta.url),
  4: new URL("../../migrations/0004_phase10_execution_binding.sql", import.meta.url),
} as const;

const MIGRATION_STATEMENT_SEPARATOR = /^-- egress:statement\s*$/m;

export interface DatabaseMigration {
  version: number;
  name: string;
  file: string;
  checksum: string;
  sql: string;
  statements: string[];
}

export interface AppliedDatabaseMigration {
  version: number;
  name: string;
  checksum: string;
  appliedAt: string;
}

export interface DatabaseMigrationStatus {
  expectedVersion: number;
  appliedVersion: number;
  migrations: AppliedDatabaseMigration[];
}

export interface DatabaseMigrationResult extends DatabaseMigrationStatus {
  applied: AppliedDatabaseMigration[];
}

export interface DatabaseQueryClient {
  query(queryText: string, params?: unknown[]): Promise<readonly Record<string, unknown>[]>;
}

export interface DatabaseMigrationStatement {
  queryText: string;
  params?: unknown[];
}

export interface DatabaseMigrationClient extends DatabaseQueryClient {
  runTransaction(statements: readonly DatabaseMigrationStatement[]): Promise<void>;
}

export async function loadDatabaseMigrations(): Promise<DatabaseMigration[]> {
  return Promise.all(MIGRATION_DEFINITIONS.map(async (definition) => {
    const url = MIGRATION_ASSET_URLS[definition.version];
    // `new URL(..., import.meta.url)` is useful for bundler asset tracing, but
    // Node's fs APIs require a filesystem path in the Vercel/Turbopack server
    // runtime. Convert at the boundary so the same validation path works in
    // local Node, CI, and the deployed server bundle.
    const sql = normalizeMigrationSql(await readFile(migrationAssetPath(url), "utf8"));
    return {
      ...definition,
      checksum: migrationChecksum(sql),
      sql,
      statements: splitMigrationStatements(sql),
    };
  }));
}

export function migrationAssetPath(url: { readonly href: string }): string {
  // Next/Turbopack may construct the statically traced URL in a different
  // JavaScript realm from Node's `url` module. Passing that object directly
  // makes `fileURLToPath()` reject it even though it is URL-shaped. The href
  // string is realm-independent and preserves the exact file URL semantics.
  return fileURLToPath(url.href);
}

export async function migrateDatabase(databaseUrl: string): Promise<DatabaseMigrationResult> {
  if (!databaseUrl.trim()) throw new Error("EGRESS_DATABASE_URL is required to run migrations.");
  const sql = neon(databaseUrl);
  return migrateDatabaseWithClient({
    query: (queryText, params) => sql.query(queryText, params) as Promise<DatabaseRow[]>,
    runTransaction: async (statements) => {
      await sql.transaction((transaction) => statements.map((statement) =>
        transaction.query(statement.queryText, statement.params)
      ));
    },
  });
}

export async function migrateDatabaseWithClient(
  client: DatabaseMigrationClient,
  now: () => Date = () => new Date(),
): Promise<DatabaseMigrationResult> {
  await client.query(bootstrapMigrationTableSql());
  const expected = await loadDatabaseMigrations();
  const before = await readAppliedMigrations(client);
  validateAppliedMigrations(expected, before, { allowMissing: true });
  const applied: AppliedDatabaseMigration[] = [];

  for (const migration of expected) {
    if (before.some((entry) => entry.version === migration.version)) continue;
    const appliedAt = now().toISOString();
    await client.runTransaction([
      ...migration.statements.map((queryText) => ({ queryText })),
      {
        queryText: `INSERT INTO egress_schema_migrations (version, name, checksum, applied_at)
          VALUES ($1, $2, $3, $4)`,
        params: [migration.version, migration.name, migration.checksum, appliedAt],
      },
    ]);
    applied.push({
      version: migration.version,
      name: migration.name,
      checksum: migration.checksum,
      appliedAt,
    });
  }

  const status = await validateDatabaseMigrations(client);
  return { ...status, applied };
}

export async function validateDatabaseMigrations(
  client: DatabaseQueryClient,
): Promise<DatabaseMigrationStatus> {
  const expected = await loadDatabaseMigrations();
  let applied: AppliedDatabaseMigration[];
  try {
    applied = await readAppliedMigrations(client);
  } catch (error) {
    throw new Error(
      `PostgreSQL schema is unavailable or unmigrated. Run npm run db:migrate. ${errorMessage(error)}`,
    );
  }
  validateAppliedMigrations(expected, applied, { allowMissing: false });
  return {
    expectedVersion: expected.at(-1)?.version ?? 0,
    appliedVersion: applied.at(-1)?.version ?? 0,
    migrations: applied,
  };
}

export function migrationChecksum(sql: string): string {
  return `sha256:${createHash("sha256").update(normalizeMigrationSql(sql), "utf8").digest("hex")}`;
}

export function splitMigrationStatements(sql: string): string[] {
  return normalizeMigrationSql(sql)
    .split(MIGRATION_STATEMENT_SEPARATOR)
    .map((statement) => statement.trim())
    .filter(Boolean);
}

function normalizeMigrationSql(sql: string): string {
  return `${sql.replace(/\r\n/g, "\n").trim()}\n`;
}

function bootstrapMigrationTableSql(): string {
  return `CREATE TABLE IF NOT EXISTS egress_schema_migrations (
    version integer PRIMARY KEY,
    name text NOT NULL,
    checksum text NOT NULL,
    applied_at timestamptz NOT NULL DEFAULT now()
  )`;
}

async function readAppliedMigrations(
  client: DatabaseQueryClient,
): Promise<AppliedDatabaseMigration[]> {
  const rows = await client.query(
    `SELECT version, name, checksum, applied_at
     FROM egress_schema_migrations
     ORDER BY version ASC`,
  );
  return rows.map((row) => ({
    version: Number(row.version),
    name: String(row.name),
    checksum: String(row.checksum),
    appliedAt: timestampString(row.applied_at),
  }));
}

function validateAppliedMigrations(
  expected: readonly DatabaseMigration[],
  applied: readonly AppliedDatabaseMigration[],
  options: { allowMissing: boolean },
): void {
  const expectedByVersion = new Map(expected.map((migration) => [migration.version, migration]));
  for (const migration of applied) {
    const matching = expectedByVersion.get(migration.version);
    if (!matching) {
      throw new Error(
        `Database migration version ${migration.version} is newer than this Egress runtime.`,
      );
    }
    if (matching.name !== migration.name || matching.checksum !== migration.checksum) {
      throw new Error(
        `Database migration ${migration.version} checksum/name mismatch; refusing to use an ambiguous schema.`,
      );
    }
  }
  if (!options.allowMissing && applied.length !== expected.length) {
    const missing = expected
      .filter((migration) => !applied.some((entry) => entry.version === migration.version))
      .map((migration) => migration.version)
      .join(", ");
    throw new Error(`PostgreSQL schema migration(s) ${missing} are missing. Run npm run db:migrate.`);
  }
}

function timestampString(value: unknown): string {
  if (value instanceof Date) return value.toISOString();
  return new Date(String(value)).toISOString();
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? (error.message.split("\n")[0] ?? error.name) : String(error);
}

type DatabaseRow = Record<string, unknown>;
