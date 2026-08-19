import { spawn, type ChildProcess } from "node:child_process";
import { once } from "node:events";
import { mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { neon } from "@neondatabase/serverless";
import {
  formatEther,
  parseEventLogs,
  type Hex,
} from "viem";
import {
  assertArchiveDatabasePrivileges,
  assertExecutionWorkerDatabasePrivileges,
  assertPhase10ForkHarnessConfig,
  buildArchivedLiveSnapshot,
  DeterministicReplayAnalyzer,
  EgressExecutionStagingWorker,
  EgressShadowKeeper,
  egressAutonomousAbi,
  executionProtocolFromConfig,
  executionStagingRequestSchema,
  identifyExecutionEnvironment,
  InMemorySourceFetcher,
  LiveRiskSnapshotService,
  OkxRwaReadAdapter,
  PostgresExecutionStagingStore,
  PostgresLiveSnapshotArchive,
  PostgresStagingSnapshotReader,
  readPhase10ForkHarnessConfig,
  validateDatabaseMigrations,
  verifyArchivedLiveSnapshot,
  verifyExecutionFingerprint,
  verifyExecutionSimulation,
  verifyExecutionStagingIntent,
  verifyExecutionSubmission,
  ViemExecutionSubmitter,
  XLAYER_MAINNET,
  type ExecutionStagingConfig,
  type ExecutionStagingResult,
  type ExecutionSubmitter,
} from "../packages/risk-engine/src/index.js";
import {
  aTokenPermitAuthorizationAbi,
  erc20Abi,
} from "../packages/risk-engine/src/market/abis.js";
import {
  REPLAY_REVISIONS,
  REPLAY_SOURCE,
} from "../packages/risk-engine/src/replay/fixtures.js";
import {
  assert,
  BORROWER,
  EXPECTED_FORK_BLOCK,
  KEEPER,
  LOCAL_RPC,
  readPosition,
  rpc,
  setupPinnedForkScenario,
} from "./phase5-fork.js";

const LABEL = "EGRESS PHASE 10 PINNED X LAYER FORK EXECUTION";
const REPORT_DIRECTORY = resolve("reports/phase10");
const REPORT_JSON = resolve(REPORT_DIRECTORY, "pinned-fork-execution.json");
const REPORT_MARKDOWN = resolve(REPORT_DIRECTORY, "pinned-fork-execution.md");

async function main(): Promise<void> {
  const harnessConfig = readPhase10ForkHarnessConfig(process.env);
  assertPhase10ForkHarnessConfig(harnessConfig);

  process.stdout.write("[EGRESS] Validating Phase 10 PostgreSQL roles and migrations\n");
  const archiveSql = neon(harnessConfig.archiveDatabaseUrl) as ReturnType<typeof neon>;
  const workerSql = neon(harnessConfig.workerDatabaseUrl) as ReturnType<typeof neon>;
  const [archiveMigrations, workerMigrations, archiveIdentity, workerIdentity] = await Promise.all([
    validateDatabaseMigrations(queryClient(archiveSql)),
    validateDatabaseMigrations(queryClient(workerSql)),
    readDatabaseIdentity(archiveSql),
    readDatabaseIdentity(workerSql),
  ]);
  assert(archiveMigrations.appliedVersion === 4, "Archive database must have migrations 0001 through 0004");
  assert(workerMigrations.appliedVersion === 4, "Worker database must have migrations 0001 through 0004");
  assert(
    archiveIdentity.databaseName === workerIdentity.databaseName,
    "Archive and execution roles must target the same dedicated Phase 10 database",
  );
  assert(
    archiveIdentity.roleName !== workerIdentity.roleName,
    "Archive and execution worker credentials must use distinct PostgreSQL roles",
  );
  await assertArchiveDatabasePrivileges(harnessConfig.archiveDatabaseUrl);
  const workerPrivileges = await assertExecutionWorkerDatabasePrivileges(
    harnessConfig.workerDatabaseUrl,
  );

  const anvil = await ensureLocalAnvil();
  try {
    const scenario = await setupPinnedForkScenario({
      forkRpcUrl: harnessConfig.upstreamRpcUrl,
    });
    assert(scenario.metadata.forkedNetwork, "Anvil did not expose pinned fork metadata");
    assert(scenario.eventBlock.number !== null, "Scenario event block has no number");
    assert(scenario.eventBlock.hash !== null, "Scenario event block has no hash");

    const rwaAdapter = new OkxRwaReadAdapter(scenario.store, {
      fetcher: new InMemorySourceFetcher(new Map([
        [REPLAY_SOURCE.id, {
          rawContent: REPLAY_REVISIONS.C,
          retrievedAt: scenario.eventNow.toISOString(),
        }],
      ])) as never,
      analyzer: new DeterministicReplayAnalyzer(() => scenario.eventNow),
      now: () => scenario.eventNow,
      maxAgeSeconds: 86_400,
      sources: [REPLAY_SOURCE],
      riskEventId: scenario.revisionC.event.riskEventId,
    });
    const snapshotService = new LiveRiskSnapshotService({
      rpcUrl: LOCAL_RPC,
      client: scenario.publicClient,
      account: BORROWER.address,
      policy: scenario.userPolicy,
      egressSpender: scenario.egressContract,
      store: scenario.store,
      now: () => scenario.eventNow,
      observationBlockNumber: scenario.eventBlock.number,
      observationBlockHash: scenario.eventBlock.hash,
      maxBlockAgeSeconds: 120,
      maxOracleAgeSeconds: 21_600,
      maxSourceAgeSeconds: 86_400,
      rwaAdapter,
      marketProvider: scenario.marketProvider,
    });

    process.stdout.write("[EGRESS] Building deterministic same-block archived snapshot\n");
    const firstEnvelope = await snapshotService.read();
    const secondEnvelope = await snapshotService.read();
    assert(firstEnvelope.status === "AVAILABLE" && firstEnvelope.snapshot, firstEnvelope.reasons.join("; "));
    assert(secondEnvelope.status === "AVAILABLE" && secondEnvelope.snapshot, secondEnvelope.reasons.join("; "));
    assert(
      firstEnvelope.snapshot.snapshotHash === secondEnvelope.snapshot.snapshotHash,
      "Repeated pinned state did not produce the same canonical snapshot hash",
    );
    assert(
      firstEnvelope.snapshot.rwa.verdictId === scenario.revisionC.event.verdict.verdictId,
      "Archived RWA evidence does not match the replay-C risk verdict",
    );

    const archivedSnapshot = buildArchivedLiveSnapshot(
      firstEnvelope,
      scenario.eventNow.toISOString(),
    );
    assert(archivedSnapshot.archiveStatus === "COMPLETE", "Pinned snapshot is not COMPLETE");
    assert(archivedSnapshot.consistencyStatus === "CONSISTENT", "Pinned snapshot is not same-block consistent");
    assert(verifyArchivedLiveSnapshot(archivedSnapshot), "Pinned snapshot integrity verification failed");

    const archive = new PostgresLiveSnapshotArchive(
      harnessConfig.archiveDatabaseUrl,
      archiveSql,
    );
    const archived = await archive.archive(archivedSnapshot, scenario.eventNow.toISOString());
    assert(
      archived.entry.snapshot.integrityHash === archivedSnapshot.integrityHash,
      "PostgreSQL returned different canonical snapshot evidence",
    );

    const snapshotReader = new PostgresStagingSnapshotReader(
      harnessConfig.workerDatabaseUrl,
      workerSql,
    );
    const stagingStore = new PostgresExecutionStagingStore(
      harnessConfig.workerDatabaseUrl,
      workerSql,
    );
    const workerSnapshot = await snapshotReader.get(archivedSnapshot.snapshotHash);
    assert(workerSnapshot, "Execution worker role cannot read the archived Phase 10 snapshot");
    assert(
      workerSnapshot.integrityHash === archivedSnapshot.integrityHash,
      "Execution worker read a snapshot with a different integrity hash",
    );
    const protectedHistoryBefore = await readProtectedHistory({ archiveSql, workerSql });

    const stagingConfig = createStagingConfig({
      databaseUrl: harnessConfig.workerDatabaseUrl,
      egressContract: scenario.egressContract,
      anchorBlockHash: scenario.metadata.forkedNetwork.forkBlockHash,
      submissionEnabled: false,
    });
    const request = executionStagingRequestSchema.parse({
      schemaVersion: 1,
      actionType: "AAVE_XBETH_XETH_DELEVERAGE",
      snapshotHash: archivedSnapshot.snapshotHash,
      riskEvent: scenario.task.event,
      policy: scenario.onchainPolicy,
      policyAuthorizationSignature: scenario.policySignature,
      riskAttestation: scenario.task.attestation,
      environment: "FORK_WRITE",
      requestedAt: scenario.eventNow.toISOString(),
    });
    const keeper = new EgressShadowKeeper({
      publicClient: scenario.publicClient,
      marketProvider: scenario.marketProvider,
      keeperAccount: KEEPER,
      now: () => scenario.eventNow,
    });
    const workerDependencies = {
      snapshotReader,
      store: stagingStore,
      keeper,
      identifyEnvironment: async () => identifyExecutionEnvironment(scenario.publicClient, stagingConfig),
      readBlockHash: async (blockNumber: bigint) =>
        (await scenario.publicClient.getBlock({ blockNumber })).hash,
      now: () => scenario.eventNow,
    };

    process.stdout.write("[EGRESS] Proving deterministic intent and simulation replay\n");
    const simulationWorker = new EgressExecutionStagingWorker({
      config: stagingConfig,
      ...workerDependencies,
    });
    const firstSimulation = await simulationWorker.stage(request);
    const secondSimulation = await simulationWorker.stage(request);
    assertSimulation(firstSimulation);
    assertSimulation(secondSimulation);
    assert(
      firstSimulation.intent.intentHash === secondSimulation.intent.intentHash,
      "Repeated archived snapshot produced a different execution intent",
    );
    assert(
      firstSimulation.simulation.simulationHash === secondSimulation.simulation.simulationHash,
      "Repeated archived snapshot produced a different simulation record",
    );

    const before = await readPosition(scenario.publicClient);
    const submissionConfig = { ...stagingConfig, submissionEnabled: true };
    const viemSubmitter = new ViemExecutionSubmitter({
      walletClient: scenario.keeperClient,
      publicClient: scenario.publicClient,
    });
    let submitterCalls = 0;
    const countedSubmitter: ExecutionSubmitter = {
      submit: async (input) => {
        submitterCalls += 1;
        return viemSubmitter.submit(input);
      },
    };
    const submissionWorker = () => new EgressExecutionStagingWorker({
      config: submissionConfig,
      ...workerDependencies,
      submitter: countedSubmitter,
    });

    process.stdout.write("[EGRESS] Reserving and submitting the exact simulated fork transaction\n");
    const concurrentResults = await Promise.all([
      submissionWorker().stage(request),
      submissionWorker().stage(request),
    ]);
    const confirmed = concurrentResults.find((result) => result.status === "CONFIRMED");
    const duplicate = concurrentResults.find((result) => result.code === "DUPLICATE_EXECUTION");
    assert(confirmed?.intent && confirmed.simulation && confirmed.submission, "No Phase 10 fork submission was confirmed");
    assert(duplicate, "Concurrent duplicate staging did not fail with DUPLICATE_EXECUTION");
    assert(submitterCalls === 1, `Expected one submitter call, received ${submitterCalls}`);
    assert(confirmed.submission.schemaVersion === 2, "Submission does not contain Phase 10 binding evidence");
    assert(verifyExecutionStagingIntent(confirmed.intent), "Stored execution intent integrity failed");
    assert(verifyExecutionSimulation(confirmed.simulation), "Stored execution simulation integrity failed");
    assert(verifyExecutionSubmission(confirmed.submission), "Stored execution submission integrity failed");
    assert(
      verifyExecutionFingerprint({
        fingerprint: confirmed.submission.executionFingerprint as Hex,
        intent: confirmed.intent,
        simulation: confirmed.simulation,
        transactionBinding: confirmed.submission.transactionBinding,
      }),
      "Submission fingerprint does not bind the intent, simulation, and transaction",
    );
    assert(
      confirmed.submission.simulationHash === confirmed.simulation.simulationHash,
      "Submission evidence references a different simulation",
    );
    assert(
      confirmed.submission.intentHash === confirmed.intent.intentHash,
      "Submission evidence references a different intent",
    );

    const after = await readPosition(scenario.publicClient);
    assert(BigInt(after.debtWei) < BigInt(before.debtWei), "Fork execution did not reduce xETH debt");
    assert(BigInt(after.healthFactorWad) > BigInt(before.healthFactorWad), "Fork execution did not improve health factor");
    const postEventPermitNonce = await scenario.publicClient.readContract({
      address: XLAYER_MAINNET.contracts.aXbEth,
      abi: aTokenPermitAuthorizationAbi,
      functionName: "nonces",
      args: [BORROWER.address],
    });
    assert(
      postEventPermitNonce === scenario.permitNonceAfterSetup,
      "Phase 10 consumed an unexpected post-event user permit",
    );

    const replayAfterExecution = await submissionWorker().stage(request);
    assert(replayAfterExecution.status !== "CONFIRMED", "Archived snapshot replay produced a second execution");
    assert(submitterCalls === 1, "Archived snapshot replay reached the submitter more than once");

    const storedSubmission = await stagingStore.getSubmission(confirmed.intent.intentHash);
    const latestReservation = await stagingStore.latestReservation();
    assert(storedSubmission?.submissionHash === confirmed.submission.submissionHash, "PostgreSQL submission evidence is missing");
    assert(latestReservation?.intentHash === confirmed.intent.intentHash, "PostgreSQL reservation evidence is missing");
    assert(
      latestReservation.executionFingerprint === confirmed.submission.executionFingerprint,
      "Reservation and submission fingerprints differ",
    );
    const protectedHistoryAfter = await readProtectedHistory({ archiveSql, workerSql });
    assert(
      JSON.stringify(protectedHistoryBefore) === JSON.stringify(protectedHistoryAfter),
      "Execution worker mutated canonical observation or OKX source history",
    );

    assert(confirmed.submission.transactionHash, "Confirmed submission has no transaction hash");
    const transactionHash = confirmed.submission.transactionHash as Hex;
    const receipt = await scenario.publicClient.getTransactionReceipt({ hash: transactionHash });
    const [deleveraged] = parseEventLogs({
      abi: egressAutonomousAbi,
      eventName: "Deleveraged",
      logs: receipt.logs,
      strict: true,
    });
    assert(deleveraged, "Confirmed transaction emitted no Deleveraged event");
    const executorResidue = await Promise.all([
      XLAYER_MAINNET.contracts.xeth,
      XLAYER_MAINNET.contracts.xbEth,
      XLAYER_MAINNET.contracts.aXbEth,
    ].map((address) => scenario.publicClient.readContract({
      address,
      abi: erc20Abi,
      functionName: "balanceOf",
      args: [scenario.egressContract],
    })));
    assert(executorResidue.every((value) => value === 0n), "Egress retained an unauthorized token balance");

    const report = {
      label: LABEL,
      schemaVersion: 1,
      generatedAt: new Date().toISOString(),
      status: "COMPLETE",
      environment: {
        mode: "FORK_WRITE",
        localRpc: LOCAL_RPC,
        upstreamRpcOrigin: new URL(harnessConfig.upstreamRpcUrl).origin,
        chainId: XLAYER_MAINNET.chainId,
        forkBlock: EXPECTED_FORK_BLOCK,
        forkBlockHash: scenario.metadata.forkedNetwork.forkBlockHash,
        liveMainnetExecution: "DISABLED",
      },
      database: {
        databaseName: archiveIdentity.databaseName,
        archiveRole: archiveIdentity.roleName,
        workerRole: workerPrivileges.roleName,
        migrationVersion: workerMigrations.appliedVersion,
        workerMissingPrivileges: workerPrivileges.missingRequired,
        workerForbiddenPrivileges: workerPrivileges.forbiddenGranted,
      },
      snapshot: {
        snapshotHash: archivedSnapshot.snapshotHash,
        integrityHash: archivedSnapshot.integrityHash,
        archiveStatus: archivedSnapshot.archiveStatus,
        observedBlock: archivedSnapshot.observedBlock,
        blockHash: archivedSnapshot.blockHash,
        riskClassification: archivedSnapshot.riskClassification,
        inserted: archived.inserted,
        observationInserted: archived.observationInserted,
      },
      deterministicReplay: {
        intentHash: confirmed.intent.intentHash,
        simulationHash: confirmed.simulation.simulationHash,
        repeatedIntentMatched: true,
        repeatedSimulationMatched: true,
      },
      binding: {
        executionFingerprint: confirmed.submission.executionFingerprint,
        transactionBinding: confirmed.submission.transactionBinding,
        contractRequestHash: confirmed.intent.contractRequestHash,
      },
      execution: {
        transactionHash,
        blockNumber: receipt.blockNumber.toString(),
        gasUsed: receipt.gasUsed.toString(),
        debtBeforeWei: before.debtWei,
        debtAfterWei: after.debtWei,
        healthFactorBeforeWad: before.healthFactorWad,
        healthFactorAfterWad: after.healthFactorWad,
        debtRepaidWei: deleveraged.args.debtRepaid.toString(),
        collateralSoldWei: deleveraged.args.collateralSold.toString(),
        swapOutputWei: deleveraged.args.swapOutput.toString(),
        flashPremiumWei: deleveraged.args.flashPremium.toString(),
        surplusReturnedWei: deleveraged.args.surplusReturned.toString(),
      },
      idempotency: {
        concurrentDuplicateRejected: true,
        postExecutionReplayRejected: true,
        submitterCalls,
        reservationId: latestReservation.reservationId,
        submissionHash: confirmed.submission.submissionHash,
      },
      assertions: {
        archivedSnapshotVerified: true,
        sameBlockSnapshot: true,
        exactSimulationSubmissionBinding: true,
        debtDecreased: true,
        healthFactorImproved: true,
        noPostEventUserPermit: true,
        noExecutorResidue: true,
        canonicalHistoryUnchangedByWorker: true,
        okxRevisionHistoryUnchangedByWorker: true,
        liveMainnetExecutionDisabled: true,
      },
    };
    await mkdir(REPORT_DIRECTORY, { recursive: true });
    await writeFile(REPORT_JSON, `${JSON.stringify(report, null, 2)}\n`, "utf8");
    await writeFile(REPORT_MARKDOWN, markdownReport(report), "utf8");

    process.stdout.write(`${LABEL}\n`);
    process.stdout.write(`Snapshot: ${archivedSnapshot.snapshotHash}\n`);
    process.stdout.write(`Intent: ${confirmed.intent.intentHash}\n`);
    process.stdout.write(`Fingerprint: ${confirmed.submission.executionFingerprint}\n`);
    process.stdout.write(`Transaction: ${transactionHash}\n`);
    process.stdout.write(`Health factor: ${formatEther(BigInt(before.healthFactorWad))} -> ${formatEther(BigInt(after.healthFactorWad))}\n`);
    process.stdout.write(`Report: ${REPORT_JSON}\n`);
  } finally {
    await stopLocalAnvil(anvil);
  }
}

function createStagingConfig(input: {
  databaseUrl: string;
  egressContract: `0x${string}`;
  anchorBlockHash: Hex;
  submissionEnabled: boolean;
}): ExecutionStagingConfig {
  return {
    environment: "FORK_WRITE",
    submissionEnabled: input.submissionEnabled,
    rpcUrl: LOCAL_RPC,
    chainId: XLAYER_MAINNET.chainId,
    egressContract: input.egressContract,
    keeperAddress: KEEPER,
    protocol: executionProtocolFromConfig(XLAYER_MAINNET),
    anchorBlockNumber: BigInt(EXPECTED_FORK_BLOCK),
    anchorBlockHash: input.anchorBlockHash,
    forkRuntime: "ANVIL",
    databaseUrl: input.databaseUrl,
    environmentId: null,
    credentialReference: null,
    testnetManifestPath: null,
    testnetManifestHash: null,
    testnetDeployment: null,
    maxSnapshotAgeSeconds: 300,
    maxIntentAgeSeconds: 300,
    issues: [],
  };
}

function assertSimulation(
  result: ExecutionStagingResult,
): asserts result is ExecutionStagingResult & {
  intent: NonNullable<ExecutionStagingResult["intent"]>;
  simulation: NonNullable<ExecutionStagingResult["simulation"]>;
} {
  assert(result.status === "SIMULATED", `Expected SIMULATED, received ${result.status}: ${result.reason}`);
  assert(result.intent, "Simulation did not persist an execution intent");
  assert(result.simulation?.status === "PASSED", "Simulation did not persist a passing result");
}

async function ensureLocalAnvil(): Promise<ChildProcess | null> {
  if (await isLocalAnvilAvailable()) return null;
  process.stdout.write(`[EGRESS] Starting local Anvil at ${LOCAL_RPC}\n`);
  const child = spawn("anvil", [
    "--host",
    "127.0.0.1",
    "--port",
    "8545",
    "--chain-id",
    String(XLAYER_MAINNET.chainId),
    "--silent",
  ], { stdio: ["ignore", "pipe", "pipe"] });
  let startupError: Error | null = null;
  let stderr = "";
  child.once("error", (error) => { startupError = error; });
  child.stderr?.on("data", (chunk: Buffer) => {
    stderr = `${stderr}${chunk.toString("utf8")}`.slice(-4_000);
  });
  for (let attempt = 0; attempt < 80; attempt += 1) {
    if (startupError) throw startupError;
    if (child.exitCode !== null) {
      throw new Error(`Anvil exited before becoming ready: ${stderr.trim() || `exit ${child.exitCode}`}`);
    }
    if (await isLocalAnvilAvailable()) return child;
    await delay(250);
  }
  child.kill("SIGTERM");
  throw new Error(`Anvil did not become ready at ${LOCAL_RPC}. ${stderr.trim()}`.trim());
}

async function stopLocalAnvil(child: ChildProcess | null): Promise<void> {
  if (!child || child.exitCode !== null) return;
  child.kill("SIGTERM");
  await Promise.race([once(child, "exit"), delay(2_000)]);
  if (child.exitCode === null) child.kill("SIGKILL");
}

async function isLocalAnvilAvailable(): Promise<boolean> {
  try {
    const version = await rpc<string>("web3_clientVersion");
    return version.toLowerCase().includes("anvil");
  } catch {
    return false;
  }
}

function queryClient(sql: ReturnType<typeof neon>) {
  return {
    query: (queryText: string, params?: unknown[]) =>
      sql.query(queryText, params) as Promise<Record<string, unknown>[]>,
  };
}

async function readDatabaseIdentity(sql: ReturnType<typeof neon>): Promise<{
  databaseName: string;
  roleName: string;
}> {
  const rows = await sql.query(
    "SELECT current_database() AS database_name, current_user AS role_name",
  ) as Record<string, unknown>[];
  const row = rows[0];
  assert(row, "PostgreSQL identity query returned no rows");
  return {
    databaseName: String(row.database_name),
    roleName: String(row.role_name),
  };
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
  const archiveRow = archiveRows[0];
  const sourceRow = sourceRows[0];
  assert(archiveRow && sourceRow, "PostgreSQL protected-history query returned no rows");
  return Object.fromEntries(
    Object.entries({ ...archiveRow, ...sourceRow }).map(([key, value]) => [key, String(value)]),
  );
}

function markdownReport(report: {
  snapshot: { snapshotHash: string; observedBlock: string | null; blockHash: string | null };
  deterministicReplay: { intentHash: string; simulationHash: string };
  binding: { executionFingerprint: string; transactionBinding: { calldataHash: string } };
  execution: {
    transactionHash: string;
    gasUsed: string;
    debtBeforeWei: string;
    debtAfterWei: string;
    healthFactorBeforeWad: string;
    healthFactorAfterWad: string;
  };
  idempotency: { reservationId: string; submitterCalls: number };
}): string {
  return `# Egress Phase 10 pinned-fork execution

> **PINNED X LAYER FORK SIMULATION** - this report records a local Anvil fork execution. LIVE MAINNET EXECUTION remains disabled.

- Snapshot: \`${report.snapshot.snapshotHash}\`
- Snapshot block: \`${report.snapshot.observedBlock}\`
- Snapshot block hash: \`${report.snapshot.blockHash}\`
- Intent: \`${report.deterministicReplay.intentHash}\`
- Simulation: \`${report.deterministicReplay.simulationHash}\`
- Execution fingerprint: \`${report.binding.executionFingerprint}\`
- Calldata hash: \`${report.binding.transactionBinding.calldataHash}\`
- Reservation: \`${report.idempotency.reservationId}\`
- Transaction: \`${report.execution.transactionHash}\`
- Gas used: \`${report.execution.gasUsed}\`
- Submitter calls across concurrent attempts: \`${report.idempotency.submitterCalls}\`

## Result

- xETH debt: ${formatEther(BigInt(report.execution.debtBeforeWei))} -> ${formatEther(BigInt(report.execution.debtAfterWei))}
- Health factor: ${formatEther(BigInt(report.execution.healthFactorBeforeWad))} -> ${formatEther(BigInt(report.execution.healthFactorAfterWad))}

The PostgreSQL execution role read the immutable canonical snapshot, appended only staging evidence, reserved the intent once, and submitted exactly the transaction envelope bound to the successful simulation fingerprint. A concurrent duplicate was rejected before a second wallet submission.
`;
}

await main();
