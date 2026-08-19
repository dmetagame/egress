export const ARCHIVE_PRIVILEGE_TEST_ACKNOWLEDGEMENT =
  "I_UNDERSTAND_THIS_IS_A_DEDICATED_TEST_DATABASE";

export interface ArchivePrivilegeTestConfig {
  databaseUrl: string;
  databaseName: string;
}

export function archivePrivilegeTestRequested(
  environment: NodeJS.ProcessEnv,
): boolean {
  return Boolean(
    environment.EGRESS_ARCHIVE_PRIVILEGE_TEST_DATABASE_URL?.trim() ||
      environment.EGRESS_ARCHIVE_PRIVILEGE_TEST_ACKNOWLEDGE?.trim(),
  );
}

export function resolveArchivePrivilegeTestConfig(
  environment: NodeJS.ProcessEnv,
): ArchivePrivilegeTestConfig | null {
  const databaseUrl = environment.EGRESS_ARCHIVE_PRIVILEGE_TEST_DATABASE_URL?.trim() ?? "";
  const acknowledgement = environment.EGRESS_ARCHIVE_PRIVILEGE_TEST_ACKNOWLEDGE?.trim() ?? "";
  if (!databaseUrl && !acknowledgement) return null;
  if (!databaseUrl || !acknowledgement) {
    throw new Error("Archive privilege testing requires both dedicated test database variables.");
  }
  if (acknowledgement !== ARCHIVE_PRIVILEGE_TEST_ACKNOWLEDGEMENT) {
    throw new Error("Archive privilege test acknowledgement is invalid.");
  }

  let parsed: URL;
  try {
    parsed = new URL(databaseUrl);
  } catch {
    throw new Error("Archive privilege test database URL is invalid.");
  }
  if (parsed.protocol !== "postgresql:" && parsed.protocol !== "postgres:") {
    throw new Error("Archive privilege test database URL must use PostgreSQL.");
  }
  const databaseName = decodeURIComponent(parsed.pathname.replace(/^\//, "")).trim();
  if (!databaseName) throw new Error("Archive privilege test database name is missing.");

  const targetIdentity = `${parsed.username} ${parsed.hostname} ${databaseName}`.toLowerCase();
  if (/(?:^|[\s._-])(prod|production|mainnet|live)(?:$|[\s._-])/.test(targetIdentity)) {
    throw new Error("Archive privilege tests refuse production-like database targets.");
  }
  if (!/(?:^|[_-])(test|testing|ci|sandbox|staging|phase10|phase11)(?:$|[_-])/.test(databaseName.toLowerCase())) {
    throw new Error("Archive privilege test database name must explicitly identify a test scope.");
  }

  const runtimeUrls = [
    environment.EGRESS_DATABASE_URL,
    environment.EGRESS_PHASE10_ARCHIVE_DATABASE_URL,
    environment.EGRESS_PHASE11_ARCHIVE_DATABASE_URL,
  ].map((value) => value?.trim()).filter((value): value is string => Boolean(value));
  if (runtimeUrls.includes(databaseUrl)) {
    throw new Error("Archive privilege tests must not reuse a configured runtime database credential.");
  }
  return { databaseUrl, databaseName };
}
