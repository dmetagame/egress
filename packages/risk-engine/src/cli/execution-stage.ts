import { readFile } from "node:fs/promises";
import {
  createPublicClient,
  createWalletClient,
  defineChain,
  http,
  type Address,
  type Hex,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import {
  EgressShadowKeeper,
  XLAYER_MAINNET,
  XLayerMarketContextProvider,
  executionProtocolFromConfig,
  assertExecutionWorkerDatabasePrivileges,
  attachTestnetDeploymentManifest,
  identifyExecutionEnvironment,
  loadTestnetDeploymentManifest,
  readExecutionStagingConfig,
  type XLayerProtocolConfig,
} from "../index.js";
import { executionStagingRequestSchema } from "../staging/schemas.js";
import { PostgresExecutionStagingStore, PostgresStagingSnapshotReader } from "../staging/postgres-store.js";
import { ViemExecutionSubmitter } from "../staging/viem-submitter.js";
import { EgressExecutionStagingWorker } from "../staging/worker.js";

/**
 * Isolated execution-worker entrypoint. The observation/web runtime never
 * imports this module and never reads EGRESS_EXECUTION_PRIVATE_KEY.
 */
async function main(): Promise<void> {
  const requestPath = argumentValue("--request");
  if (!requestPath) throw new Error("Usage: npm run execution:stage -- --request <json-file>");

  const {
    EGRESS_EXECUTION_PRIVATE_KEY: privateKey,
    ...workerEnvironment
  } = process.env;
  let config = readExecutionStagingConfig(workerEnvironment);
  if (config.issues.length > 0) throw new Error(config.issues.join(" "));
  if (config.environment === "DISABLED") throw new Error("Execution staging is disabled.");
  if (config.environment === "TESTNET_WRITE") {
    if (!config.testnetManifestPath || !config.testnetManifestHash) {
      throw new Error("TESTNET_WRITE requires a pinned, integrity-verified deployment manifest.");
    }
    config = attachTestnetDeploymentManifest(
      config,
      await loadTestnetDeploymentManifest(config.testnetManifestPath, config.testnetManifestHash),
    );
  }
  const resolvedConfig = config;
  if (
    !resolvedConfig.rpcUrl ||
    resolvedConfig.chainId === null ||
    !resolvedConfig.protocol ||
    !resolvedConfig.egressContract ||
    !resolvedConfig.keeperAddress ||
    !resolvedConfig.databaseUrl
  ) {
    throw new Error("Execution worker configuration is incomplete.");
  }

  const request = executionStagingRequestSchema.parse(
    JSON.parse(await readFile(requestPath, "utf8")),
  );
  if (request.environment !== resolvedConfig.environment) {
    throw new Error("Request environment does not match EGRESS_EXECUTION_ENVIRONMENT.");
  }

  const chain = defineChain({
    id: resolvedConfig.chainId,
    name: resolvedConfig.environment === "FORK_WRITE" ? "Egress pinned X Layer fork" : `Egress testnet ${resolvedConfig.chainId}`,
    nativeCurrency: { name: "Native", symbol: "NATIVE", decimals: 18 },
    rpcUrls: { default: { http: [resolvedConfig.rpcUrl] } },
  });
  const publicClient = createPublicClient({ chain, transport: http(resolvedConfig.rpcUrl) });
  await identifyExecutionEnvironment(publicClient, resolvedConfig);
  await assertExecutionWorkerDatabasePrivileges(resolvedConfig.databaseUrl);
  const marketConfig = marketConfigForWorker(resolvedConfig);
  const marketProvider = new XLayerMarketContextProvider(marketConfig, {
    client: publicClient,
    plannerIterations: 32,
  });
  const wallet = resolvedConfig.submissionEnabled
    ? createWorkerWallet(privateKey, resolvedConfig.keeperAddress, chain, resolvedConfig.rpcUrl)
    : null;
  const keeper = new EgressShadowKeeper({
    publicClient,
    marketProvider,
    keeperAccount: resolvedConfig.keeperAddress,
    walletClient: wallet?.walletClient,
  });
  const store = new PostgresExecutionStagingStore(resolvedConfig.databaseUrl);
  const worker = new EgressExecutionStagingWorker({
    config: resolvedConfig,
    snapshotReader: new PostgresStagingSnapshotReader(resolvedConfig.databaseUrl),
    store,
    keeper,
    identifyEnvironment: () => identifyExecutionEnvironment(publicClient, resolvedConfig),
    readBlockHash: async (blockNumber) => (await publicClient.getBlock({ blockNumber })).hash,
    submitter: wallet ? new ViemExecutionSubmitter({ walletClient: wallet.walletClient, publicClient }) : undefined,
  });
  const result = await worker.stage(request);
  process.stdout.write(`${JSON.stringify(result, bigintReplacer)}\n`);
  if (result.status === "UNAVAILABLE" || result.status === "REJECTED" || result.status === "REVERTED") {
    process.exitCode = 1;
  }
}

function marketConfigForWorker(config: ReturnType<typeof readExecutionStagingConfig>): XLayerProtocolConfig {
  if (!config.protocol || config.chainId === null || !config.rpcUrl || config.anchorBlockNumber === null) {
    throw new Error("Execution protocol configuration is incomplete.");
  }
  const protocol = config.protocol;
  return {
    chainId: config.chainId,
    rpcUrl: config.rpcUrl,
    explorerUrl: "https://example.invalid/disabled-explorer",
    forkBlock: config.anchorBlockNumber,
    contracts: {
      addressesProvider: protocol.addressesProvider as Address,
      aavePool: protocol.aavePool as Address,
      aaveOracle: protocol.aaveOracle as Address,
      xbEthOracleSource: protocol.aaveOracle as Address,
      xethOracleSource: protocol.aaveOracle as Address,
      xbEth: protocol.xbEth as Address,
      xeth: protocol.xeth as Address,
      aXbEth: protocol.aXbEth as Address,
      variableDebtXeth: protocol.variableDebtXeth as Address,
      uniswapFactory: protocol.uniswapFactory as Address,
      swapRouter: protocol.swapRouter as Address,
      quoterV2: protocol.quoterV2 as Address,
      swapPool: protocol.swapPool as Address,
    },
    poolFee: protocol.poolFee,
    tokenDecimals: 18,
    oracleDecimals: 8,
  };
}

function createWorkerWallet(
  privateKey: string | undefined,
  expectedAddress: Address,
  chain: ReturnType<typeof defineChain>,
  rpcUrl: string,
) {
  if (!privateKey || !/^0x[0-9a-fA-F]{64}$/.test(privateKey)) {
    throw new Error("EGRESS_EXECUTION_PRIVATE_KEY is required only for an explicitly enabled isolated worker and must be a 32-byte hex key.");
  }
  const account = privateKeyToAccount(privateKey as Hex);
  if (account.address.toLowerCase() !== expectedAddress.toLowerCase()) {
    throw new Error("Execution signer address does not match EGRESS_EXECUTION_KEEPER_ADDRESS.");
  }
  return {
    account,
    walletClient: createWalletClient({ account, chain, transport: http(rpcUrl) }),
  };
}

function argumentValue(name: string): string | null {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] ?? null : null;
}

function bigintReplacer(_key: string, value: unknown): unknown {
  return typeof value === "bigint" ? value.toString() : value;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  await main();
}
