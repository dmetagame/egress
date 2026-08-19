import { ExecutionStagingConfigError } from "./config.js";
import {
  XLAYER_TESTNET_CHAIN_ID,
  XLAYER_TESTNET_ENVIRONMENT_ID,
} from "./testnet-deployment.js";

export interface Phase11TestnetHarnessConfig {
  rpcUrl: string | null;
  archiveDatabaseUrl: string | null;
  workerDatabaseUrl: string | null;
  manifestPath: string | null;
  manifestHash: `0x${string}` | null;
  credentialReference: string | null;
  privateKeyConfigured: boolean;
  chainId: number | null;
  issues: string[];
}

/**
 * The Phase 11 harness is a one-worker, chain-1952 proof boundary. It never
 * returns secret material; the private key is only inspected for presence.
 */
export function readPhase11TestnetHarnessConfig(
  environment: Readonly<Partial<NodeJS.ProcessEnv>> = process.env,
): Phase11TestnetHarnessConfig {
  const issues: string[] = [];
  const executionEnvironment = environment.EGRESS_EXECUTION_ENVIRONMENT?.trim() || "";
  if (executionEnvironment !== "TESTNET_WRITE") {
    issues.push("Phase 11 requires EGRESS_EXECUTION_ENVIRONMENT=TESTNET_WRITE.");
  }
  if (enabled(environment.EGRESS_LIVE_MAINNET_BROADCAST) || enabled(environment.LIVE_MAINNET_BROADCAST)) {
    issues.push("LIVE mainnet execution and broadcasting must remain disabled.");
  }
  if (environment.EGRESS_EXECUTION_ENVIRONMENT?.trim() === "LIVE_MAINNET_WRITE") {
    issues.push("LIVE_MAINNET_WRITE is unsupported and must remain disabled.");
  }
  if (environment.EGRESS_PHASE11_DEPLOYER_PRIVATE_KEY?.trim()) {
    issues.push("EGRESS_PHASE11_DEPLOYER_PRIVATE_KEY must not be present in the isolated Phase 11 worker environment.");
  }

  const rpcUrl = readRpc(environment.EGRESS_EXECUTION_RPC_URL, issues);
  const chainId = readInteger(environment.EGRESS_EXECUTION_CHAIN_ID, issues);
  if (chainId !== XLAYER_TESTNET_CHAIN_ID) {
    issues.push(`Phase 11 requires chain ${XLAYER_TESTNET_CHAIN_ID}.`);
  }
  const archiveDatabaseUrl = readDatabase(environment.EGRESS_PHASE11_ARCHIVE_DATABASE_URL, "EGRESS_PHASE11_ARCHIVE_DATABASE_URL", issues);
  const workerDatabaseUrl = readDatabase(environment.EGRESS_DATABASE_URL, "EGRESS_DATABASE_URL", issues);
  if (archiveDatabaseUrl && workerDatabaseUrl) {
    const archive = new URL(archiveDatabaseUrl);
    const worker = new URL(workerDatabaseUrl);
    if (archive.username === worker.username || archive.toString() === worker.toString()) {
      issues.push("Phase 11 archive and execution worker database roles must be distinct.");
    }
  }
  const manifestPath = environment.EGRESS_EXECUTION_TESTNET_MANIFEST_PATH?.trim() || null;
  if (!manifestPath) issues.push("EGRESS_EXECUTION_TESTNET_MANIFEST_PATH is required.");
  const manifestHash = readHash(environment.EGRESS_EXECUTION_TESTNET_MANIFEST_HASH, issues);
  const environmentId = environment.EGRESS_EXECUTION_ENVIRONMENT_ID?.trim() || "";
  if (environmentId !== XLAYER_TESTNET_ENVIRONMENT_ID) {
    issues.push(`EGRESS_EXECUTION_ENVIRONMENT_ID must be ${XLAYER_TESTNET_ENVIRONMENT_ID}.`);
  }
  const credentialReference = environment.EGRESS_EXECUTION_CREDENTIAL_REFERENCE?.trim() || null;
  if (!credentialReference) issues.push("EGRESS_EXECUTION_CREDENTIAL_REFERENCE is required.");
  const privateKeyConfigured = Boolean(environment.EGRESS_EXECUTION_PRIVATE_KEY?.trim());
  if (enabled(environment.EGRESS_EXECUTION_SUBMISSION_ENABLED) && !privateKeyConfigured) {
    issues.push("An isolated execution private key is required when testnet submission is explicitly enabled.");
  }
  for (const key of Object.keys(environment)) {
    if (key.startsWith("NEXT_PUBLIC_") && /(PRIVATE_KEY|MNEMONIC|SIGNER|DATABASE_URL|CREDENTIAL)/i.test(key)) {
      issues.push(`${key} is server-only and must not use the NEXT_PUBLIC_ prefix.`);
    }
  }
  return {
    rpcUrl,
    archiveDatabaseUrl,
    workerDatabaseUrl,
    manifestPath,
    manifestHash,
    credentialReference,
    privateKeyConfigured,
    chainId,
    issues: [...new Set(issues)],
  };
}

export function assertPhase11TestnetHarnessConfig(
  config: Phase11TestnetHarnessConfig,
): asserts config is Phase11TestnetHarnessConfig & {
  rpcUrl: string;
  archiveDatabaseUrl: string;
  workerDatabaseUrl: string;
  manifestPath: string;
  manifestHash: `0x${string}`;
  credentialReference: string;
} {
  if (
    config.issues.length > 0 ||
    !config.rpcUrl ||
    !config.archiveDatabaseUrl ||
    !config.workerDatabaseUrl ||
    !config.manifestPath ||
    !config.manifestHash ||
    !config.credentialReference
  ) {
    throw new ExecutionStagingConfigError(
      config.issues.join(" ") || "Phase 11 testnet harness configuration is incomplete.",
    );
  }
}

function readRpc(value: string | undefined, issues: string[]): string | null {
  const raw = value?.trim() || "";
  if (!raw) {
    issues.push("EGRESS_EXECUTION_RPC_URL is required for Phase 11.");
    return null;
  }
  try {
    const parsed = new URL(raw);
    if (parsed.protocol !== "https:" || parsed.hostname === "localhost" || parsed.hostname === "127.0.0.1") {
      issues.push("Phase 11 RPC must be a non-local HTTPS endpoint.");
    }
    if (parsed.username || parsed.password) issues.push("Phase 11 RPC must not contain embedded credentials.");
    return parsed.toString();
  } catch {
    issues.push("EGRESS_EXECUTION_RPC_URL is not a valid URL.");
    return null;
  }
}

function readDatabase(value: string | undefined, key: string, issues: string[]): string | null {
  const raw = value?.trim() || "";
  if (!raw) {
    issues.push(`${key} is required for Phase 11 PostgreSQL evidence.`);
    return null;
  }
  try {
    const parsed = new URL(raw);
    if (parsed.protocol !== "postgres:" && parsed.protocol !== "postgresql:") issues.push(`${key} must use PostgreSQL.`);
    if (!parsed.username || !parsed.pathname || parsed.pathname === "/") issues.push(`${key} must identify a role and database.`);
    return parsed.toString();
  } catch {
    issues.push(`${key} is not a valid PostgreSQL URL.`);
    return null;
  }
}

function readInteger(value: string | undefined, issues: string[]): number | null {
  const raw = value?.trim() || "";
  const parsed = Number(raw);
  if (!raw || !Number.isInteger(parsed) || parsed <= 0) {
    issues.push("EGRESS_EXECUTION_CHAIN_ID must be a positive integer.");
    return null;
  }
  return parsed;
}

function readHash(value: string | undefined, issues: string[]): `0x${string}` | null {
  const raw = value?.trim() || "";
  if (!/^0x[0-9a-fA-F]{64}$/.test(raw)) {
    issues.push("EGRESS_EXECUTION_TESTNET_MANIFEST_HASH must be a 32-byte hex value.");
    return null;
  }
  return raw as `0x${string}`;
}

function enabled(value: string | undefined): boolean {
  return ["1", "true", "yes", "on"].includes(value?.trim().toLowerCase() ?? "");
}
