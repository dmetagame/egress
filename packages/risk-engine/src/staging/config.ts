import { resolve } from "node:path";
import { isAddress, type Address, type Hex, type PublicClient } from "viem";
import { XLAYER_MAINNET, type XLayerProtocolConfig } from "../market/config.js";
import {
  executionProtocolIdentitySchema,
  executionStagingEnvironmentSchema,
  type ExecutionProtocolIdentity,
  type ExecutionStagingEnvironment,
} from "./schemas.js";
import {
  XLAYER_TESTNET_CHAIN_ID,
  XLAYER_TESTNET_ENVIRONMENT_ID,
  assertTestnetManifestMatchesConfiguration,
  verifyTestnetDeploymentRuntime,
  type TestnetDeploymentManifest,
} from "./testnet-deployment.js";

export { XLAYER_TESTNET_CHAIN_ID, XLAYER_TESTNET_ENVIRONMENT_ID } from "./testnet-deployment.js";

export interface ExecutionStagingConfig {
  environment: ExecutionStagingEnvironment;
  submissionEnabled: boolean;
  rpcUrl: string | null;
  chainId: number | null;
  egressContract: Address | null;
  keeperAddress: Address | null;
  protocol: ExecutionProtocolIdentity | null;
  anchorBlockNumber: bigint | null;
  anchorBlockHash: Hex | null;
  forkRuntime: "ANVIL" | null;
  databaseUrl: string | null;
  environmentId: string | null;
  credentialReference: string | null;
  testnetManifestPath: string | null;
  testnetManifestHash: Hex | null;
  testnetDeployment: TestnetDeploymentManifest | null;
  maxSnapshotAgeSeconds: number;
  maxIntentAgeSeconds: number;
  issues: string[];
}

export interface ExecutionEnvironmentIdentity {
  environment: "FORK_WRITE" | "TESTNET_WRITE";
  chainId: number;
  anchorBlockHash: Hex;
  forkDetected: boolean;
  testnetConfigured: boolean;
}

export class ExecutionStagingConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ExecutionStagingConfigError";
  }
}

export class ExecutionStagingError extends Error {
  constructor(
    public readonly code:
      | "EXECUTION_ENVIRONMENT_MISMATCH"
      | "SNAPSHOT_NOT_FOUND"
      | "SNAPSHOT_INTEGRITY_FAILURE"
      | "STALE_SNAPSHOT"
      | "STALE_REQUEST"
      | "EXPIRED_INTENT"
      | "INVALID_RISK_STATE"
      | "INVALID_MARKET_STATE"
      | "AUTHORIZATION_INVALID"
      | "EXECUTION_BOUNDS_EXCEEDED"
      | "SIMULATION_FAILED"
      | "SUBMISSION_FAILED"
      | "DUPLICATE_EXECUTION",
    message: string,
  ) {
    super(message);
    this.name = "ExecutionStagingError";
  }
}

export function readExecutionStagingConfig(
  environment: Readonly<Partial<NodeJS.ProcessEnv>> = process.env,
): ExecutionStagingConfig {
  const issues: string[] = [];
  const rawMode = environment.EGRESS_EXECUTION_ENVIRONMENT?.trim() || "DISABLED";
  const mode = executionStagingEnvironmentSchema.safeParse(rawMode);
  if (!mode.success) {
    issues.push(
      rawMode === "LIVE_MAINNET_WRITE"
        ? "LIVE_MAINNET_WRITE is unsupported in Phase 9 and is permanently disabled."
        : "EGRESS_EXECUTION_ENVIRONMENT must be DISABLED, FORK_WRITE, or TESTNET_WRITE.",
    );
  }
  const executionEnvironment = mode.success ? mode.data : "DISABLED";

  const submissionEnabled = readBoolean(
    environment.EGRESS_EXECUTION_SUBMISSION_ENABLED,
    false,
    "EGRESS_EXECUTION_SUBMISSION_ENABLED",
    issues,
  );
  if (executionEnvironment === "DISABLED" && submissionEnabled) {
    issues.push("Execution submission cannot be enabled while EGRESS_EXECUTION_ENVIRONMENT is DISABLED.");
  }
  const rpcUrl = readUrl(environment.EGRESS_EXECUTION_RPC_URL, executionEnvironment, issues);
  if (executionEnvironment === "TESTNET_WRITE" && rpcUrl) {
    const parsedRpcUrl = new URL(rpcUrl);
    const localRpc = parsedRpcUrl.hostname === "127.0.0.1" || parsedRpcUrl.hostname === "localhost";
    if (localRpc || parsedRpcUrl.protocol !== "https:") {
      issues.push("TESTNET_WRITE requires a non-local HTTPS RPC endpoint.");
    }
  }
  const chainId = readPositiveInteger(
    environment.EGRESS_EXECUTION_CHAIN_ID,
    "EGRESS_EXECUTION_CHAIN_ID",
    issues,
    executionEnvironment === "DISABLED" ? null : undefined,
  );
  const egressContract = readAddress(
    environment.EGRESS_EXECUTION_EGRESS_CONTRACT,
    "EGRESS_EXECUTION_EGRESS_CONTRACT",
    issues,
    executionEnvironment === "DISABLED",
  );
  const keeperAddress = readAddress(
    environment.EGRESS_EXECUTION_KEEPER_ADDRESS,
    "EGRESS_EXECUTION_KEEPER_ADDRESS",
    issues,
    executionEnvironment === "DISABLED",
  );
  const anchorBlockNumber = readPositiveBigInt(
    environment.EGRESS_EXECUTION_ANCHOR_BLOCK,
    "EGRESS_EXECUTION_ANCHOR_BLOCK",
    issues,
    executionEnvironment === "DISABLED",
  );
  const anchorBlockHash = readHash(
    environment.EGRESS_EXECUTION_ANCHOR_BLOCK_HASH,
    "EGRESS_EXECUTION_ANCHOR_BLOCK_HASH",
    issues,
    executionEnvironment === "DISABLED",
  );
  if ((anchorBlockNumber === null) !== (anchorBlockHash === null)) {
    issues.push("EGRESS_EXECUTION_ANCHOR_BLOCK and EGRESS_EXECUTION_ANCHOR_BLOCK_HASH must be configured together.");
  }

  const forkRuntimeValue = environment.EGRESS_EXECUTION_FORK_RUNTIME?.trim() || "";
  const forkRuntime = forkRuntimeValue === "ANVIL" ? "ANVIL" : null;
  if (executionEnvironment === "FORK_WRITE" && forkRuntime === null) {
    issues.push("FORK_WRITE requires EGRESS_EXECUTION_FORK_RUNTIME=ANVIL.");
  }

  const databaseUrl = environment.EGRESS_DATABASE_URL?.trim() || null;
  if (executionEnvironment !== "DISABLED") {
    if (!databaseUrl) {
      issues.push("EGRESS_DATABASE_URL is required for an enabled execution staging worker.");
    } else if (!/^postgres(?:ql)?:\/\//i.test(databaseUrl)) {
      issues.push("EGRESS_DATABASE_URL must use the PostgreSQL URL scheme.");
    }
    if (chainId === null) issues.push("EGRESS_EXECUTION_CHAIN_ID is required for an enabled execution environment.");
    if (egressContract === null) issues.push("EGRESS_EXECUTION_EGRESS_CONTRACT is required for an enabled execution environment.");
    if (keeperAddress === null) issues.push("EGRESS_EXECUTION_KEEPER_ADDRESS is required for an enabled execution environment.");
    if (anchorBlockNumber === null || anchorBlockHash === null) {
      issues.push("An execution anchor block and hash are required for positive environment identification.");
    }
    if (executionEnvironment === "FORK_WRITE" && chainId !== null && chainId !== XLAYER_MAINNET.chainId) {
      issues.push(`FORK_WRITE must use X Layer chain ${XLAYER_MAINNET.chainId}.`);
    }
    if (executionEnvironment === "TESTNET_WRITE" && chainId !== null && chainId !== XLAYER_TESTNET_CHAIN_ID) {
      issues.push(`TESTNET_WRITE must use X Layer testnet chain ${XLAYER_TESTNET_CHAIN_ID}.`);
    }
  }

  const testnetOnlyConfigured = [
    "EGRESS_EXECUTION_ENVIRONMENT_ID",
    "EGRESS_EXECUTION_CREDENTIAL_REFERENCE",
    "EGRESS_EXECUTION_TESTNET_MANIFEST_PATH",
    "EGRESS_EXECUTION_TESTNET_MANIFEST_HASH",
  ].filter((key) => Boolean(environment[key]?.trim()));
  const environmentId = environment.EGRESS_EXECUTION_ENVIRONMENT_ID?.trim() || null;
  const credentialReference = readCredentialReference(
    environment.EGRESS_EXECUTION_CREDENTIAL_REFERENCE,
    executionEnvironment,
    issues,
  );
  const manifestPathValue = environment.EGRESS_EXECUTION_TESTNET_MANIFEST_PATH?.trim() || "";
  const testnetManifestPath = manifestPathValue
    ? resolve(/* turbopackIgnore: true */ manifestPathValue)
    : null;
  const testnetManifestHash = readHash(
    environment.EGRESS_EXECUTION_TESTNET_MANIFEST_HASH,
    "EGRESS_EXECUTION_TESTNET_MANIFEST_HASH",
    issues,
    executionEnvironment !== "TESTNET_WRITE",
  );
  if (executionEnvironment === "TESTNET_WRITE") {
    if (environmentId !== XLAYER_TESTNET_ENVIRONMENT_ID) {
      issues.push(`TESTNET_WRITE requires EGRESS_EXECUTION_ENVIRONMENT_ID=${XLAYER_TESTNET_ENVIRONMENT_ID}.`);
    }
    if (!testnetManifestPath) {
      issues.push("EGRESS_EXECUTION_TESTNET_MANIFEST_PATH is required for TESTNET_WRITE.");
    }
    if (!testnetManifestHash) {
      issues.push("EGRESS_EXECUTION_TESTNET_MANIFEST_HASH is required for TESTNET_WRITE.");
    }
  } else if (testnetOnlyConfigured.length > 0) {
    issues.push(`${testnetOnlyConfigured.join(", ")} may be configured only for TESTNET_WRITE.`);
  }

  const protocol = readProtocolIdentity(environment, executionEnvironment, issues);
  const maxSnapshotAgeSeconds = readBoundedInteger(
    environment.EGRESS_EXECUTION_MAX_SNAPSHOT_AGE_SECONDS,
    "EGRESS_EXECUTION_MAX_SNAPSHOT_AGE_SECONDS",
    1,
    86_400,
    300,
    issues,
  );
  const maxIntentAgeSeconds = readBoundedInteger(
    environment.EGRESS_EXECUTION_MAX_INTENT_AGE_SECONDS,
    "EGRESS_EXECUTION_MAX_INTENT_AGE_SECONDS",
    1,
    86_400,
    300,
    issues,
  );

  return {
    environment: executionEnvironment,
    submissionEnabled,
    rpcUrl,
    chainId,
    egressContract,
    keeperAddress,
    protocol,
    anchorBlockNumber,
    anchorBlockHash,
    forkRuntime,
    databaseUrl,
    environmentId,
    credentialReference,
    testnetManifestPath,
    testnetManifestHash,
    testnetDeployment: null,
    maxSnapshotAgeSeconds,
    maxIntentAgeSeconds,
    issues,
  };
}

/**
 * Verifies an environment using observations made by the isolated worker.
 * The caller must obtain the observations from the configured RPC before a
 * submitter is constructed.
 */
export function assertExecutionEnvironment(input: {
  config: ExecutionStagingConfig;
  observedChainId: number;
  observedAnchorBlockHash: Hex;
  forkDetected?: boolean;
  testnetConfigured?: boolean;
}): ExecutionEnvironmentIdentity {
  const { config } = input;
  if (config.issues.length > 0 || config.environment === "DISABLED") {
    throw new ExecutionStagingError(
      "EXECUTION_ENVIRONMENT_MISMATCH",
      config.issues.join(" ") || "Execution staging is disabled.",
    );
  }
  if (
    config.chainId === null ||
    config.anchorBlockHash === null ||
    input.observedChainId !== config.chainId ||
    input.observedAnchorBlockHash.toLowerCase() !== config.anchorBlockHash.toLowerCase()
  ) {
    throw new ExecutionStagingError(
      "EXECUTION_ENVIRONMENT_MISMATCH",
      "Observed chain or anchor block does not match the explicitly configured execution environment.",
    );
  }
  if (config.environment === "FORK_WRITE" && !input.forkDetected) {
    throw new ExecutionStagingError(
      "EXECUTION_ENVIRONMENT_MISMATCH",
      "FORK_WRITE requires a positively identified local Anvil fork.",
    );
  }
  if (config.environment === "TESTNET_WRITE" && (!input.testnetConfigured || !config.testnetDeployment)) {
    throw new ExecutionStagingError(
      "EXECUTION_ENVIRONMENT_MISMATCH",
      "TESTNET_WRITE requires a positively identified configured testnet deployment.",
    );
  }
  return {
    environment: config.environment,
    chainId: config.chainId,
    anchorBlockHash: config.anchorBlockHash,
    forkDetected: input.forkDetected ?? false,
    testnetConfigured: input.testnetConfigured ?? false,
  };
}

export async function identifyExecutionEnvironment(
  client: PublicClient,
  config: ExecutionStagingConfig,
): Promise<ExecutionEnvironmentIdentity> {
  if (
    config.environment === "DISABLED" ||
    config.chainId === null ||
    config.anchorBlockNumber === null ||
    config.anchorBlockHash === null
  ) {
    throw new ExecutionStagingError(
      "EXECUTION_ENVIRONMENT_MISMATCH",
      "Execution environment is disabled or missing positive identity configuration.",
    );
  }
  const observedChainId = await client.getChainId();
  const block = await client.getBlock({ blockNumber: config.anchorBlockNumber });
  if (!block.hash) {
    throw new ExecutionStagingError(
      "EXECUTION_ENVIRONMENT_MISMATCH",
      "Configured execution anchor block has no hash.",
    );
  }
  let forkDetected = false;
  let testnetConfigured = false;
  if (config.environment === "FORK_WRITE") {
    const metadata = await client.request({ method: "anvil_metadata" } as never) as {
      chainId?: number;
      forkedNetwork?: { chainId?: number; forkBlockNumber?: number; forkBlockHash?: string };
    };
    forkDetected =
      config.forkRuntime === "ANVIL" &&
      metadata.chainId === config.chainId &&
      metadata.forkedNetwork?.chainId === XLAYER_MAINNET.chainId &&
      metadata.forkedNetwork.forkBlockNumber === Number(config.anchorBlockNumber) &&
      metadata.forkedNetwork.forkBlockHash?.toLowerCase() === config.anchorBlockHash.toLowerCase();
  } else {
    if (!config.testnetDeployment) {
      throw new ExecutionStagingError(
        "EXECUTION_ENVIRONMENT_MISMATCH",
        "TESTNET_WRITE requires a loaded and integrity-verified deployment manifest.",
      );
    }
    await verifyTestnetDeploymentRuntime(client, {
      manifest: config.testnetDeployment,
      config: testnetConfigurationIdentity(config),
    });
    testnetConfigured = observedChainId === config.chainId && block.hash.toLowerCase() === config.anchorBlockHash.toLowerCase();
  }
  return assertExecutionEnvironment({
    config,
    observedChainId,
    observedAnchorBlockHash: block.hash,
    forkDetected,
    testnetConfigured,
  });
}

export function attachTestnetDeploymentManifest(
  config: ExecutionStagingConfig,
  manifest: TestnetDeploymentManifest,
): ExecutionStagingConfig {
  if (config.environment !== "TESTNET_WRITE") {
    throw new ExecutionStagingConfigError("A testnet deployment manifest may be attached only to TESTNET_WRITE.");
  }
  assertTestnetManifestMatchesConfiguration({
    manifest,
    config: testnetConfigurationIdentity(config),
  });
  return { ...config, testnetDeployment: manifest };
}

function testnetConfigurationIdentity(config: ExecutionStagingConfig) {
  return {
    environmentId: config.environmentId,
    manifestHash: config.testnetManifestHash,
    chainId: config.chainId,
    anchorBlockNumber: config.anchorBlockNumber,
    anchorBlockHash: config.anchorBlockHash,
    egressContract: config.egressContract,
    keeperAddress: config.keeperAddress,
    protocol: config.protocol,
  };
}

export function executionProtocolFromConfig(config: XLayerProtocolConfig): ExecutionProtocolIdentity {
  return executionProtocolIdentitySchema.parse({
    ...config.contracts,
    poolFee: config.poolFee,
  });
}

function readProtocolIdentity(
  environment: Readonly<Partial<NodeJS.ProcessEnv>>,
  mode: ExecutionStagingEnvironment,
  issues: string[],
): ExecutionProtocolIdentity | null {
  if (mode === "DISABLED") return null;
  const defaults = mode === "FORK_WRITE" ? executionProtocolFromConfig(XLAYER_MAINNET) : null;
  const values = {
    addressesProvider: readProtocolAddress(environment, "EGRESS_EXECUTION_ADDRESSES_PROVIDER", defaults?.addressesProvider, issues),
    aavePool: readProtocolAddress(environment, "EGRESS_EXECUTION_AAVE_POOL", defaults?.aavePool, issues),
    aaveOracle: readProtocolAddress(environment, "EGRESS_EXECUTION_AAVE_ORACLE", defaults?.aaveOracle, issues),
    xbEth: readProtocolAddress(environment, "EGRESS_EXECUTION_XBETH", defaults?.xbEth, issues),
    xeth: readProtocolAddress(environment, "EGRESS_EXECUTION_XETH", defaults?.xeth, issues),
    aXbEth: readProtocolAddress(environment, "EGRESS_EXECUTION_A_XBETH", defaults?.aXbEth, issues),
    variableDebtXeth: readProtocolAddress(environment, "EGRESS_EXECUTION_VARIABLE_DEBT_XETH", defaults?.variableDebtXeth, issues),
    uniswapFactory: readProtocolAddress(environment, "EGRESS_EXECUTION_UNISWAP_FACTORY", defaults?.uniswapFactory, issues),
    swapRouter: readProtocolAddress(environment, "EGRESS_EXECUTION_SWAP_ROUTER", defaults?.swapRouter, issues),
    quoterV2: readProtocolAddress(environment, "EGRESS_EXECUTION_QUOTER_V2", defaults?.quoterV2, issues),
    swapPool: readProtocolAddress(environment, "EGRESS_EXECUTION_SWAP_POOL", defaults?.swapPool, issues),
    poolFee: readPositiveInteger(environment.EGRESS_EXECUTION_POOL_FEE, "EGRESS_EXECUTION_POOL_FEE", issues, defaults?.poolFee ?? undefined),
  };
  if (Object.values(values).some((value) => value === null)) return null;
  return executionProtocolIdentitySchema.parse(values);
}

function readProtocolAddress(
  environment: Readonly<Partial<NodeJS.ProcessEnv>>,
  key: string,
  fallback: string | undefined,
  issues: string[],
): Address | null {
  const raw = environment[key]?.trim() || fallback || "";
  if (!raw) {
    issues.push(`${key} is required for the configured execution environment.`);
    return null;
  }
  if (!isAddress(raw)) {
    issues.push(`${key} is not a valid EVM address.`);
    return null;
  }
  return raw as Address;
}

function readUrl(
  value: string | undefined,
  mode: ExecutionStagingEnvironment,
  issues: string[],
): string | null {
  const raw = value?.trim() || "";
  if (!raw) {
    if (mode !== "DISABLED") issues.push("EGRESS_EXECUTION_RPC_URL is required for an enabled execution environment.");
    return null;
  }
  try {
    const parsed = new URL(raw);
    const local = parsed.hostname === "127.0.0.1" || parsed.hostname === "localhost";
    if (parsed.username || parsed.password) issues.push("EGRESS_EXECUTION_RPC_URL must not contain embedded credentials.");
    if (parsed.protocol !== "https:" && !(parsed.protocol === "http:" && local)) {
      issues.push("EGRESS_EXECUTION_RPC_URL must use HTTPS unless it points to a local test runtime.");
    }
    return parsed.toString();
  } catch {
    issues.push("EGRESS_EXECUTION_RPC_URL is not a valid URL.");
    return null;
  }
}

function readCredentialReference(
  value: string | undefined,
  mode: ExecutionStagingEnvironment,
  issues: string[],
): string | null {
  const raw = value?.trim() || "";
  if (!raw) {
    if (mode === "TESTNET_WRITE") {
      issues.push("EGRESS_EXECUTION_CREDENTIAL_REFERENCE is required for TESTNET_WRITE.");
    }
    return null;
  }
  if (!/^[a-zA-Z0-9][a-zA-Z0-9._:/-]{0,127}$/.test(raw)) {
    issues.push("EGRESS_EXECUTION_CREDENTIAL_REFERENCE contains unsupported characters.");
    return null;
  }
  return raw;
}

function readAddress(
  value: string | undefined,
  key: string,
  issues: string[],
  optional: boolean,
): Address | null {
  const raw = value?.trim() || "";
  if (!raw && optional) return null;
  if (!raw) {
    issues.push(`${key} is required for an enabled execution environment.`);
    return null;
  }
  if (!isAddress(raw)) {
    issues.push(`${key} is not a valid EVM address.`);
    return null;
  }
  return raw as Address;
}

function readHash(
  value: string | undefined,
  key: string,
  issues: string[],
  optional: boolean,
): Hex | null {
  const raw = value?.trim() || "";
  if (!raw && optional) return null;
  if (!/^0x[0-9a-fA-F]{64}$/.test(raw)) {
    issues.push(`${key} must be a 32-byte hex value.`);
    return null;
  }
  return raw as Hex;
}

function readPositiveBigInt(
  value: string | undefined,
  key: string,
  issues: string[],
  optional: boolean,
): bigint | null {
  const raw = value?.trim() || "";
  if (!raw && optional) return null;
  try {
    const parsed = BigInt(raw);
    if (parsed <= 0n) throw new Error();
    return parsed;
  } catch {
    issues.push(`${key} must be a positive integer.`);
    return null;
  }
}

function readPositiveInteger(
  value: string | undefined,
  key: string,
  issues: string[],
  fallback?: number | null,
): number | null {
  const raw = value?.trim() || "";
  if (!raw && fallback !== undefined) return fallback;
  if (!raw) return null;
  const parsed = Number(raw);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    issues.push(`${key} must be a positive integer.`);
    return null;
  }
  return parsed;
}

function readBoundedInteger(
  value: string | undefined,
  key: string,
  minimum: number,
  maximum: number,
  fallback: number,
  issues: string[],
): number {
  const raw = value?.trim() || "";
  if (!raw) return fallback;
  const parsed = Number(raw);
  if (!Number.isInteger(parsed) || parsed < minimum || parsed > maximum) {
    issues.push(`${key} must be an integer between ${minimum} and ${maximum}.`);
    return fallback;
  }
  return parsed;
}

function readBoolean(
  value: string | undefined,
  fallback: boolean,
  key: string,
  issues: string[],
): boolean {
  const raw = value?.trim().toLowerCase();
  if (!raw) return fallback;
  if (raw === "true" || raw === "1") return true;
  if (raw === "false" || raw === "0") return false;
  issues.push(`${key} must be true or false.`);
  return fallback;
}
