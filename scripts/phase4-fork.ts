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
  parseEther,
  type Abi,
  type Address,
  type Hex,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import {
  DeterministicPolicyEngine,
  DeterministicReplayAnalyzer,
  EGRESS_AUTHORIZATION_TYPES,
  EgressExecutionCoordinator,
  EgressRiskPipeline,
  InMemorySourceFetcher,
  InMemoryStore,
  RiskAttestationSigner,
  RiskAuditLogger,
  SourceIngestionService,
  XLAYER_MAINNET,
  XLayerMarketContextProvider,
  egressAuthorizationDomain,
  executorAuthorizationMessage,
  type PolicyRuntimeState,
  type RiskEventRecord,
  type UserProtectionPolicy,
} from "../packages/risk-engine/src/index.js";
import {
  aTokenPermitAuthorizationAbi,
  egressExecutorStateAbi,
  erc20Abi,
} from "../packages/risk-engine/src/market/abis.js";
import {
  REPLAY_REVISIONS,
  REPLAY_SOURCE,
} from "../packages/risk-engine/src/replay/fixtures.js";

const LABEL = "PINNED X LAYER FORK SIMULATION";
const LOCAL_RPC = "http://127.0.0.1:8545";
const EXPECTED_FORK_BLOCK = Number(XLAYER_MAINNET.forkBlock);
const BORROWER_PRIVATE_KEY =
  "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80" as Hex;
const BORROWER = privateKeyToAccount(BORROWER_PRIVATE_KEY);
const KEEPER = "0x70997970C51812dc3A010C7d01b50e0d17dc79C8" as Address;
const RISK_ATTESTOR = privateKeyToAccount(
  "0x1111111111111111111111111111111111111111111111111111111111111111",
);
const COLLATERAL = parseEther("50");
const DEBT = parseEther("44.05");
const AUTHORIZATION_NONCE = 4_001n;
const EMODE_CATEGORY = 5;

const xLayerFork = defineChain({
  id: XLAYER_MAINNET.chainId,
  name: "X Layer pinned local fork",
  nativeCurrency: { name: "OKB", symbol: "OKB", decimals: 18 },
  rpcUrls: { default: { http: [LOCAL_RPC] } },
});

function localTransport() {
  return http(LOCAL_RPC, { timeout: 120_000, retryCount: 0 });
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

interface AnvilMetadata {
  chainId: number;
  latestBlockNumber: number;
  forkedNetwork?: {
    chainId: number;
    forkBlockNumber: number;
    forkBlockHash: Hex;
  };
}

interface ExecutorArtifact {
  abi: Abi;
  bytecode: { object: Hex };
}

interface JsonRpcResponse<T> {
  result?: T;
  error?: { code: number; message: string; data?: unknown };
}

async function rpc<T>(method: string, params: unknown[] = []): Promise<T> {
  const response = await fetch(LOCAL_RPC, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
  });
  if (!response.ok) throw new Error(`${method} failed with HTTP ${response.status}`);
  const payload = (await response.json()) as JsonRpcResponse<T>;
  if (payload.error) {
    throw new Error(`${method} failed: ${payload.error.message}`);
  }
  if (payload.result === undefined) throw new Error(`${method} returned no result`);
  return payload.result;
}

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

function sameAddress(left: string, right: string): boolean {
  return left.toLowerCase() === right.toLowerCase();
}

function runtime(now: Date): PolicyRuntimeState {
  return {
    evaluatedAt: now.toISOString(),
    lastExecutionAt: null,
    authorizationNonce: AUTHORIZATION_NONCE.toString(),
    revocationNonce: "0",
    nonceAlreadyUsed: false,
    executorPaused: false,
    userAuthorizationSignature: null,
    collateralAuthorizationAvailable: false,
  };
}

function policy(now: Date, egressContract: Address): UserProtectionPolicy {
  return {
    policyId: "policy_phase4_xbeth_fork_v1",
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
    maximumOraclePoolDeviationBps: 200,
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

async function waitForSuccess(
  publicClient: ReturnType<typeof createPublicClient>,
  hash: Hex,
): Promise<void> {
  const receipt = await publicClient.waitForTransactionReceipt({ hash });
  assert(receipt.status === "success", `Transaction ${hash} reverted`);
}

async function deployExecutor(input: {
  artifact: ExecutorArtifact;
  publicClient: ReturnType<typeof createPublicClient>;
  keeperClient: ReturnType<typeof createWalletClient>;
}): Promise<Address> {
  const contracts = XLAYER_MAINNET.contracts;
  const hash = await input.keeperClient.deployContract({
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
  const receipt = await input.publicClient.waitForTransactionReceipt({ hash });
  assert(receipt.status === "success" && receipt.contractAddress, "Egress deployment failed");
  return receipt.contractAddress;
}

async function createPosition(input: {
  publicClient: ReturnType<typeof createPublicClient>;
  borrowerClient: ReturnType<typeof createWalletClient>;
}): Promise<void> {
  const contracts = XLAYER_MAINNET.contracts;
  await rpc("anvil_setBalance", [contracts.aXbEth, "0x56BC75E2D63100000"]);
  await rpc("anvil_impersonateAccount", [contracts.aXbEth]);
  try {
    const aTokenClient = createWalletClient({
      account: contracts.aXbEth,
      chain: xLayerFork,
      transport: localTransport(),
    });
    const transferHash = await aTokenClient.writeContract({
      address: contracts.xbEth,
      abi: erc20WriteAbi,
      functionName: "transfer",
      args: [BORROWER.address, COLLATERAL],
    });
    await waitForSuccess(input.publicClient, transferHash);
  } finally {
    await rpc("anvil_stopImpersonatingAccount", [contracts.aXbEth]);
  }

  const approveHash = await input.borrowerClient.writeContract({
    address: contracts.xbEth,
    abi: erc20WriteAbi,
    functionName: "approve",
    args: [contracts.aavePool, COLLATERAL],
  });
  await waitForSuccess(input.publicClient, approveHash);

  const supplyHash = await input.borrowerClient.writeContract({
    address: contracts.aavePool,
    abi: aaveWriteAbi,
    functionName: "supply",
    args: [contracts.xbEth, COLLATERAL, BORROWER.address, 0],
  });
  await waitForSuccess(input.publicClient, supplyHash);

  const eModeHash = await input.borrowerClient.writeContract({
    address: contracts.aavePool,
    abi: aaveWriteAbi,
    functionName: "setUserEMode",
    args: [EMODE_CATEGORY],
    gas: 1_000_000n,
  });
  await waitForSuccess(input.publicClient, eModeHash);

  const borrowHash = await input.borrowerClient.writeContract({
    address: contracts.aavePool,
    abi: aaveWriteAbi,
    functionName: "borrow",
    args: [contracts.xeth, DEBT, 2n, 0, BORROWER.address],
  });
  await waitForSuccess(input.publicClient, borrowHash);
}

async function runRevisions(input: {
  now: Date;
  store: InMemoryStore;
  policy: UserProtectionPolicy;
  marketProvider: XLayerMarketContextProvider;
}): Promise<Array<{ revision: string; event: RiskEventRecord }>> {
  const outputs: Array<{ revision: string; event: RiskEventRecord }> = [];
  for (const [revision, rawContent] of Object.entries(REPLAY_REVISIONS)) {
    const pipeline = new EgressRiskPipeline({
      ingestion: new SourceIngestionService(
        new InMemorySourceFetcher(
          new Map([
            [REPLAY_SOURCE.id, { rawContent, retrievedAt: input.now.toISOString() }],
          ]),
        ),
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
    const result = await pipeline.run({
      source: REPLAY_SOURCE,
      corroboratingSources: [],
      policy: input.policy,
      runtime: runtime(input.now),
      mode: "REPLAY",
      verdictTtlSeconds: 900,
    });
    assert(result.status === "EVALUATED" && result.event, `Revision ${revision} did not evaluate`);
    outputs.push({ revision, event: result.event });
  }
  return outputs;
}

async function signCollateralPermit(input: {
  publicClient: ReturnType<typeof createPublicClient>;
  egressContract: Address;
  collateralAmount: bigint;
  deadline: bigint;
}): Promise<Hex> {
  const aToken = XLAYER_MAINNET.contracts.aXbEth;
  const [nonce, domainSeparator, permitTypeHash] = await Promise.all([
    input.publicClient.readContract({
      address: aToken,
      abi: aTokenPermitAuthorizationAbi,
      functionName: "nonces",
      args: [BORROWER.address],
    }),
    input.publicClient.readContract({
      address: aToken,
      abi: aTokenPermitAuthorizationAbi,
      functionName: "DOMAIN_SEPARATOR",
    }),
    input.publicClient.readContract({
      address: aToken,
      abi: aTokenPermitAuthorizationAbi,
      functionName: "PERMIT_TYPEHASH",
    }),
  ]);
  const structHash = keccak256(
    encodeAbiParameters(PERMIT_PARAMETERS, [
      permitTypeHash,
      BORROWER.address,
      input.egressContract,
      input.collateralAmount,
      nonce,
      input.deadline,
    ]),
  );
  return BORROWER.sign({ hash: keccak256(concatHex(["0x1901", domainSeparator, structHash])) });
}

async function readPosition(publicClient: ReturnType<typeof createPublicClient>) {
  const contracts = XLAYER_MAINNET.contracts;
  const [account, collateral, debt] = await Promise.all([
    publicClient.readContract({
      address: contracts.aavePool,
      abi: aaveWriteAbi,
      functionName: "getUserAccountData",
      args: [BORROWER.address],
    }),
    publicClient.readContract({
      address: contracts.aXbEth,
      abi: erc20Abi,
      functionName: "balanceOf",
      args: [BORROWER.address],
    }),
    publicClient.readContract({
      address: contracts.variableDebtXeth,
      abi: erc20Abi,
      functionName: "balanceOf",
      args: [BORROWER.address],
    }),
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

async function main(): Promise<void> {
  await rpc("anvil_reset", [
    { forking: { jsonRpcUrl: XLAYER_MAINNET.rpcUrl, blockNumber: EXPECTED_FORK_BLOCK } },
  ]);
  const metadata = await rpc<AnvilMetadata>("anvil_metadata");
  assert(metadata.chainId === XLAYER_MAINNET.chainId, "Local RPC is not X Layer chain 196");
  assert(
    metadata.forkedNetwork?.chainId === XLAYER_MAINNET.chainId &&
      metadata.forkedNetwork.forkBlockNumber === EXPECTED_FORK_BLOCK,
    `Anvil must be forked from X Layer block ${EXPECTED_FORK_BLOCK}`,
  );

  const publicClient = createPublicClient({ chain: xLayerFork, transport: localTransport() });
  const borrowerClient = createWalletClient({
    account: BORROWER,
    chain: xLayerFork,
    transport: localTransport(),
  });
  const keeperClient = createWalletClient({
    account: KEEPER,
    chain: xLayerFork,
    transport: localTransport(),
  });
  assert((await publicClient.getChainId()) === XLAYER_MAINNET.chainId, "Unexpected RPC chain ID");

  const artifactPath = resolve("out/EgressExecutor.sol/EgressExecutor.json");
  const artifact = JSON.parse(await readFile(artifactPath, "utf8")) as ExecutorArtifact;
  assert(artifact.bytecode.object.startsWith("0x"), "Executor artifact has no deployable bytecode");

  const egressContract = await deployExecutor({ artifact, publicClient, keeperClient });
  await createPosition({ publicClient, borrowerClient });
  const positionBefore = await readPosition(publicClient);

  const latestBlock = await publicClient.getBlock();
  const decisionNow = new Date(Number(latestBlock.timestamp) * 1_000);
  const userPolicy = policy(decisionNow, egressContract);
  const store = new InMemoryStore();
  const auditLogger = new RiskAuditLogger(store);
  const marketProvider = new XLayerMarketContextProvider(XLAYER_MAINNET, {
    client: publicClient,
    now: () => decisionNow,
  });
  const revisions = await runRevisions({
    now: decisionNow,
    store,
    policy: userPolicy,
    marketProvider,
  });
  const revisionA = revisions.find((item) => item.revision === "A")!;
  const revisionB = revisions.find((item) => item.revision === "B")!;
  const revisionC = revisions.find((item) => item.revision === "C")!;

  assert(revisionA.event.verdict.riskLevel === "NORMAL", "Revision A must remain normal");
  assert(revisionA.event.intent?.status === "REJECTED", "Revision A must not execute");
  assert(revisionB.event.verdict.riskLevel === "MEDIUM", "Revision B must be medium risk");
  assert(revisionB.event.intent?.status === "REJECTED", "Revision B must not execute");
  assert(revisionC.event.verdict.riskLevel === "HIGH", "Revision C must be high risk");
  assert(
    revisionC.event.intent?.status === "AWAITING_USER_SIGNATURE" &&
      revisionC.event.intent.authorization,
    "Revision C must produce a bounded intent awaiting the user",
  );

  const intent = revisionC.event.intent;
  const authorization = intent.authorization;
  const userAuthorizationSignature = await BORROWER.signTypedData({
    domain: egressAuthorizationDomain({
      chainId: intent.chainId,
      egressContract,
    }),
    types: EGRESS_AUTHORIZATION_TYPES,
    primaryType: "Authorization",
    message: executorAuthorizationMessage(authorization),
  });
  const permitDeadline = BigInt(authorization.deadline);
  const collateralPermitSignature = await signCollateralPermit({
    publicClient,
    egressContract,
    collateralAmount: BigInt(authorization.collateralAmount),
    deadline: permitDeadline,
  });

  const coordinator = new EgressExecutionCoordinator({
    publicClient,
    walletClient: keeperClient,
    executorAccount: KEEPER,
    policyEngine: new DeterministicPolicyEngine(),
    auditLogger,
    now: () => decisionNow,
  });
  const outcome = await coordinator.execute({
    event: revisionC.event,
    userAuthorizationSignature,
    collateralPermit: {
      deadline: permitDeadline,
      signature: collateralPermitSignature,
    },
    broadcast: true,
  });

  assert(
    outcome.event.executionResult?.status === "CONFIRMED",
    `Fork execution was not confirmed: ${outcome.event.executionResult?.status ?? "missing result"}`,
  );
  const positionAfter = await readPosition(publicClient);
  const nonceUsed = await publicClient.readContract({
    address: egressContract,
    abi: egressExecutorStateAbi,
    functionName: "authorizationUsed",
    args: [BORROWER.address, AUTHORIZATION_NONCE],
  });
  const remainingAllowance = await publicClient.readContract({
    address: XLAYER_MAINNET.contracts.aXbEth,
    abi: erc20Abi,
    functionName: "allowance",
    args: [BORROWER.address, egressContract],
  });

  assert(nonceUsed, "Executor nonce was not consumed");
  assert(BigInt(positionAfter.debtWei) < BigInt(positionBefore.debtWei), "Debt did not decrease");
  assert(
    BigInt(positionAfter.collateralWei) < BigInt(positionBefore.collateralWei),
    "Collateral did not decrease by the bounded sale",
  );
  assert(
    BigInt(positionAfter.healthFactorWad) > BigInt(positionBefore.healthFactorWad),
    "Health factor did not improve",
  );
  assert(remainingAllowance === 0n, "Exact collateral permit left a standing allowance");

  const auditedEvent = await auditLogger.get(revisionC.event.riskEventId);
  assert(auditedEvent?.executionResult?.status === "CONFIRMED", "Confirmed audit event was not persisted");

  const report = {
    label: LABEL,
    schemaVersion: 1,
    generatedAt: new Date().toISOString(),
    environment: {
      rpc: LOCAL_RPC,
      chainId: metadata.chainId,
      forkBlock: metadata.forkedNetwork.forkBlockNumber,
      forkBlockHash: metadata.forkedNetwork.forkBlockHash,
      productionRpcUsedByAnvil: XLAYER_MAINNET.rpcUrl,
      liveMainnetBroadcast: false,
    },
    actors: {
      user: BORROWER.address,
      executor: KEEPER,
      riskAttestor: RISK_ATTESTOR.address,
    },
    contracts: {
      egressExecutor: egressContract,
      ...XLAYER_MAINNET.contracts,
      uniswapPoolFee: XLAYER_MAINNET.poolFee,
    },
    sourceRevisions: revisions.map(({ revision, event }) => ({
      revision,
      riskEventId: event.riskEventId,
      sourceRevisionIds: event.sourceRevisionIds,
      diffIds: event.diffIds,
      riskLevel: event.verdict.riskLevel,
      evidenceValid: event.verdict.evidenceValidation.valid,
      intentStatus: event.intent?.status ?? null,
      claims: event.verdict.claims,
    })),
    canonicalRiskEvent: auditedEvent,
    positionBefore,
    execution: {
      authorization,
      userAuthorizationVerified: true,
      collateralPermitVerified: true,
      transactionHash: outcome.event.executionResult.transactionHash,
      blockNumber: outcome.event.executionResult.blockNumber,
      gasUsed: outcome.event.executionResult.gasUsed,
      deleveraged: outcome.event.executionResult.deleveraged,
      nonceConsumed: nonceUsed,
      remainingCollateralAllowanceWei: remainingAllowance.toString(),
    },
    positionAfter,
    deltas: {
      observedNetDebtReductionWei: (
        BigInt(positionBefore.debtWei) - BigInt(positionAfter.debtWei)
      ).toString(),
      signedAndAaveReportedDebtRepaymentWei:
        outcome.event.executionResult.deleveraged?.debtRepaidWei,
      postBlockInterestAccrualWei: (
        BigInt(outcome.event.executionResult.deleveraged!.debtRepaidWei) -
        (BigInt(positionBefore.debtWei) - BigInt(positionAfter.debtWei))
      ).toString(),
      collateralSoldWei: (
        BigInt(positionBefore.collateralWei) - BigInt(positionAfter.collateralWei)
      ).toString(),
      healthFactorIncreaseWad: (
        BigInt(positionAfter.healthFactorWad) - BigInt(positionBefore.healthFactorWad)
      ).toString(),
    },
    assertions: {
      revisionANoExecution: true,
      revisionBNoExecution: true,
      revisionCRequiredUserSignature: true,
      boundedIntentOnly: true,
      contractSimulationRequired: true,
      debtDecreased: true,
      healthFactorImproved: true,
      nonceConsumed: true,
      permitLeftNoStandingAllowance: true,
      liveBroadcastDisabled: true,
    },
  };

  const outputDirectory = resolve("reports/phase4");
  await mkdir(outputDirectory, { recursive: true });
  await writeFile(
    resolve(outputDirectory, "fork-control-loop.json"),
    `${JSON.stringify(report, null, 2)}\n`,
    "utf8",
  );
  const event = outcome.event.executionResult.deleveraged!;
  const markdown = `# Egress Phase 4 control-loop report

> **${LABEL}** - This is a local transaction against real contracts and state forked from X Layer mainnet. It is not a live-mainnet transaction and does not involve real user funds.

- Fork block: \`${metadata.forkedNetwork.forkBlockNumber}\`
- Egress executor: \`${egressContract}\`
- Transaction: \`${outcome.event.executionResult.transactionHash}\`
- Risk transition: \`NORMAL -> MEDIUM -> HIGH\`
- Final policy state: \`${outcome.event.intent?.status}\`

## Position

- Before: ${formatEther(BigInt(positionBefore.collateralWei))} xBETH collateral, ${formatEther(BigInt(positionBefore.debtWei))} xETH debt, HF ${formatEther(BigInt(positionBefore.healthFactorWad))}
- After: ${formatEther(BigInt(positionAfter.collateralWei))} xBETH collateral, ${formatEther(BigInt(positionAfter.debtWei))} xETH debt, HF ${formatEther(BigInt(positionAfter.healthFactorWad))}

## Execution

- Debt repaid: ${formatEther(BigInt(event.debtRepaidWei))} xETH
- Observed net debt reduction after the confirmation block: ${formatEther(
    BigInt(positionBefore.debtWei) - BigInt(positionAfter.debtWei),
  )} xETH (the difference is variable-debt interest accrued between observations)
- Collateral sold: ${formatEther(BigInt(event.collateralSoldWei))} xBETH
- Swap output: ${formatEther(BigInt(event.swapOutputWei))} xETH
- Flash-loan premium: ${formatEther(BigInt(event.flashPremiumWei))} xETH
- Surplus returned: ${formatEther(BigInt(event.surplusReturnedWei))} xETH
- Gas used: ${outcome.event.executionResult.gasUsed}
- Authorization nonce consumed: \`${event.nonce}\`
- Remaining aXbETH allowance: \`0\`

The deterministic replay analyzer classified changed evidence. The deterministic policy engine then calculated and bounded the action from the live forked Aave position and Uniswap quote. The user separately signed the exact Egress authorization and exact aXbETH permit. The model/attestor never held a transaction key or arbitrary-call authority.
`;
  await writeFile(resolve(outputDirectory, "fork-control-loop.md"), markdown, "utf8");

  process.stdout.write(`${LABEL}\n`);
  process.stdout.write(`Revision A: NORMAL / REJECTED\n`);
  process.stdout.write(`Revision B: MEDIUM / REJECTED\n`);
  process.stdout.write(`Revision C: HIGH / CONFIRMED\n`);
  process.stdout.write(`Transaction: ${outcome.event.executionResult.transactionHash}\n`);
  process.stdout.write(
    `Health factor: ${formatEther(BigInt(positionBefore.healthFactorWad))} -> ${formatEther(
      BigInt(positionAfter.healthFactorWad),
    )}\n`,
  );
  process.stdout.write(`Report: reports/phase4/fork-control-loop.json\n`);
}

await main();
