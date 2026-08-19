import { ExecutionStagingConfigError } from "./config.js";

export const PHASE10_LOCAL_ANVIL_RPC = "http://127.0.0.1:8545";

export interface Phase10ForkHarnessConfig {
  upstreamRpcUrl: string | null;
  archiveDatabaseUrl: string | null;
  workerDatabaseUrl: string | null;
  localRpcUrl: typeof PHASE10_LOCAL_ANVIL_RPC;
  issues: string[];
}

/**
 * Phase 10 is a deliberately narrow proof harness. It accepts only a local
 * Anvil fork and two separately credentialed PostgreSQL roles.
 */
export function readPhase10ForkHarnessConfig(
  environment: Readonly<Partial<NodeJS.ProcessEnv>> = process.env,
): Phase10ForkHarnessConfig {
  const issues: string[] = [];
  const executionEnvironment = environment.EGRESS_EXECUTION_ENVIRONMENT?.trim() || "";
  if (executionEnvironment !== "FORK_WRITE") {
    issues.push("Phase 10 requires EGRESS_EXECUTION_ENVIRONMENT=FORK_WRITE.");
  }
  if (!readBoolean(environment.EGRESS_EXECUTION_SUBMISSION_ENABLED, "EGRESS_EXECUTION_SUBMISSION_ENABLED", issues)) {
    issues.push("Phase 10 requires explicit EGRESS_EXECUTION_SUBMISSION_ENABLED=true.");
  }
  if (
    enabled(environment.EGRESS_LIVE_MAINNET_BROADCAST) ||
    enabled(environment.LIVE_MAINNET_BROADCAST) ||
    executionEnvironment === "LIVE_MAINNET_WRITE"
  ) {
    issues.push("LIVE mainnet execution and broadcasting must remain disabled.");
  }
  if (environment.EGRESS_EXECUTION_PRIVATE_KEY?.trim()) {
    issues.push("The pinned Phase 10 fork uses the deterministic local Anvil keeper and must not receive a private key.");
  }

  const upstreamRpcUrl = readUpstreamRpc(environment.EGRESS_XLAYER_FORK_RPC_URL, issues);
  const archiveDatabaseUrl = readDatabaseUrl(
    environment.EGRESS_PHASE10_ARCHIVE_DATABASE_URL,
    "EGRESS_PHASE10_ARCHIVE_DATABASE_URL",
    issues,
  );
  const workerDatabaseUrl = readDatabaseUrl(
    environment.EGRESS_DATABASE_URL,
    "EGRESS_DATABASE_URL",
    issues,
  );
  if (archiveDatabaseUrl && workerDatabaseUrl) {
    const archive = new URL(archiveDatabaseUrl);
    const worker = new URL(workerDatabaseUrl);
    if (archive.toString() === worker.toString() || archive.username === worker.username) {
      issues.push("Phase 10 archive and execution worker PostgreSQL credentials must use distinct roles.");
    }
  }

  const configuredLocalRpc = environment.EGRESS_EXECUTION_RPC_URL?.trim();
  if (configuredLocalRpc) {
    try {
      if (new URL(configuredLocalRpc).toString() !== new URL(PHASE10_LOCAL_ANVIL_RPC).toString()) {
        issues.push(`Phase 10 FORK_WRITE must target ${PHASE10_LOCAL_ANVIL_RPC}.`);
      }
    } catch {
      issues.push("EGRESS_EXECUTION_RPC_URL is not a valid URL.");
    }
  }
  if (environment.EGRESS_EXECUTION_CHAIN_ID?.trim() && environment.EGRESS_EXECUTION_CHAIN_ID.trim() !== "196") {
    issues.push("Phase 10 FORK_WRITE must use X Layer chain 196.");
  }
  if (
    environment.EGRESS_EXECUTION_FORK_RUNTIME?.trim() &&
    environment.EGRESS_EXECUTION_FORK_RUNTIME.trim() !== "ANVIL"
  ) {
    issues.push("Phase 10 FORK_WRITE requires EGRESS_EXECUTION_FORK_RUNTIME=ANVIL.");
  }

  for (const key of Object.keys(environment)) {
    if (
      key.startsWith("NEXT_PUBLIC_") &&
      /(DATABASE_URL|FORK_RPC|EXECUTION_SUBMISSION|PRIVATE_KEY|MNEMONIC|SIGNER)/i.test(key)
    ) {
      issues.push(`${key} is server-only and must not use the NEXT_PUBLIC_ prefix.`);
    }
  }

  return {
    upstreamRpcUrl,
    archiveDatabaseUrl,
    workerDatabaseUrl,
    localRpcUrl: PHASE10_LOCAL_ANVIL_RPC,
    issues: [...new Set(issues)],
  };
}

export function assertPhase10ForkHarnessConfig(
  config: Phase10ForkHarnessConfig,
): asserts config is Phase10ForkHarnessConfig & {
  upstreamRpcUrl: string;
  archiveDatabaseUrl: string;
  workerDatabaseUrl: string;
} {
  if (
    config.issues.length > 0 ||
    !config.upstreamRpcUrl ||
    !config.archiveDatabaseUrl ||
    !config.workerDatabaseUrl
  ) {
    throw new ExecutionStagingConfigError(
      config.issues.join(" ") || "Phase 10 fork harness configuration is incomplete.",
    );
  }
}

function readUpstreamRpc(value: string | undefined, issues: string[]): string | null {
  const raw = value?.trim() || "";
  if (!raw) {
    issues.push("EGRESS_XLAYER_FORK_RPC_URL is required for the pinned X Layer fork.");
    return null;
  }
  try {
    const parsed = new URL(raw);
    const local = parsed.hostname === "127.0.0.1" || parsed.hostname === "localhost";
    if (parsed.protocol !== "https:" || local) {
      issues.push("EGRESS_XLAYER_FORK_RPC_URL must be a non-local HTTPS X Layer RPC endpoint.");
    }
    if (parsed.username || parsed.password) {
      issues.push("EGRESS_XLAYER_FORK_RPC_URL must not contain embedded basic-auth credentials.");
    }
    return parsed.toString();
  } catch {
    issues.push("EGRESS_XLAYER_FORK_RPC_URL is not a valid URL.");
    return null;
  }
}

function readDatabaseUrl(
  value: string | undefined,
  key: string,
  issues: string[],
): string | null {
  const raw = value?.trim() || "";
  if (!raw) {
    issues.push(`${key} is required for the Phase 10 PostgreSQL path.`);
    return null;
  }
  try {
    const parsed = new URL(raw);
    if (parsed.protocol !== "postgres:" && parsed.protocol !== "postgresql:") {
      issues.push(`${key} must use the PostgreSQL URL scheme.`);
    }
    if (!parsed.username) issues.push(`${key} must identify an explicit PostgreSQL role.`);
    if (!parsed.pathname || parsed.pathname === "/") {
      issues.push(`${key} must identify an explicit PostgreSQL database.`);
    }
    return parsed.toString();
  } catch {
    issues.push(`${key} is not a valid PostgreSQL URL.`);
    return null;
  }
}

function readBoolean(value: string | undefined, key: string, issues: string[]): boolean {
  const raw = value?.trim().toLowerCase();
  if (raw === "true") return true;
  if (!raw || raw === "false") return false;
  issues.push(`${key} must be true or false.`);
  return false;
}

function enabled(value: string | undefined): boolean {
  return ["1", "true", "yes", "on"].includes(value?.trim().toLowerCase() ?? "");
}
