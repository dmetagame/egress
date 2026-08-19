import { resolve } from "node:path";
import { isAddress, type Address, type Hex } from "viem";
import { XLAYER_MAINNET } from "../market/config.js";
import { PostgresRevisionStore } from "../sources/postgres-store.js";
import { JsonFileStore, type RevisionStore } from "../sources/store.js";
import { FilesystemLiveSnapshotArchive } from "./filesystem-archive.js";
import { PostgresLiveSnapshotArchive } from "./postgres-archive.js";
import type { LiveOperationalArchive } from "./operations.js";
import {
  ConsoleAlertSink,
  LiveAlertDeliveryService,
  WebhookAlertSink,
  type AlertSink,
} from "./alert-delivery.js";

export interface LivePublicRuntimeConfig {
  runtimeMode: "LIVE_READ_ONLY";
  chainId: 196;
  broadcastPermitted: false;
  transactionSubmitted: false;
  liveMainnetExecution: "DISABLED";
}

export interface LiveRuntimeConfig {
  public: LivePublicRuntimeConfig;
  rpcUrl: string;
  rpcUrls: string[];
  account: Address | null;
  egressSpender?: Address;
  maxBlockAgeSeconds?: number;
  observationBlockNumber?: bigint;
  observationBlockHash?: Hex;
  maxOracleAgeSeconds?: number;
  maxSourceAgeSeconds?: number;
  riskStorePath: string;
  archivePath: string;
  databaseUrl?: string;
  hostedRuntime: boolean;
  inlinePollingPermitted: boolean;
  pollIntervalSeconds: number;
  pollReadTimeoutMs: number;
  pollArchiveTimeoutMs: number;
  pollMaxAttempts: number;
  pollRetryBackoffMs: number;
  pollMaxRetryBackoffMs: number;
  pollFailureThreshold: number;
  alertDelivery: {
    consoleEnabled: boolean;
    webhookUrl?: string;
    webhookSecret?: string;
    webhookSinkId?: string;
    timeoutMs: number;
    maxAttemptsPerRun: number;
    maxTotalAttempts: number;
    retryBackoffMs: number;
    maxRetryBackoffMs: number;
    leaseMs: number;
  };
  issues: string[];
}

export function readLiveRuntimeConfig(
  environment: Readonly<Partial<NodeJS.ProcessEnv>> = process.env,
  cwd = process.cwd(),
): LiveRuntimeConfig {
  const issues: string[] = [];
  const runtimeMode = environment.EGRESS_RUNTIME_MODE?.trim() || "LIVE_READ_ONLY";
  if (runtimeMode !== "LIVE_READ_ONLY") {
    issues.push("EGRESS_RUNTIME_MODE must be LIVE_READ_ONLY for the production observation service.");
  }
  if (
    enabledBoolean(environment.EGRESS_LIVE_MAINNET_BROADCAST) ||
    enabledBoolean(environment.LIVE_MAINNET_BROADCAST)
  ) {
    issues.push("LIVE_MAINNET_BROADCAST must remain disabled.");
  }
  for (const key of Object.keys(environment)) {
    if (/(PRIVATE_?KEY|MNEMONIC|SIGNER)/i.test(key) && environment[key]?.trim()) {
      issues.push(`${key} must not be present in the observation or web runtime.`);
    }
  }
  for (const key of Object.keys(environment)) {
    if (
      key.startsWith("NEXT_PUBLIC_") &&
      /(DATABASE_URL|WEBHOOK_SECRET|PRIVATE_?KEY|MNEMONIC|SIGNER|CREDENTIAL)/i.test(key)
    ) {
      issues.push(`${key} is server-only and must not use the NEXT_PUBLIC_ prefix.`);
    }
  }
  const rpcUrls = readRpcUrls(environment, issues);
  const rpcUrl = rpcUrls[0] ?? XLAYER_MAINNET.rpcUrl;

  const accountValue = environment.EGRESS_LIVE_ACCOUNT?.trim() || "";
  const account = accountValue ? (isAddress(accountValue) ? accountValue : null) : null;
  if (accountValue && !account) issues.push("EGRESS_LIVE_ACCOUNT is not a valid EVM address.");

  const spenderValue = environment.EGRESS_LIVE_EGRESS_SPENDER?.trim() || "";
  const egressSpender = spenderValue && isAddress(spenderValue) ? spenderValue : undefined;
  if (spenderValue && !egressSpender) {
    issues.push("EGRESS_LIVE_EGRESS_SPENDER is not a valid EVM address.");
  }

  const configuredStorePath = environment.EGRESS_RISK_STORE_PATH?.trim();
  const riskStorePath = configuredStorePath
    ? resolve(configuredStorePath)
    : resolve(cwd, ".data", "egress-risk.json");
  const configuredArchivePath = environment.EGRESS_LIVE_ARCHIVE_PATH?.trim();
  const archivePath = configuredArchivePath
    ? resolve(configuredArchivePath)
    : resolve(cwd, ".data", "live-archive");
  const databaseUrl = environment.EGRESS_DATABASE_URL?.trim() || undefined;
  if (databaseUrl && !/^postgres(?:ql)?:\/\//i.test(databaseUrl)) {
    issues.push("EGRESS_DATABASE_URL must use the PostgreSQL URL scheme.");
  }
  const hostedRuntime = Boolean(environment.VERCEL) || environment.EGRESS_DEPLOYMENT_ENV === "production";
  if (hostedRuntime && !databaseUrl) {
    issues.push("EGRESS_DATABASE_URL is required for durable archiving on hosted production.");
  }
  const inlinePollingPermitted = readBoolean(
    environment.EGRESS_WEB_INLINE_POLLING,
    !hostedRuntime,
    "EGRESS_WEB_INLINE_POLLING",
    issues,
  );
  if (hostedRuntime && inlinePollingPermitted) {
    issues.push("EGRESS_WEB_INLINE_POLLING must be false on hosted production; the persistent worker owns polling.");
  }

  const observationBlockNumber = readPositiveBigInt(
    environment.EGRESS_LIVE_OBSERVATION_BLOCK,
    "EGRESS_LIVE_OBSERVATION_BLOCK",
    issues,
  );
  const observationHashValue = environment.EGRESS_LIVE_OBSERVATION_BLOCK_HASH?.trim() || "";
  const observationBlockHash = /^0x[0-9a-fA-F]{64}$/.test(observationHashValue)
    ? observationHashValue as Hex
    : undefined;
  if (observationHashValue && !observationBlockHash) {
    issues.push("EGRESS_LIVE_OBSERVATION_BLOCK_HASH must be a 32-byte hex value.");
  }
  if (observationBlockHash && observationBlockNumber === undefined) {
    issues.push("EGRESS_LIVE_OBSERVATION_BLOCK_HASH requires EGRESS_LIVE_OBSERVATION_BLOCK.");
  }

  const pollIntervalSeconds = readPositiveInteger(
    environment.EGRESS_LIVE_POLL_INTERVAL_SECONDS,
    "EGRESS_LIVE_POLL_INTERVAL_SECONDS",
    issues,
  ) ?? 300;
  if (pollIntervalSeconds < 60) {
    issues.push("EGRESS_LIVE_POLL_INTERVAL_SECONDS must be at least 60 seconds.");
  }

  const pollReadTimeoutMs = readBoundedInteger(
    environment.EGRESS_LIVE_POLL_READ_TIMEOUT_MS,
    "EGRESS_LIVE_POLL_READ_TIMEOUT_MS",
    1_000,
    300_000,
    120_000,
    issues,
  );
  const pollArchiveTimeoutMs = readBoundedInteger(
    environment.EGRESS_LIVE_POLL_ARCHIVE_TIMEOUT_MS,
    "EGRESS_LIVE_POLL_ARCHIVE_TIMEOUT_MS",
    1_000,
    120_000,
    30_000,
    issues,
  );
  const pollMaxAttempts = readBoundedInteger(
    environment.EGRESS_LIVE_POLL_MAX_ATTEMPTS,
    "EGRESS_LIVE_POLL_MAX_ATTEMPTS",
    1,
    5,
    2,
    issues,
  );
  const pollRetryBackoffMs = readBoundedInteger(
    environment.EGRESS_LIVE_POLL_RETRY_BACKOFF_MS,
    "EGRESS_LIVE_POLL_RETRY_BACKOFF_MS",
    0,
    30_000,
    500,
    issues,
  );
  const pollMaxRetryBackoffMs = readBoundedInteger(
    environment.EGRESS_LIVE_POLL_MAX_RETRY_BACKOFF_MS,
    "EGRESS_LIVE_POLL_MAX_RETRY_BACKOFF_MS",
    pollRetryBackoffMs,
    60_000,
    5_000,
    issues,
  );
  const pollFailureThreshold = readBoundedInteger(
    environment.EGRESS_LIVE_POLL_FAILURE_THRESHOLD,
    "EGRESS_LIVE_POLL_FAILURE_THRESHOLD",
    1,
    20,
    3,
    issues,
  );

  const webhookUrlValue = environment.EGRESS_ALERT_WEBHOOK_URL?.trim() || "";
  const webhookSecret = environment.EGRESS_ALERT_WEBHOOK_SECRET?.trim() || undefined;
  let webhookUrl: string | undefined;
  if (webhookUrlValue) {
    try {
      const parsed = new URL(webhookUrlValue);
      const local = parsed.hostname === "127.0.0.1" || parsed.hostname === "localhost";
      if (parsed.username || parsed.password) {
        issues.push("EGRESS_ALERT_WEBHOOK_URL must not contain embedded credentials.");
      } else if (parsed.protocol !== "https:" && !(parsed.protocol === "http:" && local)) {
        issues.push("EGRESS_ALERT_WEBHOOK_URL must use HTTPS unless it targets a local test runtime.");
      } else {
        webhookUrl = parsed.toString();
      }
    } catch {
      issues.push("EGRESS_ALERT_WEBHOOK_URL is not a valid URL.");
    }
  }
  if (webhookUrl && !webhookSecret) {
    issues.push("EGRESS_ALERT_WEBHOOK_SECRET is required when EGRESS_ALERT_WEBHOOK_URL is configured.");
  }
  if (webhookSecret && !webhookUrl) {
    issues.push("EGRESS_ALERT_WEBHOOK_URL is required when EGRESS_ALERT_WEBHOOK_SECRET is configured.");
  }
  if (webhookSecret && webhookSecret.length < 32) {
    issues.push("EGRESS_ALERT_WEBHOOK_SECRET must contain at least 32 characters.");
  }
  const webhookSinkId = environment.EGRESS_ALERT_WEBHOOK_SINK_ID?.trim() || undefined;
  if (webhookSinkId && !/^[a-zA-Z0-9_.:-]{1,80}$/.test(webhookSinkId)) {
    issues.push("EGRESS_ALERT_WEBHOOK_SINK_ID contains unsupported characters.");
  }
  const alertTimeoutMs = readBoundedInteger(
    environment.EGRESS_ALERT_DELIVERY_TIMEOUT_MS,
    "EGRESS_ALERT_DELIVERY_TIMEOUT_MS",
    500,
    120_000,
    10_000,
    issues,
  );
  const alertMaxAttemptsPerRun = readBoundedInteger(
    environment.EGRESS_ALERT_MAX_ATTEMPTS_PER_RUN,
    "EGRESS_ALERT_MAX_ATTEMPTS_PER_RUN",
    1,
    5,
    3,
    issues,
  );
  const alertMaxTotalAttempts = readBoundedInteger(
    environment.EGRESS_ALERT_MAX_TOTAL_ATTEMPTS,
    "EGRESS_ALERT_MAX_TOTAL_ATTEMPTS",
    alertMaxAttemptsPerRun,
    20,
    6,
    issues,
  );
  const alertRetryBackoffMs = readBoundedInteger(
    environment.EGRESS_ALERT_RETRY_BACKOFF_MS,
    "EGRESS_ALERT_RETRY_BACKOFF_MS",
    0,
    60_000,
    1_000,
    issues,
  );
  const alertMaxRetryBackoffMs = readBoundedInteger(
    environment.EGRESS_ALERT_MAX_RETRY_BACKOFF_MS,
    "EGRESS_ALERT_MAX_RETRY_BACKOFF_MS",
    alertRetryBackoffMs,
    600_000,
    60_000,
    issues,
  );
  const alertLeaseMs = readBoundedInteger(
    environment.EGRESS_ALERT_DELIVERY_LEASE_MS,
    "EGRESS_ALERT_DELIVERY_LEASE_MS",
    1_000,
    600_000,
    120_000,
    issues,
  );
  if (alertLeaseMs < alertTimeoutMs * alertMaxAttemptsPerRun + alertMaxRetryBackoffMs) {
    issues.push("EGRESS_ALERT_DELIVERY_LEASE_MS is too short for the configured bounded retry window.");
  }

  return {
    public: {
      runtimeMode: "LIVE_READ_ONLY",
      chainId: 196,
      broadcastPermitted: false,
      transactionSubmitted: false,
      liveMainnetExecution: "DISABLED",
    },
    rpcUrl,
    rpcUrls,
    account,
    egressSpender,
    maxBlockAgeSeconds: readPositiveInteger(environment.EGRESS_LIVE_MAX_BLOCK_AGE_SECONDS, "EGRESS_LIVE_MAX_BLOCK_AGE_SECONDS", issues),
    observationBlockNumber,
    observationBlockHash,
    maxOracleAgeSeconds: readPositiveInteger(environment.EGRESS_LIVE_MAX_ORACLE_AGE_SECONDS, "EGRESS_LIVE_MAX_ORACLE_AGE_SECONDS", issues),
    maxSourceAgeSeconds: readPositiveInteger(environment.EGRESS_LIVE_MAX_SOURCE_AGE_SECONDS, "EGRESS_LIVE_MAX_SOURCE_AGE_SECONDS", issues),
    riskStorePath,
    archivePath,
    databaseUrl,
    hostedRuntime,
    inlinePollingPermitted,
    pollIntervalSeconds,
    pollReadTimeoutMs,
    pollArchiveTimeoutMs,
    pollMaxAttempts,
    pollRetryBackoffMs,
    pollMaxRetryBackoffMs,
    pollFailureThreshold,
    alertDelivery: {
      consoleEnabled: readBoolean(environment.EGRESS_ALERT_CONSOLE_ENABLED, true, "EGRESS_ALERT_CONSOLE_ENABLED", issues),
      webhookUrl,
      webhookSecret,
      webhookSinkId,
      timeoutMs: alertTimeoutMs,
      maxAttemptsPerRun: alertMaxAttemptsPerRun,
      maxTotalAttempts: alertMaxTotalAttempts,
      retryBackoffMs: alertRetryBackoffMs,
      maxRetryBackoffMs: alertMaxRetryBackoffMs,
      leaseMs: alertLeaseMs,
    },
    issues,
  };
}

function readRpcUrls(
  environment: Readonly<Partial<NodeJS.ProcessEnv>>,
  issues: string[],
): string[] {
  const configured = [
    environment.EGRESS_XLAYER_RPC_URL,
    ...(environment.EGRESS_XLAYER_RPC_URLS?.split(/[\n,]/u) ?? []),
  ]
    .map((value) => value?.trim() ?? "")
    .filter(Boolean);
  const values = [...new Set(configured.length > 0 ? configured : [XLAYER_MAINNET.rpcUrl])];
  for (const [index, value] of values.entries()) {
    try {
      const parsed = new URL(value);
      const localRuntime = parsed.hostname === "127.0.0.1" || parsed.hostname === "localhost";
      const label = values.length === 1 ? "EGRESS_XLAYER_RPC_URL" : `EGRESS_XLAYER_RPC_URLS[${index}]`;
      if (parsed.username || parsed.password) {
        issues.push(`${label} must not contain embedded credentials.`);
      } else if (parsed.protocol !== "https:" && !(parsed.protocol === "http:" && localRuntime)) {
        issues.push(`${label} must use HTTPS unless it points to a local test runtime.`);
      }
    } catch {
      const label = values.length === 1 ? "EGRESS_XLAYER_RPC_URL" : `EGRESS_XLAYER_RPC_URLS[${index}]`;
      issues.push(`${label} is not a valid URL.`);
    }
  }
  return values;
}

export function createLiveSnapshotArchive(config: LiveRuntimeConfig): LiveOperationalArchive {
  if (config.databaseUrl) return new PostgresLiveSnapshotArchive(config.databaseUrl);
  if (config.hostedRuntime) {
    throw new Error("Durable live archiving is unavailable: configure EGRESS_DATABASE_URL.");
  }
  return new FilesystemLiveSnapshotArchive(config.archivePath);
}

export function createLiveRevisionStore(config: LiveRuntimeConfig): RevisionStore {
  if (config.databaseUrl) return new PostgresRevisionStore(config.databaseUrl);
  if (config.hostedRuntime) {
    throw new Error("Durable RWA source revision storage is unavailable: configure EGRESS_DATABASE_URL.");
  }
  return new JsonFileStore(config.riskStorePath);
}

export function createLiveAlertDeliveryService(
  config: LiveRuntimeConfig,
  archive: LiveOperationalArchive,
  logger: (line: string) => void = (line) => console.info(line),
): LiveAlertDeliveryService | null {
  const sinks: AlertSink[] = [];
  if (config.alertDelivery.consoleEnabled) sinks.push(new ConsoleAlertSink(logger));
  if (config.alertDelivery.webhookUrl && config.alertDelivery.webhookSecret) {
    sinks.push(new WebhookAlertSink({
      url: config.alertDelivery.webhookUrl,
      secret: config.alertDelivery.webhookSecret,
      sinkId: config.alertDelivery.webhookSinkId,
    }));
  }
  if (sinks.length === 0) return null;
  return new LiveAlertDeliveryService({
    store: archive,
    sinks,
    deliveryTimeoutMs: config.alertDelivery.timeoutMs,
    maxAttemptsPerRun: config.alertDelivery.maxAttemptsPerRun,
    maxTotalAttempts: config.alertDelivery.maxTotalAttempts,
    retryBackoffMs: config.alertDelivery.retryBackoffMs,
    maxRetryBackoffMs: config.alertDelivery.maxRetryBackoffMs,
    leaseMs: config.alertDelivery.leaseMs,
  });
}

function readPositiveInteger(
  value: string | undefined,
  name: string,
  issues: string[],
): number | undefined {
  if (!value?.trim()) return undefined;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    issues.push(`${name} must be a positive integer.`);
    return undefined;
  }
  return parsed;
}

function readPositiveBigInt(
  value: string | undefined,
  name: string,
  issues: string[],
): bigint | undefined {
  if (!value?.trim()) return undefined;
  if (!/^[1-9][0-9]*$/.test(value.trim())) {
    issues.push(`${name} must be a positive integer.`);
    return undefined;
  }
  return BigInt(value.trim());
}

function readBoundedInteger(
  value: string | undefined,
  name: string,
  minimum: number,
  maximum: number,
  fallback: number,
  issues: string[],
): number {
  if (!value?.trim()) return fallback;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < minimum || parsed > maximum) {
    issues.push(`${name} must be an integer between ${minimum} and ${maximum}.`);
    return fallback;
  }
  return parsed;
}

function readBoolean(
  value: string | undefined,
  fallback: boolean,
  name: string,
  issues: string[],
): boolean {
  if (!value?.trim()) return fallback;
  if (/^(1|true|yes|on)$/i.test(value.trim())) return true;
  if (/^(0|false|no|off)$/i.test(value.trim())) return false;
  issues.push(`${name} must be true or false.`);
  return fallback;
}

function enabledBoolean(value: string | undefined): boolean {
  return Boolean(value?.trim() && !/^(0|false|no|off)$/i.test(value.trim()));
}
