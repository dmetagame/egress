import { mkdir, readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import {
  concatHex,
  createPublicClient,
  createWalletClient,
  defineChain,
  encodeAbiParameters,
  formatEther,
  http,
  keccak256,
  parseAbi,
  parseAbiParameters,
  parseEventLogs,
  parseEther,
  type Abi,
  type Address,
  type Hex,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import {
  buildOnchainProtectionPolicy,
  egressAutonomousAbi,
  EgressRiskPipeline,
  EgressShadowKeeper,
  ShadowKeeperPoller,
  DeterministicPolicyEngine,
  DeterministicReplayAnalyzer,
  InMemorySourceFetcher,
  InMemoryStore,
  RiskAttestationSigner,
  RiskAuditLogger,
  SourceIngestionService,
  XLAYER_MAINNET,
  XLayerMarketContextProvider,
  buildPolicyRegistrationRequest,
  protectionPolicyId,
  signAutonomousRiskAttestation,
  signProtectionPolicy,
  type PolicyRuntimeState,
  type RiskEventRecord,
  type UserProtectionPolicy,
} from "../packages/risk-engine/src/index.js";
import {
  aTokenPermitAuthorizationAbi,
  erc20Abi,
} from "../packages/risk-engine/src/market/abis.js";
import { REPLAY_REVISIONS, REPLAY_SOURCE } from "../packages/risk-engine/src/replay/fixtures.js";

const LABEL = "PINNED X LAYER FORK SIMULATION";
export const LOCAL_RPC = "http://127.0.0.1:8545";
export const EXPECTED_FORK_BLOCK = Number(XLAYER_MAINNET.forkBlock);
const EXECUTE = process.argv.includes("--execute");
const BORROWER_PRIVATE_KEY =
  "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80" as Hex;
export const BORROWER = privateKeyToAccount(BORROWER_PRIVATE_KEY);
export const KEEPER = "0x70997970C51812dc3A010C7d01b50e0d17dc79C8" as Address;
export const RISK_ATTESTOR = privateKeyToAccount(
  "0x1111111111111111111111111111111111111111111111111111111111111111",
);
const COLLATERAL = parseEther("50");
const DEBT = parseEther("44.05");
const EMODE_CATEGORY = 5;

export const xLayerFork = defineChain({
  id: XLAYER_MAINNET.chainId,
  name: "X Layer pinned local fork",
  nativeCurrency: { name: "OKB", symbol: "OKB", decimals: 18 },
  rpcUrls: { default: { http: [LOCAL_RPC] } },
});

export function localTransport() {
  return http(LOCAL_RPC, { timeout: 120_000, retryCount: 0 });
}

export interface AnvilMetadata {
  chainId: number;
  forkedNetwork?: { chainId: number; forkBlockNumber: number; forkBlockHash: Hex };
}

interface ExecutorArtifact {
  abi: Abi;
  bytecode: { object: Hex };
}

interface JsonRpcResponse<T> {
  result?: T;
  error?: { code: number; message: string };
}

export async function rpc<T>(method: string, params: unknown[] = []): Promise<T> {
  const response = await fetch(LOCAL_RPC, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
  });
  if (!response.ok) throw new Error(`${method} failed with HTTP ${response.status}`);
  const payload = (await response.json()) as JsonRpcResponse<T>;
  if (payload.error) throw new Error(`${method} failed: ${payload.error.message}`);
  if (payload.result === undefined) throw new Error(`${method} returned no result`);
  return payload.result;
}

export function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

const erc20WriteAbi = parseAbi([
  "function transfer(address to,uint256 amount) returns (bool)",
  "function approve(address spender,uint256 amount) returns (bool)",
]);
const aaveWriteAbi = parseAbi([
  "function supply(address asset,uint256 amount,address onBehalfOf,uint16 referralCode)",
  "function borrow(address asset,uint256 amount,uint256 interestRateMode,uint16 referralCode,address onBehalfOf)",
  "function setUserEMode(uint8 categoryId)",
  "function getUserAccountData(address user) view returns (uint256 totalCollateralBase,uint256 totalDebtBase,uint256 availableBorrowsBase,uint256 currentLiquidationThreshold,uint256 ltv,uint256 healthFactor)",
]);
const PERMIT_PARAMETERS = parseAbiParameters(
  "bytes32 typeHash,address owner,address spender,uint256 value,uint256 nonce,uint256 deadline",
);

function policy(now: Date, egressContract: Address): UserProtectionPolicy {
  return {
    policyId: "policy_phase5_xbeth_fork_v1",
    policyVersion: 1,
    user: BORROWER.address,
    executor: KEEPER,
    chainId: XLAYER_MAINNET.chainId,
    egressContract,
    approvedRiskAttestor: RISK_ATTESTOR.address,
    riskTrigger: "HIGH",
    minimumConfidence: 0.8,
    triggerHealthFactorWad: parseEther("1.05").toString(),
    minimumPostHealthFactorWad: parseEther("1.065").toString(),
    targetPostHealthFactorWad: parseEther("1.075").toString(),
    maximumRepaymentWei: parseEther("12").toString(),
    maximumCollateralWei: parseEther("12").toString(),
    maximumCollateralPercentageBps: 2_500,
    maximumSlippageBps: 100,
    maximumPriceImpactBps: 100,
    maximumOraclePoolDeviationBps: 125,
    maximumFlashLoanPremiumBps: 5,
    cooldownSeconds: 3_600,
    authorizationExpiresAt: new Date(now.getTime() + 60 * 60 * 1_000).toISOString(),
    intentTtlSeconds: 600,
    verdictMaxAgeSeconds: 900,
    marketMaxAgeSeconds: 120,
    maximumClockSkewSeconds: 15,
    automaticExecutionEnabled: true,
    approvedSourceIds: [REPLAY_SOURCE.id],
  };
}

function runtime(now: Date): PolicyRuntimeState {
  return {
    evaluatedAt: now.toISOString(),
    lastExecutionAt: null,
    authorizationNonce: "5001",
    revocationNonce: "0",
    nonceAlreadyUsed: false,
    executorPaused: false,
    userAuthorizationSignature: null,
    collateralAuthorizationAvailable: false,
  };
}

async function waitForSuccess(
  publicClient: ReturnType<typeof createPublicClient>,
  hash: Hex,
): Promise<ReturnType<typeof publicClient.waitForTransactionReceipt>> {
  const receipt = await publicClient.waitForTransactionReceipt({ hash });
  assert(receipt.status === "success", `Transaction ${hash} reverted`);
  return receipt;
}

async function deployExecutor(input: {
  artifact: ExecutorArtifact;
  publicClient: ReturnType<typeof createPublicClient>;
  keeperClient: ReturnType<typeof createWalletClient>;
}): Promise<Address> {
  const contracts = XLAYER_MAINNET.contracts;
  const account = input.keeperClient.account;
  assert(account, "Keeper wallet has no configured account");
  const hash = await input.keeperClient.deployContract({
    account,
    chain: undefined,
    abi: input.artifact.abi,
    bytecode: input.artifact.bytecode.object,
    args: [
      {
        pool: contracts.aavePool,
        poolAddressesProvider: contracts.addressesProvider,
        aaveOracle: contracts.aaveOracle,
        xeth: contracts.xeth,
        xbEth: contracts.xbEth,
        aXbEth: contracts.aXbEth,
        variableDebtXeth: contracts.variableDebtXeth,
        uniswapFactory: contracts.uniswapFactory,
        swapRouter: contracts.swapRouter,
        swapPool: contracts.swapPool,
        poolFee: XLAYER_MAINNET.poolFee,
      },
    ],
  });
  const receipt = await waitForSuccess(input.publicClient, hash);
  assert(receipt.contractAddress, "Egress deployment did not return an address");
  return receipt.contractAddress;
}

async function createPosition(input: {
  publicClient: ReturnType<typeof createPublicClient>;
  borrowerClient: ReturnType<typeof createWalletClient>;
}): Promise<void> {
  const contracts = XLAYER_MAINNET.contracts;
  const borrowerAccount = input.borrowerClient.account;
  assert(borrowerAccount, "Borrower wallet has no configured account");
  await rpc("anvil_setBalance", [contracts.aXbEth, "0x56BC75E2D63100000"]);
  await rpc("anvil_impersonateAccount", [contracts.aXbEth]);
  try {
    const aTokenClient = createWalletClient({
      account: contracts.aXbEth,
      chain: xLayerFork,
      transport: localTransport(),
    });
    const transferHash = await aTokenClient.writeContract({
      chain: undefined,
      address: contracts.xbEth,
      abi: erc20WriteAbi,
      functionName: "transfer",
      args: [BORROWER.address, COLLATERAL],
    });
    await waitForSuccess(input.publicClient, transferHash);
  } finally {
    await rpc("anvil_stopImpersonatingAccount", [contracts.aXbEth]);
  }
  await waitForSuccess(
    input.publicClient,
    await input.borrowerClient.writeContract({
      account: borrowerAccount,
      chain: undefined,
      address: contracts.xbEth,
      abi: erc20WriteAbi,
      functionName: "approve",
      args: [contracts.aavePool, COLLATERAL],
    }),
  );
  await waitForSuccess(
    input.publicClient,
    await input.borrowerClient.writeContract({
      account: borrowerAccount,
      chain: undefined,
      address: contracts.aavePool,
      abi: aaveWriteAbi,
      functionName: "supply",
      args: [contracts.xbEth, COLLATERAL, BORROWER.address, 0],
    }),
  );
  await waitForSuccess(
    input.publicClient,
    await input.borrowerClient.writeContract({
      account: borrowerAccount,
      chain: undefined,
      address: contracts.aavePool,
      abi: aaveWriteAbi,
      functionName: "setUserEMode",
      args: [EMODE_CATEGORY],
      gas: 1_000_000n,
    }),
  );
  await waitForSuccess(
    input.publicClient,
    await input.borrowerClient.writeContract({
      account: borrowerAccount,
      chain: undefined,
      address: contracts.aavePool,
      abi: aaveWriteAbi,
      functionName: "borrow",
      args: [contracts.xeth, DEBT, 2n, 0, BORROWER.address],
    }),
  );
}

async function signPermit(input: {
  publicClient: ReturnType<typeof createPublicClient>;
  egressContract: Address;
  amount: bigint;
  deadline: bigint;
}): Promise<Hex> {
  const token = XLAYER_MAINNET.contracts.aXbEth;
  const [nonce, domainSeparator, typeHash] = await Promise.all([
    input.publicClient.readContract({ address: token, abi: aTokenPermitAuthorizationAbi, functionName: "nonces", args: [BORROWER.address] }),
    input.publicClient.readContract({ address: token, abi: aTokenPermitAuthorizationAbi, functionName: "DOMAIN_SEPARATOR" }),
    input.publicClient.readContract({ address: token, abi: aTokenPermitAuthorizationAbi, functionName: "PERMIT_TYPEHASH" }),
  ]);
  const structHash = keccak256(encodeAbiParameters(PERMIT_PARAMETERS, [
    typeHash, BORROWER.address, input.egressContract, input.amount, nonce, input.deadline,
  ]));
  return BORROWER.sign({ hash: keccak256(concatHex(["0x1901", domainSeparator, structHash])) });
}

async function runRevisions(input: {
  now: Date;
  store: InMemoryStore;
  userPolicy: UserProtectionPolicy;
  marketProvider: XLayerMarketContextProvider;
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
      attestationSigner: new RiskAttestationSigner(RISK_ATTESTOR),
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
      verdictTtlSeconds: 900,
    });
    assert(evaluated.status === "EVALUATED" && evaluated.event, `Revision ${revision} did not evaluate`);
    result.push({ revision, event: evaluated.event });
  }
  return result;
}

export async function readPosition(publicClient: ReturnType<typeof createPublicClient>) {
  const contracts = XLAYER_MAINNET.contracts;
  const [account, collateral, debt] = await Promise.all([
    publicClient.readContract({ address: contracts.aavePool, abi: aaveWriteAbi, functionName: "getUserAccountData", args: [BORROWER.address] }),
    publicClient.readContract({ address: contracts.aXbEth, abi: erc20Abi, functionName: "balanceOf", args: [BORROWER.address] }),
    publicClient.readContract({ address: contracts.variableDebtXeth, abi: erc20Abi, functionName: "balanceOf", args: [BORROWER.address] }),
  ]);
  return {
    collateralWei: collateral.toString(),
    debtWei: debt.toString(),
    totalCollateralBase: account[0].toString(),
    totalDebtBase: account[1].toString(),
    liquidationThresholdBps: account[3].toString(),
    ltvBps: account[4].toString(),
    healthFactorWad: account[5].toString(),
  };
}

/**
 * Shared deterministic setup for the Phase 5 report and the Phase 10 staging
 * runner. It is intentionally limited to a local Anvil fork and never targets
 * a live wallet or a production RPC.
 */
export async function setupPinnedForkScenario(
  options: { forkRpcUrl?: string } = {},
) {
  const forkRpcUrl = options.forkRpcUrl ?? XLAYER_MAINNET.rpcUrl;
  process.stdout.write("[EGRESS] Resetting pinned X Layer fork\n");
  await rpc("anvil_reset", [{ forking: { jsonRpcUrl: forkRpcUrl, blockNumber: EXPECTED_FORK_BLOCK } }]);
  const metadata = await rpc<AnvilMetadata>("anvil_metadata");
  assert(metadata.chainId === XLAYER_MAINNET.chainId, "Local RPC is not X Layer chain 196");
  assert(
    metadata.forkedNetwork?.chainId === XLAYER_MAINNET.chainId &&
      metadata.forkedNetwork.forkBlockNumber === EXPECTED_FORK_BLOCK,
    `Anvil must be forked from X Layer block ${EXPECTED_FORK_BLOCK}`,
  );
  const publicClient = createPublicClient({ chain: xLayerFork, transport: localTransport() });
  const borrowerClient = createWalletClient({ account: BORROWER, chain: xLayerFork, transport: localTransport() });
  const keeperClient = createWalletClient({ account: KEEPER, chain: xLayerFork, transport: localTransport() });
  const artifact = JSON.parse(await readFile(resolve("out/EgressExecutor.sol/EgressExecutor.json"), "utf8")) as ExecutorArtifact;
  process.stdout.write("[EGRESS] Deploying bounded executor\n");
  const egressContract = await deployExecutor({ artifact, publicClient, keeperClient });
  process.stdout.write(`[EGRESS] Executor: ${egressContract}\n`);
  process.stdout.write("[EGRESS] Creating synthetic xBETH/xETH Aave position\n");
  await createPosition({ publicClient, borrowerClient });

  const setupBlock = await publicClient.getBlock();
  const setupNow = new Date(Number(setupBlock.timestamp) * 1_000);
  const userPolicy = policy(setupNow, egressContract);
  const protocolConfigHash = await publicClient.readContract({ address: egressContract, abi: egressAutonomousAbi, functionName: "PROTOCOL_CONFIG_HASH" });
  const onchainPolicy = buildOnchainProtectionPolicy({
    policy: userPolicy,
    protocolConfigHash,
    nonce: 5_001n,
    revocationNonce: 0n,
    maxExecutions: 1n,
    maxCumulativeRepaymentWei: parseEther("12"),
    maxCumulativeCollateralWei: parseEther("12.5"),
    maxPositionDebtWei: parseEther("46"),
    maxOracleDeviationBps: BigInt(userPolicy.maximumOraclePoolDeviationBps),
  });
  const policySignature = await signProtectionPolicy({
    account: BORROWER,
    chainId: XLAYER_MAINNET.chainId,
    egressContract,
    policy: onchainPolicy,
  });
  const permitDeadline = BigInt(onchainPolicy.expiresAt);
  const permitSignature = await signPermit({
    publicClient,
    egressContract,
    amount: BigInt(onchainPolicy.maxCumulativeCollateral),
    deadline: permitDeadline,
  });
  process.stdout.write("[EGRESS] Registering user-signed protection policy and setup permit\n");
  const registration = buildPolicyRegistrationRequest({
    policy: onchainPolicy,
    policySignature,
    permitDeadline,
    permitSignature,
  });
  const registrationSimulation = await publicClient.simulateContract({
    account: KEEPER,
    address: egressContract,
    abi: egressAutonomousAbi,
    functionName: "registerProtectionPolicy",
    args: [registration.policy, registration.policySignature, registration.collateralPermit],
  });
  const registrationHash = await keeperClient.writeContract({
    ...registrationSimulation.request,
    gas: registrationSimulation.request.gas ? registrationSimulation.request.gas * 3n : 1_500_000n,
  });
  await waitForSuccess(publicClient, registrationHash);
  process.stdout.write(`[EGRESS] Policy registered: ${registrationHash}\n`);
  const permitNonceAfterSetup = await publicClient.readContract({ address: XLAYER_MAINNET.contracts.aXbEth, abi: aTokenPermitAuthorizationAbi, functionName: "nonces", args: [BORROWER.address] });

  const eventBlock = await publicClient.getBlock();
  const eventNow = new Date(Number(eventBlock.timestamp) * 1_000);
  const marketProvider = new XLayerMarketContextProvider(XLAYER_MAINNET, { client: publicClient, now: () => eventNow });
  const store = new InMemoryStore();
  process.stdout.write("[EGRESS] Replaying source revisions A/B/C\n");
  const revisions = await runRevisions({ now: eventNow, store, userPolicy, marketProvider });
  const revisionA = revisions.find((item) => item.revision === "A")!;
  const revisionB = revisions.find((item) => item.revision === "B")!;
  const revisionC = revisions.find((item) => item.revision === "C")!;
  assert(revisionA.event.verdict.riskLevel === "NORMAL" && revisionA.event.intent?.status === "REJECTED", "Revision A must not execute");
  assert(revisionB.event.verdict.riskLevel === "MEDIUM" && revisionB.event.intent?.status === "REJECTED", "Revision B must not execute");
  assert(revisionC.event.verdict.riskLevel === "HIGH", "Revision C must be HIGH");
  const policyId = protectionPolicyId({ chainId: XLAYER_MAINNET.chainId, egressContract, policy: onchainPolicy });
  const autonomousAttestation = await signAutonomousRiskAttestation({
    account: RISK_ATTESTOR,
    verdict: revisionC.event.verdict,
    policyId,
    chainId: XLAYER_MAINNET.chainId,
    egressContract,
    issuedAt: eventNow,
    expiresAt: new Date(eventNow.getTime() + 900_000),
  });
  const task = {
    event: { ...revisionC.event, mode: "TEST" as const },
    policy: onchainPolicy,
    attestation: autonomousAttestation,
  };
  return {
    metadata,
    publicClient,
    borrowerClient,
    keeperClient,
    egressContract,
    userPolicy,
    onchainPolicy,
    policySignature,
    registrationHash,
    permitNonceAfterSetup,
    eventNow,
    eventBlock,
    marketProvider,
    store,
    revisions,
    revisionC,
    policyId,
    task,
  };
}

async function main(): Promise<void> {
  const {
    metadata,
    publicClient,
    keeperClient,
    egressContract,
    onchainPolicy,
    policySignature,
    registrationHash,
    permitNonceAfterSetup,
    eventNow,
    marketProvider,
    revisions,
    policyId,
    task,
  } = await setupPinnedForkScenario({
    forkRpcUrl: process.env.EGRESS_XLAYER_FORK_RPC_URL?.trim() || XLAYER_MAINNET.rpcUrl,
  });
  const forkedNetwork = metadata.forkedNetwork;
  assert(forkedNetwork, "Anvil did not expose fork metadata");
  const keeper = new EgressShadowKeeper({
    publicClient,
    walletClient: EXECUTE ? keeperClient : undefined,
    keeperAccount: KEEPER,
    marketProvider,
    now: () => eventNow,
  });
  process.stdout.write("[EGRESS] Refreshing Aave/liquidity state and simulating exact autonomous call\n");
  const shadowState: {
    decision: Awaited<ReturnType<EgressShadowKeeper["evaluate"]>> | null;
  } = { decision: null };
  const poller = new ShadowKeeperPoller(
    keeper,
    async () => [task],
    (decision) => {
      shadowState.decision = decision;
    },
  );
  await poller.run({ intervalMs: 1_000, maxIterations: 1 });
  const shadowDecision = shadowState.decision;
  assert(shadowDecision, "Shadow keeper produced no decision");
  const before = await readPosition(publicClient);
  if (shadowDecision.status !== "WOULD_EXECUTE") {
    process.stdout.write(`[EGRESS] Shadow rejection: ${shadowDecision.reasons.join("; ")}\n`);
    process.stdout.write(`[EGRESS] Simulation error: ${shadowDecision.simulation.error ?? "none"}\n`);
  }
  assert(shadowDecision.status === "WOULD_EXECUTE", `Shadow keeper refused: ${shadowDecision.reasons.join("; ")}`);
  let executionResult: Awaited<ReturnType<EgressShadowKeeper["executeFork"]>> | null = null;
  if (EXECUTE) {
    process.stdout.write("[EGRESS] Explicit fork broadcast enabled\n");
    executionResult = await keeper.executeFork(task);
  }
  const after = await readPosition(publicClient);
  const permitNonceAfter = await publicClient.readContract({ address: XLAYER_MAINNET.contracts.aXbEth, abi: aTokenPermitAuthorizationAbi, functionName: "nonces", args: [BORROWER.address] });
  assert(!EXECUTE || BigInt(after.debtWei) < BigInt(before.debtWei), "Debt did not decrease");
  assert(!EXECUTE || BigInt(after.healthFactorWad) > BigInt(before.healthFactorWad), "Health factor did not improve");
  assert(permitNonceAfter === permitNonceAfterSetup, "No post-event user permit/signature was consumed");
  let deleveraged: Record<string, string> | null = null;
  if (executionResult) {
    const receipt = await publicClient.getTransactionReceipt({ hash: executionResult.transactionHash });
    const [log] = parseEventLogs({
      abi: egressAutonomousAbi,
      eventName: "Deleveraged",
      logs: receipt.logs,
      strict: true,
    });
    assert(log, "Confirmed autonomous transaction emitted no Deleveraged event");
    deleveraged = {
      user: log.args.user,
      executor: log.args.executor,
      executionNonce: log.args.nonce.toString(),
      executionHash: log.args.authorizationHash,
      debtRepaidWei: log.args.debtRepaid.toString(),
      collateralSoldWei: log.args.collateralSold.toString(),
      swapOutputWei: log.args.swapOutput.toString(),
      flashPremiumWei: log.args.flashPremium.toString(),
      surplusReturnedWei: log.args.surplusReturned.toString(),
      healthFactorBeforeWad: log.args.healthFactorBefore.toString(),
      healthFactorAfterWad: log.args.healthFactorAfter.toString(),
    };
  }

  const report = {
    label: LABEL,
    schemaVersion: 1,
    generatedAt: new Date().toISOString(),
    mode: EXECUTE ? "EXECUTED_FORK" : "SHADOW_ONLY",
    environment: {
      rpc: LOCAL_RPC,
      chainId: metadata.chainId,
      forkBlock: forkedNetwork.forkBlockNumber,
      forkBlockHash: forkedNetwork.forkBlockHash,
      liveMainnetBroadcast: false,
    },
    actors: { user: BORROWER.address, keeper: KEEPER, riskAttestor: RISK_ATTESTOR.address },
    contracts: { egressExecutor: egressContract, ...XLAYER_MAINNET.contracts, uniswapPoolFee: XLAYER_MAINNET.poolFee },
    authorization: {
      policyId,
      policy: onchainPolicy,
      policySignature,
      registrationTransaction: registrationHash,
      permitNonceAfterSetup: permitNonceAfterSetup.toString(),
      postEventPermitNonce: permitNonceAfter.toString(),
      noPostEventUserSignature: true,
    },
    revisions: revisions.map(({ revision, event }) => ({
      revision,
      riskEventId: event.riskEventId,
      riskLevel: event.verdict.riskLevel,
      intentStatus: event.intent?.status ?? null,
      sourceRevisionIds: event.sourceRevisionIds,
      diffIds: event.diffIds,
      evidence: event.verdict.claims,
    })),
    shadowDecision,
    positionBefore: before,
    positionAfter: after,
    execution: executionResult
      ? {
          transactionHash: executionResult.transactionHash,
          blockNumber: executionResult.blockNumber.toString(),
          gasUsed: executionResult.gasUsed.toString(),
          deleveraged,
        }
      : null,
    assertions: {
      userSignedPolicyBeforeRiskEvent: true,
      policyRegisteredOnchain: true,
      revisionsANoExecution: true,
      revisionBNoExecution: true,
      revisionCHighRisk: true,
      shadowSimulationRequired: true,
      noPostEventUserSignature: true,
      liveBroadcastDisabled: true,
      ...(EXECUTE ? { debtDecreased: true, healthFactorImproved: true } : {}),
    },
  };
  await mkdir(resolve("reports/phase5"), { recursive: true });
  await writeFile(resolve("reports/phase5/autonomous-control-loop.json"), `${JSON.stringify(report, null, 2)}\n`, "utf8");
  const markdown = `# Egress Phase 5 autonomous control-loop report

> **${LABEL}** - Real X Layer contracts and liquidity are used inside a local fork. This is not live-mainnet execution.

- Mode: \`${EXECUTE ? "EXECUTED_FORK" : "SHADOW_ONLY"}\`
- Fork block: \`${forkedNetwork.forkBlockNumber}\`
- Egress executor: \`${egressContract}\`
- Policy: \`${policyId}\`
- Risk transition: \`NORMAL -> MEDIUM -> HIGH\`
- Keeper decision: \`${shadowDecision.status}\`

## Authorization

The user signed the bounded policy and setup-time collateral permit before the source revisions were replayed. The keeper, AI, and attestor cannot mutate policy limits. Permit nonce after setup and after the risk event: \`${permitNonceAfterSetup}\` and \`${permitNonceAfter}\`.

## Position

- Before: ${formatEther(BigInt(before.collateralWei))} xBETH, ${formatEther(BigInt(before.debtWei))} xETH, HF ${formatEther(BigInt(before.healthFactorWad))}
- After: ${formatEther(BigInt(after.collateralWei))} xBETH, ${formatEther(BigInt(after.debtWei))} xETH, HF ${formatEther(BigInt(after.healthFactorWad))}

## Execution

${executionResult && deleveraged ? `- Transaction: \`${executionResult.transactionHash}\`\n- Debt repaid: ${formatEther(BigInt(deleveraged.debtRepaidWei!))} xETH\n- Collateral sold: ${formatEther(BigInt(deleveraged.collateralSoldWei!))} xBETH\n- Swap output: ${formatEther(BigInt(deleveraged.swapOutputWei!))} xETH\n- Flash premium: ${formatEther(BigInt(deleveraged.flashPremiumWei!))} xETH\n- Surplus returned: ${formatEther(BigInt(deleveraged.surplusReturnedWei!))} xETH\n- Gas: ${executionResult.gasUsed}\n- Block: ${executionResult.blockNumber}` : "No transaction was broadcast. Shadow mode simulated the exact bounded request only."}

The AI interprets the source revision. The deterministic keeper computes the action from fresh Aave and Uniswap state. The contract independently verifies the pre-authorized policy, attestation, oracle-relative output floor, cooldown, nonce, allowance, and health-factor floor.
`;
  await writeFile(resolve("reports/phase5/autonomous-control-loop.md"), markdown, "utf8");
  process.stdout.write(`${LABEL}\n`);
  process.stdout.write(`Mode: ${EXECUTE ? "EXECUTED_FORK" : "SHADOW_ONLY"}\n`);
  process.stdout.write("Revision A: NORMAL / REJECTED\nRevision B: MEDIUM / REJECTED\nRevision C: HIGH\n");
  process.stdout.write(`Keeper: ${shadowDecision.status}\n`);
  if (executionResult) process.stdout.write(`Transaction: ${executionResult.transactionHash}\n`);
  process.stdout.write(`Report: reports/phase5/autonomous-control-loop.json\n`);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  await main();
}
