import { migrateDatabase } from "../live/database-migrations.js";

const databaseUrl = process.env.EGRESS_DATABASE_URL?.trim();
if (!databaseUrl) {
  console.error(JSON.stringify({
    event: "egress.database.migration_configuration_invalid",
    issue: "EGRESS_DATABASE_URL is required.",
  }));
  process.exitCode = 1;
} else {
  try {
    const result = await migrateDatabase(databaseUrl);
    console.info(JSON.stringify({
      event: "egress.database.migrations_complete",
      expectedVersion: result.expectedVersion,
      appliedVersion: result.appliedVersion,
      applied: result.applied.map(({ version, name, checksum }) => ({ version, name, checksum })),
    }));
  } catch (error) {
    console.error(JSON.stringify({
      event: "egress.database.migrations_failed",
      errorType: error instanceof Error ? error.name : "UnknownError",
      message: error instanceof Error ? error.message.split("\n")[0] : String(error),
    }));
    process.exitCode = 1;
  }
}
