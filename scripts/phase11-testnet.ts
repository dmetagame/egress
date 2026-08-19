import { mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { neon } from "@neondatabase/serverless";
import {
  createPublicClient,
  createWalletClient,
  defineChain,
  formatEther,
  http,
  parseAbi,
  type Address,
  type Hex,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import {
  assertArchiveDatabasePrivileges,
  assertExecutionWorkerDatabasePrivileges,
  assertPhase11TestnetHarnessConfig,
  attachTestnetDeploymentManifest,
  buildArchivedLiveSnapshot,
  buildTestnetExecutionSnapshotEnvelope,
  DeterministicPolicyEngine,
  DeterministicReplayAnalyzer,
  EgressExecutionStagingWorker,
  EgressRiskPipeline,
  EgressShadowKeeper,
  egressAutonomousAbi,
  executionStagingRequestSchema,
  identifyExecutionEnvironment,
  InMemorySourceFetcher,
  InMemoryStore,
  loadTestnetDeploymentManifest,
  PostgresExecutionStagingStore,
  PostgresLiveSnapshotArchive,
  PostgresStagingSnapshotReader,
  readExecutionStagingConfig,
  readPhase11TestnetHarnessConfig,
  RiskAttestationSigner,
  RiskAuditLogger,
  signAutonomousRiskAttestation,
  signProtectionPolicy,
  SourceIngestionService,
  validateDatabaseMigrations,
  verifyArchivedLiveSnapshot,
  verifyExecutionFingerprint,
  verifyExecutionSimulation,
  verifyExecutionStagingIntent,
  verifyExecutionSubmission,
  ViemExecutionSubmitter,
  XLAYER_TESTNET_CHAIN_ID,
  XLayerMarketContextProvider,
  type ExecutionStagingConfig,
  type ExecutionStagingResult,
  type ExecutionSubmitter,
  type PolicyRuntimeState,
  type RiskEventRecord,
  type UserProtectionPolicy,
  type XLayerProtocolConfig,
} from "../packages/risk-engine/src/index.js";
import { erc20Abi } from "../packages/risk-engine/src/market/abis.js";
import {
  REPLAY_REVISIONS,
  REPLAY_SOURCE,
} from "../packages/risk-engine/src/replay/fixtures.js";
import { buildPhase11ScenarioPolicy } from "./phase11-policy.js";

const REPORT_DIRECTORY = resolve("reports/phase11");
const REPORT_JSON = resolve(REPORT_DIRECTORY, "xlayer-testnet-execution.json");
const compatibilityPoolAbi = parseAbi([
  "function getConfiguration(address asset) view returns (uint256 data)",
  "function FLASHLOAN_PREMIUM_TOTAL() view returns (uint128)",
  "function getUserAccountData(address user) view returns (uint256 totalCollateralBase,uint256 totalDebtBase,uint256 availableBorrowsBase,uint256 currentLiquidationThreshold,uint256 ltv,uint256 healthFactor)",
]);

async function main(): Promise<void> {
  const harness = readPhase11TestnetHarnessConfig(process.env);
  assertPhase11TestnetHarnessConfig(harness);

  const {
    EGRESS_EXECUTION_PRIVATE_KEY: keeperPrivateKey,
    EGRESS_PHASE11_BORROWER_PRIVATE_KEY: borrowerPrivateKey,
    EGRESS_PHASE11_RISK_ATTESTOR_PRIVATE_KEY: riskAttestorPrivateKey,
    EGRESS_PHASE11_DEPLOYER_PRIVATE_KEY: _deployerPrivateKey,
    ...nonSecretEnvironment
  } = process.env;
  let stagingConfig = readExecutionStagingConfig(nonSecretEnvironment);
  if (stagingConfig.issues.length > 0) throw new Error(stagingConfig.issues.join(" "));
  if (stagingConfig.submissionEnabled && !harness.privateKeyConfigured) {
    throw new Error("Phase 11 submission requires an isolated execution private key.");
  }
  if (
    stagingConfig.environment !== "TESTNET_WRITE" ||
    !stagingConfig.rpcUrl ||
    stagingConfig.chainId !== XLAYER_TESTNET_CHAIN_ID ||
    !stagingConfig.testnetManifestPath ||
    !stagingConfig.testnetManifestHash ||
    !stagingConfig.databaseUrl ||
    !stagingConfig.protocol ||
    !stagingConfig.egressContract ||
    !stagingConfig.keeperAddress
  ) {
    throw new Error("Phase 11 TESTNET_WRITE configuration is incomplete.");
  }
  const rpcUrl = stagingConfig.rpcUrl;
  stagingConfig = attachTestnetDeploymentManifest(
    stagingConfig,
    await loadTestnetDeploymentManifest(stagingConfig.testnetManifestPath, stagingConfig.testnetManifestHash),
  );
  const manifest = stagingConfig.testnetDeployment!;
  const keeper = stagingConfig.submissionEnabled
    ? privateKeyToAccount(requiredKey(keeperPrivateKey, "EGRESS_EXECUTION_PRIVATE_KEY"))
    : null;
  const borrower = privateKeyToAccount(requiredKey(borrowerPrivateKey, "EGRESS_PHASE11_BORROWER_PRIVATE_KEY"));
  const riskAttestor = privateKeyToAccount(requiredKey(riskAttestorPrivateKey, "EGRESS_PHASE11_RISK_ATTESTOR_PRIVATE_KEY"));
  if (keeper) assertAddress(keeper.address, manifest.keeper, "Execution private key does not match the manifest keeper.");
  assertAddress(borrower.address, manifest.scenario.borrower, "Borrower private key does not match the manifest scenario.");
  assertAddress(riskAttestor.address, manifest.scenario.riskAttestor, "Risk-attestor private key does not match the manifest scenario.");

  const chain = defineChain({
    id: XLAYER_TESTNET_CHAIN_ID,
    name: "Egress X Layer testnet",
    nativeCurrency: { name: "OKB", symbol: "OKB", decimals: 18 },
    rpcUrls: { default: { http: [rpcUrl] } },
  });
  const transport = http(rpcUrl, { timeout: 120_000, retryCount: 0 });
  const publicClient = createPublicClient({ chain, transport });
  const keeperClient = keeper ? createWalletClient({ account: keeper, chain, transport }) : null;
  await identifyExecutionEnvironment(publicClient, stagingConfig);
  if (stagingConfig.submissionEnabled) {
    const keeperBalance = await publicClient.getBalance({ address: manifest.keeper });
    if (keeperBalance === 0n) throw new Error("The dedicated Phase 11 keeper has no X Layer testnet gas balance.");
  }

  process.stdout.write("[EGRESS] Validating Phase 11 PostgreSQL roles and migrations\n");
  const archiveSql = neon(harness.archiveDatabaseUrl) as ReturnType<typeof neon>;
  const workerSql = neon(harness.workerDatabaseUrl) as ReturnType<typeof neon>;
  const [archiveMigrations, workerMigrations, archiveIdentity, workerIdentity] = await Promise.all([
    validateDatabaseMigrations(queryClient(archiveSql)),
    validateDatabaseMigrations(queryClient(workerSql)),
    readDatabaseIdentity(archiveSql),
    readDatabaseIdentity(workerSql),
  ]);
  assert(archiveMigrations.appliedVersion === 4, "Archive database must have migrations 0001 through 0004.");
  assert(workerMigrations.appliedVersion === 4, "Worker database must have migrations 0001 through 0004.");
  assert(archiveIdentity.databaseName === workerIdentity.databaseName, "Archive and worker roles must target one Phase 11 database.");
  assert(archiveIdentity.roleName !== workerIdentity.roleName, "Archive and worker PostgreSQL roles must be distinct.");
  await assertArchiveDatabasePrivileges(harness.archiveDatabaseUrl);
  await assertExecutionWorkerDatabasePrivileges(harness.workerDatabaseUrl);

  const marketConfig = marketConfigFromManifest(stagingConfig);
  const unpinnedMarketProvider = new XLayerMarketContextProvider(marketConfig, {
    client: publicClient,
    plannerIterations: 32,
  });
  const latestBeforeSetup = await publicClient.getBlock({ blockTag: "latest" });
  if (BigInt(manifest.scenario.policyExpiresAt) <= latestBeforeSetup.timestamp) {
    throw new Error("Manifest-pinned Phase 11 policy expiry has passed.");
  }
  const scenarioPolicy = buildPhase11ScenarioPolicy({
    borrower: manifest.scenario.borrower,
    keeper: manifest.keeper,
    riskAttestor: manifest.scenario.riskAttestor,
    egressContract: manifest.egressContract,
    protocolConfigHash: manifest.protocolConfigHash,
    bounds: manifest.executionBounds,
    policyNonce: manifest.scenario.policyNonce,
    policyExpiresAt: manifest.scenario.policyExpiresAt,
    revocationNonce: await publicClient.readContract({
      address: manifest.egressContract,
      abi: egressAutonomousAbi,
      functionName: "revocationNonces",
      args: [borrower.address],
    }),
  });
  const { userPolicy, onchainPolicy, policyId } = scenarioPolicy;
  assert(policyId.toLowerCase() === manifest.scenario.policyId.toLowerCase(), "Manifest policy ID does not match the deterministic signed policy.");
  const policySignature = await signProtectionPolicy({
    account: borrower,
    chainId: XLAYER_TESTNET_CHAIN_ID,
    egressContract: manifest.egressContract,
    policy: onchainPolicy,
  });
  const policyState = await publicClient.readContract({
    address: manifest.egressContract,
    abi: egressAutonomousAbi,
    functionName: "policyStates",
    args: [policyId],
  });
  assertAddress(policyState[0], borrower.address, "Manifest-pinned policy is not registered for the configured borrower.");
  assert(policyState[1], "Manifest-pinned deterministic Phase 11 policy is inactive.");

  const eventBlock = await publicClient.getBlock({ blockTag: "latest" });
  assert(eventBlock.hash, "Phase 11 event block has no hash.");
  const eventNow = new Date(Number(eventBlock.timestamp) * 1_000);
  const pinnedMarketProvider = {
    getContext: (user: Address, policy: UserProtectionPolicy) =>
      unpinnedMarketProvider.getContextAtBlock(user, policy, eventBlock.number),
  };
  const sourceStore = new InMemoryStore();
  const revisions = await runRevisions({
    now: eventNow,
    store: sourceStore,
    userPolicy,
    marketProvider: pinnedMarketProvider,
    riskAttestor,
  });
  const revisionC = revisions.find((item) => item.revision === "C");
  assert(revisionC?.event.verdict.riskLevel === "HIGH", "Replay C did not produce the required HIGH verdict.");
  const event = { ...revisionC.event, mode: "TEST" as const };
  assert(event.marketContext && event.intent, "Phase 11 risk event has no market context or deterministic intent.");
  const autonomousAttestation = await signAutonomousRiskAttestation({
    account: riskAttestor,
    verdict: event.verdict,
    policyId,
    chainId: XLAYER_TESTNET_CHAIN_ID,
    egressContract: manifest.egressContract,
    issuedAt: eventNow,
    expiresAt: new Date(eventNow.getTime() + Number(manifest.executionBounds.maxRiskAgeSeconds) * 1_000),
  });

  const [collateralRaw, debtRaw, flashLoanPremium, xbEthWalletBalance, xethWalletBalance, aTokenAllowance] = await Promise.all([
    publicClient.readContract({ address: manifest.protocol.aavePool, abi: compatibilityPoolAbi, functionName: "getConfiguration", args: [manifest.protocol.xbEth], blockNumber: eventBlock.number }),
    publicClient.readContract({ address: manifest.protocol.aavePool, abi: compatibilityPoolAbi, functionName: "getConfiguration", args: [manifest.protocol.xeth], blockNumber: eventBlock.number }),
    publicClient.readContract({ address: manifest.protocol.aavePool, abi: compatibilityPoolAbi, functionName: "FLASHLOAN_PREMIUM_TOTAL", blockNumber: eventBlock.number }),
    publicClient.readContract({ address: manifest.protocol.xbEth, abi: erc20Abi, functionName: "balanceOf", args: [borrower.address], blockNumber: eventBlock.number }),
    publicClient.readContract({ address: manifest.protocol.xeth, abi: erc20Abi, functionName: "balanceOf", args: [borrower.address], blockNumber: eventBlock.number }),
    publicClient.readContract({ address: manifest.protocol.aXbEth, abi: erc20Abi, functionName: "allowance", args: [borrower.address, manifest.egressContract], blockNumber: eventBlock.number }),
  ]);
  const envelope = await buildTestnetExecutionSnapshotEnvelope({
    event,
    store: sourceStore,
    market: event.marketContext,
    protocol: manifest.protocol,
    oracleSources: manifest.oracleSources,
    chainId: XLAYER_TESTNET_CHAIN_ID,
    publicRpcUrl: rpcUrl,
    blockHash: eventBlock.hash,
    blockTimestamp: eventNow,
    now: eventNow,
    flashLoanPremiumBps: Number(flashLoanPremium),
    collateralReserve: decodeReserve(manifest.protocol.xbEth, collateralRaw),
    debtReserve: decodeReserve(manifest.protocol.xeth, debtRaw),
    tokens: {
      xbEth: {
        ...manifest.tokens.xbEth,
        walletBalanceWei: xbEthWalletBalance.toString(),
        aTokenAllowanceWei: aTokenAllowance.toString(),
      },
      xeth: { ...manifest.tokens.xeth, walletBalanceWei: xethWalletBalance.toString() },
    },
  });
  const archivedSnapshot = buildArchivedLiveSnapshot(envelope, eventNow.toISOString());
  assert(verifyArchivedLiveSnapshot(archivedSnapshot), "Phase 11 archived snapshot integrity verification failed.");
  const archive = new PostgresLiveSnapshotArchive(harness.archiveDatabaseUrl, archiveSql);
  await archive.archive(archivedSnapshot, eventNow.toISOString());

  const snapshotReader = new PostgresStagingSnapshotReader(harness.workerDatabaseUrl, workerSql);
  const store = new PostgresExecutionStagingStore(harness.workerDatabaseUrl, workerSql);
  const workerSnapshot = await snapshotReader.get(archivedSnapshot.snapshotHash);
  assert(workerSnapshot?.integrityHash === archivedSnapshot.integrityHash, "Worker role read different snapshot evidence.");
  const protectedHistory = await readProtectedHistory({ archiveSql, workerSql });
  const request = executionStagingRequestSchema.parse({
    schemaVersion: 1,
    actionType: "AAVE_XBETH_XETH_DELEVERAGE",
    snapshotHash: archivedSnapshot.snapshotHash,
    riskEvent: event,
    policy: onchainPolicy,
    policyAuthorizationSignature: policySignature,
    riskAttestation: autonomousAttestation,
    environment: "TESTNET_WRITE",
    requestedAt: eventNow.toISOString(),
  });
  const shadowKeeper = new EgressShadowKeeper({
    publicClient,
    marketProvider: pinnedMarketProvider,
    keeperAccount: manifest.keeper,
    now: () => eventNow,
  });
  const dependencies = {
    snapshotReader,
    store,
    keeper: shadowKeeper,
    identifyEnvironment: () => identifyExecutionEnvironment(publicClient, stagingConfig),
    readBlockHash: async (blockNumber: bigint) => (await publicClient.getBlock({ blockNumber })).hash,
    now: () => eventNow,
  };
  const simulationConfig = { ...stagingConfig, submissionEnabled: false };
  const firstSimulation = await new EgressExecutionStagingWorker({ config: simulationConfig, ...dependencies }).stage(request);
  const secondSimulation = await new EgressExecutionStagingWorker({ config: simulationConfig, ...dependencies }).stage(request);
  assertSimulation(firstSimulation);
  assertSimulation(secondSimulation);
  assert(firstSimulation.intent.intentHash === secondSimulation.intent.intentHash, "Repeated testnet snapshot produced a different intent.");
  assert(firstSimulation.simulation.simulationHash === secondSimulation.simulation.simulationHash, "Repeated testnet snapshot produced a different simulation.");

  if (!stagingConfig.submissionEnabled) {
    process.stdout.write(JSON.stringify({
      status: "SIMULATED",
      environment: "TESTNET_WRITE",
      environmentId: manifest.environmentId,
      chainId: XLAYER_TESTNET_CHAIN_ID,
      manifestHash: manifest.manifestHash,
      snapshotHash: archivedSnapshot.snapshotHash,
      intentHash: firstSimulation.intent.intentHash,
      simulationHash: firstSimulation.simulation.simulationHash,
      liveMainnetExecution: "DISABLED",
      nextStep: "Review the simulation, then enable submission only in the isolated worker for one controlled transaction.",
    }) + "\n");
    return;
  }
  if (!keeperClient || !keeper) throw new Error("An isolated keeper wallet is required for the controlled Phase 11 submission.");
  const before = await readPosition(publicClient, manifest.protocol.aavePool, manifest.protocol.aXbEth, manifest.protocol.variableDebtXeth, borrower.address);
  const viemSubmitter = new ViemExecutionSubmitter({ walletClient: keeperClient, publicClient });
  let submitterCalls = 0;
  const submitter: ExecutionSubmitter = {
    submit: async (input) => {
      submitterCalls += 1;
      return viemSubmitter.submit(input);
    },
  };
  const submission = await new EgressExecutionStagingWorker({
    config: stagingConfig,
    ...dependencies,
    submitter,
  }).stage(request);
  assert(submission.status === "CONFIRMED" && submission.intent && submission.simulation && submission.submission, `Phase 11 execution was not confirmed: ${submission.reason}`);
  assert(submitterCalls === 1, `Expected one testnet submitter call, received ${submitterCalls}.`);
  const replay = await new EgressExecutionStagingWorker({
    config: stagingConfig,
    ...dependencies,
    submitter,
  }).stage(request);
  assert(replay.status !== "CONFIRMED", "Replay unexpectedly produced a second confirmed testnet execution.");
  assert(submitterCalls === 1, "Replay reached the wallet submitter.");

  const after = await readPosition(publicClient, manifest.protocol.aavePool, manifest.protocol.aXbEth, manifest.protocol.variableDebtXeth, borrower.address);
  assert(BigInt(after.debtWei) < BigInt(before.debtWei), "Testnet execution did not reduce xETH debt.");
  assert(BigInt(after.healthFactorWad) > BigInt(before.healthFactorWad), "Testnet execution did not improve health factor.");
  assert(verifyExecutionStagingIntent(submission.intent), "Persisted Phase 11 intent integrity failed.");
  assert(verifyExecutionSimulation(submission.simulation), "Persisted Phase 11 simulation integrity failed.");
  assert(verifyExecutionSubmission(submission.submission), "Persisted Phase 11 submission integrity failed.");
  assert(submission.submission.schemaVersion === 2, "Submission has no execution binding.");
  const { executionFingerprint, transactionBinding } = submission.submission;
  assert(verifyExecutionFingerprint({
    fingerprint: executionFingerprint as Hex,
    intent: submission.intent,
    simulation: submission.simulation,
    transactionBinding,
  }), "Phase 11 execution fingerprint verification failed.");
  const transactionHash = submission.submission.transactionHash;
  assert(transactionHash, "Confirmed Phase 11 submission has no transaction hash.");
  const receipt = await publicClient.getTransactionReceipt({ hash: transactionHash as Hex });
  assert(receipt.status === "success", "Phase 11 transaction receipt is not successful.");
  const reservation = await store.latestReservation();
  assert(reservation?.intentHash === submission.intent.intentHash, "Reservation does not reference the confirmed intent.");
  const protectedHistoryAfter = await readProtectedHistory({ archiveSql, workerSql });
  assert(JSON.stringify(protectedHistoryAfter) === JSON.stringify(protectedHistory), "Execution worker mutated protected observation or OKX history.");

  const report = {
    schemaVersion: 1,
    label: "EGRESS PHASE 11 X LAYER TESTNET EXECUTION",
    environment: "TESTNET_WRITE",
    environmentId: manifest.environmentId,
    chainId: XLAYER_TESTNET_CHAIN_ID,
    manifestHash: manifest.manifestHash,
    deploymentBlockNumber: manifest.deploymentBlockNumber,
    snapshot: {
      snapshotHash: archivedSnapshot.snapshotHash,
      blockNumber: archivedSnapshot.observedBlock,
      blockHash: archivedSnapshot.blockHash,
      integrityHash: archivedSnapshot.integrityHash,
    },
    policy: {
      policyId,
      registrationTransactionHash: manifest.scenario.policyRegistrationTransactionHash,
    },
    intentHash: submission.intent.intentHash,
    simulationHash: submission.simulation.simulationHash,
    executionFingerprint,
    reservationId: reservation.reservationId,
    transactionHash,
    receipt: {
      status: receipt.status,
      blockNumber: receipt.blockNumber.toString(),
      gasUsed: receipt.gasUsed.toString(),
    },
    stateTransition: {
      debtBeforeWei: before.debtWei,
      debtAfterWei: after.debtWei,
      healthFactorBeforeWad: before.healthFactorWad,
      healthFactorAfterWad: after.healthFactorWad,
    },
    replay: { status: replay.status, code: replay.code, submitterCalls },
    liveMainnetExecution: "DISABLED",
  };
  await mkdir(REPORT_DIRECTORY, { recursive: true });
  await writeFile(REPORT_JSON, `${JSON.stringify(report, null, 2)}\n`, "utf8");
  process.stdout.write("EGRESS PHASE 11 X LAYER TESTNET EXECUTION\n");
  process.stdout.write(`Snapshot: ${archivedSnapshot.snapshotHash}\n`);
  process.stdout.write(`Intent: ${submission.intent.intentHash}\n`);
  process.stdout.write(`Simulation: ${submission.simulation.simulationHash}\n`);
  process.stdout.write(`Fingerprint: ${executionFingerprint}\n`);
  process.stdout.write(`Transaction: ${transactionHash}\n`);
  process.stdout.write(`Debt: ${formatEther(BigInt(before.debtWei))} -> ${formatEther(BigInt(after.debtWei))} xETH\n`);
  process.stdout.write(`Health factor: ${formatEther(BigInt(before.healthFactorWad))} -> ${formatEther(BigInt(after.healthFactorWad))}\n`);
  process.stdout.write(`Report: ${REPORT_JSON}\n`);
}

function marketConfigFromManifest(config: ExecutionStagingConfig): XLayerProtocolConfig {
  const protocol = config.protocol!;
  return {
    chainId: XLAYER_TESTNET_CHAIN_ID,
    rpcUrl: config.rpcUrl!,
    explorerUrl: "https://www.oklink.com/x-layer-test",
    forkBlock: config.anchorBlockNumber!,
    contracts: {
      addressesProvider: protocol.addressesProvider as Address,
      aavePool: protocol.aavePool as Address,
      aaveOracle: protocol.aaveOracle as Address,
      xbEthOracleSource: config.testnetDeployment!.oracleSources.xbEth,
      xethOracleSource: config.testnetDeployment!.oracleSources.xeth,
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

async function runRevisions(input: {
  now: Date;
  store: InMemoryStore;
  userPolicy: UserProtectionPolicy;
  marketProvider: { getContext: XLayerMarketContextProvider["getContext"] };
  riskAttestor: ReturnType<typeof privateKeyToAccount>;
}): Promise<Array<{ revision: string; event: RiskEventRecord }>> {
  const result: Array<{ revision: string; event: RiskEventRecord }> = [];
  for (const [revision, rawContent] of Object.entries(REPLAY_REVISIONS)) {
    const pipeline = new EgressRiskPipeline({
      ingestion: new SourceIngestionService(
        new InMemorySourceFetcher(new Map([[REPLAY_SOURCE.id, { rawContent, retrievedAt: input.now.toISOString() }]])),
        input.store,
      ),
      revisionStore: input.store,
      analyzer: new DeterministicReplayAnalyzer(() => input.now),
      attestationSigner: new RiskAttestationSigner(input.riskAttestor),
      marketProvider: input.marketProvider,
      policyEngine: new DeterministicPolicyEngine(),
      auditLogger: new RiskAuditLogger(input.store),
      now: () => input.now,
    });
    const evaluated = await pipeline.run({
      source: REPLAY_SOURCE,
      corroboratingSources: [],
      policy: input.userPolicy,
      runtime: runtime(input.now),
      mode: "REPLAY",
      verdictTtlSeconds: Number(input.userPolicy.verdictMaxAgeSeconds),
    });
    assert(evaluated.status === "EVALUATED" && evaluated.event, `Revision ${revision} did not evaluate.`);
    result.push({ revision, event: evaluated.event });
  }
  return result;
}

function runtime(now: Date): PolicyRuntimeState {
  return {
    evaluatedAt: now.toISOString(),
    lastExecutionAt: null,
    authorizationNonce: "11001",
    revocationNonce: "0",
    nonceAlreadyUsed: false,
    executorPaused: false,
    userAuthorizationSignature: null,
    collateralAuthorizationAvailable: false,
  };
}

async function readPosition(
  publicClient: ReturnType<typeof createPublicClient>,
  pool: Address,
  aToken: Address,
  debtToken: Address,
  borrower: Address,
) {
  const [account, collateral, debt] = await Promise.all([
    publicClient.readContract({ address: pool, abi: compatibilityPoolAbi, functionName: "getUserAccountData", args: [borrower] }),
    publicClient.readContract({ address: aToken, abi: erc20Abi, functionName: "balanceOf", args: [borrower] }),
    publicClient.readContract({ address: debtToken, abi: erc20Abi, functionName: "balanceOf", args: [borrower] }),
  ]);
  return {
    collateralWei: collateral.toString(),
    debtWei: debt.toString(),
    healthFactorWad: account[5].toString(),
  };
}

function decodeReserve(asset: Address, raw: bigint) {
  return {
    asset,
    rawData: raw.toString(),
    ltvBps: Number(raw & 0xffffn),
    liquidationThresholdBps: Number((raw >> 16n) & 0xffffn),
    liquidationBonusBps: Number((raw >> 32n) & 0xffffn),
    decimals: Number((raw >> 48n) & 0xffn),
    active: ((raw >> 56n) & 1n) === 1n,
    frozen: ((raw >> 57n) & 1n) === 1n,
    borrowingEnabled: ((raw >> 58n) & 1n) === 1n,
    paused: ((raw >> 60n) & 1n) === 1n,
  };
}

function queryClient(sql: ReturnType<typeof neon>) {
  return {
    query: (queryText: string, params?: unknown[]) =>
      sql.query(queryText, params) as Promise<Record<string, unknown>[]>,
  };
}

async function readDatabaseIdentity(sql: ReturnType<typeof neon>) {
  const rows = await sql.query("SELECT current_database() AS database_name, current_user AS role_name") as Record<string, unknown>[];
  const row = rows[0];
  assert(row, "PostgreSQL identity query returned no rows.");
  return { databaseName: String(row.database_name), roleName: String(row.role_name) };
}

async function readProtectedHistory(input: {
  archiveSql: ReturnType<typeof neon>;
  workerSql: ReturnType<typeof neon>;
}): Promise<Record<string, string>> {
  const [archiveRows, sourceRows] = await Promise.all([
    input.archiveSql.query(`SELECT
      (SELECT count(*)::text FROM egress_live_snapshots) AS snapshots,
      (SELECT count(*)::text FROM egress_live_snapshot_observations) AS observations,
      (SELECT count(*)::text FROM egress_schema_migrations) AS migrations`),
    input.workerSql.query(`SELECT
      (SELECT count(*)::text FROM egress_rwa_source_revisions) AS source_revisions,
      (SELECT count(*)::text FROM egress_rwa_source_diffs) AS source_diffs`),
  ]) as [Record<string, unknown>[], Record<string, unknown>[]];
  return Object.fromEntries(Object.entries({ ...archiveRows[0], ...sourceRows[0] }).map(([key, value]) => [key, String(value)]));
}

function assertSimulation(result: ExecutionStagingResult): asserts result is ExecutionStagingResult & {
  intent: NonNullable<ExecutionStagingResult["intent"]>;
  simulation: NonNullable<ExecutionStagingResult["simulation"]>;
} {
  assert(result.status === "SIMULATED", `Expected SIMULATED, received ${result.status}: ${result.reason}`);
  assert(result.intent && result.simulation?.status === "PASSED", "Simulation evidence is incomplete.");
}

function requiredKey(value: string | undefined, key: string): Hex {
  const raw = value?.trim() || "";
  if (!/^0x[0-9a-fA-F]{64}$/.test(raw)) throw new Error(`${key} must be a 32-byte hex key.`);
  return raw as Hex;
}

function assertAddress(actual: string, expected: string, message: string): void {
  if (actual.toLowerCase() !== expected.toLowerCase()) throw new Error(message);
}

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

await main();
