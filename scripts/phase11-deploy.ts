import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import {
  concatHex,
  createPublicClient,
  createWalletClient,
  encodeAbiParameters,
  encodeDeployData,
  encodeFunctionData,
  http,
  isAddress,
  keccak256,
  parseAbiParameters,
  type Address,
  type Hex,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import {
  assertPhase11DeploymentStartupSafe,
  buildPolicyRegistrationRequest,
  confirmedPhase11DeploymentTransactions,
  createPhase11DeploymentJournal,
  createTestnetDeploymentManifest,
  egressAutonomousAbi,
  executePhase11DeploymentTransaction,
  executionProtocolConfigHash,
  finalizePhase11DeploymentJournal,
  finalizePhase11DeploymentTransaction,
  loadPhase11DeploymentJournal,
  persistFinalPhase11Manifest,
  persistNewPhase11DeploymentJournal,
  persistPhase11DeploymentJournal,
  phase11DeploymentConfigurationHash,
  phase11DeploymentId,
  phase11DeploymentJournalPath,
  PHASE11_DEPLOYMENT_MANIFEST_SCHEMA_VERSION,
  PHASE11_DEPLOYMENT_FINALITY_POLICY,
  PHASE11_DEPLOYMENT_FINALITY_POLICY_VERSION,
  PHASE11_DEPLOYMENT_SEQUENCE,
  signProtectionPolicy,
  testnetExecutionBoundsSchema,
  validatePhase11EvmIdentities,
  verifyTestnetDeploymentRuntime,
  XLAYER_TESTNET_CHAIN_ID,
  XLAYER_TESTNET_ENVIRONMENT_ID,
  type Phase11DeploymentActionId,
} from "../packages/risk-engine/src/index.js";
import {
  phase11FinalityExpectationFromIntent,
  phase11FinalityExpectationFromProvenance,
  waitForPhase11CanonicalInclusion,
} from "../packages/risk-engine/src/staging/testnet-deployment-finality.js";
import { aTokenPermitAuthorizationAbi } from "../packages/risk-engine/src/market/abis.js";
import { buildPhase11ScenarioPolicy } from "./phase11-policy.js";

const ROOT = resolve(".");
const OUT = resolve(ROOT, process.env.EGRESS_PHASE11_MANIFEST_PATH?.trim() || "deployments/phase11/xlayer-testnet.json");
const JOURNAL = resolve(
  ROOT,
  phase11DeploymentJournalPath(OUT, process.env.EGRESS_PHASE11_JOURNAL_PATH),
);
const TOKEN_DECIMALS = 18;
const POOL_FEE = 100;
const OUTPUT_NUMERATOR = 10_200n;
const OUTPUT_DENOMINATOR = 10_000n;
const POLICY_NONCE = "11001";
const POLICY_LIFETIME_SECONDS = 30n * 24n * 60n * 60n;
const PERMIT_PARAMETERS = parseAbiParameters(
  "bytes32 typeHash,address owner,address spender,uint256 value,uint256 nonce,uint256 deadline",
);

type Artifact = { abi: readonly unknown[]; bytecode: { object: string } };
type Deployment = { address: Address };

async function main(): Promise<void> {
  const rpcUrl = requiredUrl("EGRESS_EXECUTION_RPC_URL");
  const deployerKey = requiredKey("EGRESS_PHASE11_DEPLOYER_PRIVATE_KEY");
  const borrowerKey = requiredKey("EGRESS_PHASE11_BORROWER_PRIVATE_KEY");
  const keeper = requiredAddress("EGRESS_EXECUTION_KEEPER_ADDRESS");
  const borrower = requiredAddress("EGRESS_PHASE11_BORROWER_ADDRESS");
  const riskAttestor = requiredAddress("EGRESS_PHASE11_RISK_ATTESTOR_ADDRESS");
  const startingNonce = requiredNonce("EGRESS_PHASE11_STARTING_NONCE");
  const label = process.env.EGRESS_PHASE11_COMPATIBILITY_LABEL?.trim();
  if (!label) throw new Error("EGRESS_PHASE11_COMPATIBILITY_LABEL is required.");
  const boundsRaw = process.env.EGRESS_PHASE11_EXECUTION_BOUNDS_JSON?.trim();
  if (!boundsRaw) throw new Error("EGRESS_PHASE11_EXECUTION_BOUNDS_JSON is required.");
  const bounds = testnetExecutionBoundsSchema.parse(JSON.parse(boundsRaw));

  const account = privateKeyToAccount(deployerKey);
  const borrowerAccount = privateKeyToAccount(borrowerKey);
  validatePhase11EvmIdentities({
    deployer: account.address,
    keeper,
    borrower,
    riskAttestor,
  });
  if (borrowerAccount.address.toLowerCase() !== borrower.toLowerCase()) {
    throw new Error("EGRESS_PHASE11_BORROWER_PRIVATE_KEY does not match EGRESS_PHASE11_BORROWER_ADDRESS.");
  }
  const configurationHash = phase11DeploymentConfigurationHash({
    chainId: XLAYER_TESTNET_CHAIN_ID,
    environmentId: XLAYER_TESTNET_ENVIRONMENT_ID,
    deployer: account.address,
    keeper,
    borrower,
    riskAttestor,
    compatibilityLabel: label,
    executionBounds: bounds,
    startingNonce: String(startingNonce),
  });
  const deploymentId = phase11DeploymentId({
    chainId: XLAYER_TESTNET_CHAIN_ID,
    environmentId: XLAYER_TESTNET_ENVIRONMENT_ID,
    deployer: account.address,
    startingNonce: String(startingNonce),
    configurationHash,
  });
  const startupIdentity = {
    manifestPath: OUT,
    journalPath: JOURNAL,
    deploymentId,
    chainId: XLAYER_TESTNET_CHAIN_ID,
    environmentId: XLAYER_TESTNET_ENVIRONMENT_ID,
    deployer: account.address,
    startingNonce: String(startingNonce),
    configurationHash,
  } as const;
  await assertPhase11DeploymentStartupSafe(startupIdentity);
  const chain = {
    id: XLAYER_TESTNET_CHAIN_ID,
    name: "Egress X Layer testnet",
    nativeCurrency: { name: "OKB", symbol: "OKB", decimals: 18 },
    rpcUrls: { default: { http: [rpcUrl] } },
  } as const;
  const publicClient = createPublicClient({ chain, transport: http(rpcUrl) });
  const walletClient = createWalletClient({ account, chain, transport: http(rpcUrl) });
  const chainId = await publicClient.getChainId();
  if (chainId !== XLAYER_TESTNET_CHAIN_ID) throw new Error(`RPC returned chain ${chainId}, expected ${XLAYER_TESTNET_CHAIN_ID}.`);
  const observedPendingNonce = await publicClient.getTransactionCount({
    address: account.address,
    blockTag: "pending",
  });
  await assertPhase11DeploymentStartupSafe({ ...startupIdentity, observedPendingNonce });
  await persistNewPhase11DeploymentJournal(JOURNAL, createPhase11DeploymentJournal({
    deploymentId,
    chainId: XLAYER_TESTNET_CHAIN_ID,
    environmentId: XLAYER_TESTNET_ENVIRONMENT_ID,
    deployer: account.address,
    startingNonce: String(startingNonce),
    configurationHash,
    createdAt: new Date().toISOString(),
  }));

  const execute = async (
    actionId: Phase11DeploymentActionId,
    to: Address | null,
    data: Hex,
  ) => {
    const sequenceEntry = PHASE11_DEPLOYMENT_SEQUENCE.find((entry) => entry.actionId === actionId);
    if (!sequenceEntry) throw new Error(`Unknown Phase 11 deployment action ${actionId}.`);
    const nonce = startingNonce + sequenceEntry.sequence - 1;
    return executePhase11DeploymentTransaction({
      journalPath: JOURNAL,
      intent: {
        deploymentId,
        chainId: XLAYER_TESTNET_CHAIN_ID,
        environmentId: XLAYER_TESTNET_ENVIRONMENT_ID,
        sequence: sequenceEntry.sequence,
        actionId,
        from: account.address,
        nonce,
        to,
        value: 0n,
        data,
      },
      broadcast: async () => walletClient.sendTransaction({
        account,
        chain,
        data,
        nonce,
        value: 0n,
        ...(to ? { to } : {}),
      } as never),
      waitForReceipt: async (hash) => {
        const receipt = await publicClient.waitForTransactionReceipt({ hash });
        return {
          transactionHash: receipt.transactionHash,
          status: receipt.status,
          blockNumber: receipt.blockNumber,
          blockHash: receipt.blockHash,
          transactionIndex: receipt.transactionIndex,
          contractAddress: receipt.contractAddress,
          from: receipt.from,
          to: receipt.to,
        };
      },
      waitForSafeInclusion: async (hash, intent) => waitForPhase11CanonicalInclusion(publicClient, {
        expectation: phase11FinalityExpectationFromIntent(intent, hash),
        stage: "SAFE_CANONICAL",
      }),
    });
  };
  const deploy = async (
    actionId: Phase11DeploymentActionId,
    contract: string,
    args: readonly unknown[] = [],
  ): Promise<Deployment> => {
    const artifact = await artifactFor(contract);
    const data = encodeDeployData({
      abi: artifact.abi,
      bytecode: `0x${artifact.bytecode.object.replace(/^0x/, "")}` as Hex,
      args,
    } as never);
    const provenance = await execute(actionId, null, data);
    if (!provenance.contractAddress) throw new Error(`Deployment of ${contract} produced no contract address.`);
    return { address: provenance.contractAddress };
  };
  const write = async (
    actionId: Phase11DeploymentActionId,
    deployment: Deployment,
    contract: string,
    functionName: string,
    args: readonly unknown[] = [],
  ) => {
    const artifact = await artifactFor(contract);
    const data = encodeFunctionData({
      abi: artifact.abi,
      functionName,
      args,
    } as never);
    await execute(actionId, deployment.address, data);
  };

  const xbEth = await deploy("DEPLOY_XBETH", "Phase11Token", ["Egress Testnet xBETH", "txBETH", TOKEN_DECIMALS]);
  const xeth = await deploy("DEPLOY_XETH", "Phase11Token", ["Egress Testnet xETH", "txETH", TOKEN_DECIMALS]);
  const provider = await deploy("DEPLOY_ADDRESSES_PROVIDER", "Phase11AddressesProvider");
  const oracle = await deploy("DEPLOY_ORACLE", "Phase11Oracle");
  const pool = await deploy(
    "DEPLOY_AAVE_POOL",
    "Phase11AavePool",
    [provider.address, oracle.address, xbEth.address, xeth.address],
  );
  const aXbEth = await deploy("DEPLOY_ATOKEN", "Phase11AToken", [pool.address, xbEth.address]);
  const variableDebtXeth = await deploy(
    "DEPLOY_VARIABLE_DEBT_TOKEN",
    "Phase11VariableDebtToken",
    [pool.address, xeth.address],
  );
  await write("CONFIGURE_PROVIDER", provider, "Phase11AddressesProvider", "configure", [pool.address, oracle.address]);
  await write(
    "CONFIGURE_POOL_RESERVES",
    pool,
    "Phase11AavePool",
    "configureReserves",
    [aXbEth.address, variableDebtXeth.address],
  );
  await write("ENABLE_XBETH_MINTER", xbEth, "Phase11Token", "setMinter", [pool.address, true]);
  await write("ENABLE_XETH_MINTER", xeth, "Phase11Token", "setMinter", [pool.address, true]);
  await write("ENABLE_ATOKEN_MINTER", aXbEth, "Phase11AToken", "setMinter", [pool.address, true]);
  await write(
    "ENABLE_DEBT_TOKEN_MINTER",
    variableDebtXeth,
    "Phase11VariableDebtToken",
    "setMinter",
    [pool.address, true],
  );
  await write("SET_XBETH_ORACLE_PRICE", oracle, "Phase11Oracle", "setAssetPrice", [xbEth.address, 100_000_000n]);
  await write("SET_XETH_ORACLE_PRICE", oracle, "Phase11Oracle", "setAssetPrice", [xeth.address, 100_000_000n]);

  const factory = await deploy("DEPLOY_SWAP_FACTORY", "Phase11SwapFactory");
  const router = await deploy("DEPLOY_SWAP_ROUTER", "Phase11SwapRouter", [factory.address]);
  const quoter = await deploy("DEPLOY_QUOTER", "Phase11QuoterV2", [factory.address]);
  const swapPool = await deploy("DEPLOY_SWAP_POOL", "Phase11SwapPool", [
    factory.address,
    router.address,
    xbEth.address,
    xeth.address,
    POOL_FEE,
    OUTPUT_NUMERATOR,
    OUTPUT_DENOMINATOR,
  ]);
  await write(
    "CONFIGURE_SWAP_FACTORY",
    factory,
    "Phase11SwapFactory",
    "configure",
    [swapPool.address, xbEth.address, xeth.address, POOL_FEE],
  );
  await write("MINT_XBETH_SWAP_LIQUIDITY", xbEth, "Phase11Token", "mint", [swapPool.address, 1_000n * 10n ** 18n]);
  await write("MINT_XETH_SWAP_LIQUIDITY", xeth, "Phase11Token", "mint", [swapPool.address, 1_000n * 10n ** 18n]);
  await write(
    "SEED_BORROWER_POSITION",
    pool,
    "Phase11AavePool",
    "seedPosition",
    [borrower, 50n * 10n ** 18n, 44n * 10n ** 18n],
  );
  await write("SEED_FLASH_LIQUIDITY", pool, "Phase11AavePool", "seedFlashLiquidity", [500n * 10n ** 18n]);

  const egress = await deploy("DEPLOY_EGRESS_EXECUTOR", "EgressExecutor", [{
    pool: pool.address,
    poolAddressesProvider: provider.address,
    aaveOracle: oracle.address,
    xeth: xeth.address,
    xbEth: xbEth.address,
    aXbEth: aXbEth.address,
    variableDebtXeth: variableDebtXeth.address,
    uniswapFactory: factory.address,
    swapRouter: router.address,
    swapPool: swapPool.address,
    poolFee: POOL_FEE,
  }]);
  const protocol = {
    addressesProvider: provider.address,
    aavePool: pool.address,
    aaveOracle: oracle.address,
    xbEth: xbEth.address,
    xeth: xeth.address,
    aXbEth: aXbEth.address,
    variableDebtXeth: variableDebtXeth.address,
    uniswapFactory: factory.address,
    swapRouter: router.address,
    quoterV2: quoter.address,
    swapPool: swapPool.address,
    poolFee: POOL_FEE,
  };
  const protocolConfigHash = executionProtocolConfigHash(protocol);
  const policyBlock = await publicClient.getBlock({ blockTag: "latest" });
  const policyExpiresAt = (policyBlock.timestamp + POLICY_LIFETIME_SECONDS).toString();
  const scenarioPolicy = buildPhase11ScenarioPolicy({
    borrower,
    keeper,
    riskAttestor,
    egressContract: egress.address,
    protocolConfigHash,
    bounds,
    policyNonce: POLICY_NONCE,
    policyExpiresAt,
    revocationNonce: 0n,
  });
  const policySignature = await signProtectionPolicy({
    account: borrowerAccount,
    chainId: XLAYER_TESTNET_CHAIN_ID,
    egressContract: egress.address,
    policy: scenarioPolicy.onchainPolicy,
  });
  const permitDeadline = BigInt(scenarioPolicy.onchainPolicy.expiresAt);
  const permitSignature = await signPermit({
    publicClient,
    borrower: borrowerAccount,
    token: aXbEth.address,
    egressContract: egress.address,
    amount: BigInt(scenarioPolicy.onchainPolicy.maxCumulativeCollateral),
    deadline: permitDeadline,
  });
  const registration = buildPolicyRegistrationRequest({
    policy: scenarioPolicy.onchainPolicy,
    policySignature,
    permitDeadline,
    permitSignature,
  });
  const registrationArgs = [
    registration.policy,
    registration.policySignature,
    registration.collateralPermit,
  ] as const;
  await publicClient.simulateContract({
    account,
    address: egress.address,
    abi: egressAutonomousAbi,
    functionName: "registerProtectionPolicy",
    args: registrationArgs,
  });
  const registrationCalldata = encodeFunctionData({
    abi: egressAutonomousAbi,
    functionName: "registerProtectionPolicy",
    args: registrationArgs,
  });
  const policyRegistration = await execute(
    "REGISTER_PROTECTION_POLICY",
    egress.address,
    registrationCalldata,
  );
  const policyRegistrationTransactionHash = policyRegistration.transactionHash;

  for (let sequence = 1; sequence <= PHASE11_DEPLOYMENT_SEQUENCE.length; sequence += 1) {
    await finalizePhase11DeploymentTransaction({
      journalPath: JOURNAL,
      sequence,
      waitForFinalizedInclusion: async (safeTransaction) => waitForPhase11CanonicalInclusion(publicClient, {
        expectation: phase11FinalityExpectationFromProvenance(safeTransaction),
        stage: "FINALIZED_CANONICAL",
      }),
    });
  }

  const completedJournal = await loadPhase11DeploymentJournal(JOURNAL);
  const deploymentTransactions = confirmedPhase11DeploymentTransactions(completedJournal);
  const finalTransaction = deploymentTransactions[deploymentTransactions.length - 1];
  if (!finalTransaction) throw new Error("Phase 11 deployment journal has no final transaction.");
  const finalBlock = await publicClient.getBlock({ blockNumber: BigInt(finalTransaction.finalizedInclusion.blockNumber) });
  if (!finalBlock.hash || finalBlock.hash.toLowerCase() !== finalTransaction.finalizedInclusion.blockHash.toLowerCase()) {
    throw new Error("Final deployment block hash does not match the policy-registration receipt.");
  }
  const runtimeCodeHashes = await codeHashes(publicClient, {
    egressContract: egress.address,
    addressesProvider: provider.address,
    aavePool: pool.address,
    aaveOracle: oracle.address,
    xbEthOracleSource: oracle.address,
    xethOracleSource: oracle.address,
    xbEth: xbEth.address,
    xeth: xeth.address,
    aXbEth: aXbEth.address,
    variableDebtXeth: variableDebtXeth.address,
    uniswapFactory: factory.address,
    swapRouter: router.address,
    quoterV2: quoter.address,
    swapPool: swapPool.address,
  });
  const manifest = createTestnetDeploymentManifest({
    schemaVersion: PHASE11_DEPLOYMENT_MANIFEST_SCHEMA_VERSION,
    manifestType: "EGRESS_XLAYER_TESTNET_COMPATIBILITY",
    environmentId: XLAYER_TESTNET_ENVIRONMENT_ID,
    compatibilityLabel: label,
    chainId: XLAYER_TESTNET_CHAIN_ID,
    deploymentId,
    finalityPolicy: {
      version: PHASE11_DEPLOYMENT_FINALITY_POLICY_VERSION,
      publication: PHASE11_DEPLOYMENT_FINALITY_POLICY,
      safeTag: "safe",
      finalizedTag: "finalized",
    },
    startingNonce: String(startingNonce),
    configurationHash,
    deploymentBlockNumber: finalTransaction.finalizedInclusion.blockNumber,
    deploymentBlockHash: finalTransaction.finalizedInclusion.blockHash,
    deploymentTransactions,
    egressContract: egress.address,
    guardian: account.address,
    keeper,
    protocol,
    oracleSources: { xbEth: oracle.address, xeth: oracle.address },
    protocolConfigHash,
    executionBounds: bounds,
    scenario: {
      borrower,
      riskAttestor,
      initialCollateralWei: (50n * 10n ** 18n).toString(),
      initialDebtWei: (44n * 10n ** 18n).toString(),
      policyNonce: POLICY_NONCE,
      policyExpiresAt,
      policyId: scenarioPolicy.policyId,
      policyRegistrationTransactionHash,
    },
    runtimeCodeHashes,
    tokens: {
      xbEth: { address: xbEth.address, name: "Egress Testnet xBETH", symbol: "txBETH", decimals: 18 },
      xeth: { address: xeth.address, name: "Egress Testnet xETH", symbol: "txETH", decimals: 18 },
      aXbEth: { address: aXbEth.address, name: "Egress Testnet Aave xBETH", symbol: "atxBETH", decimals: 18 },
      variableDebtXeth: {
        address: variableDebtXeth.address,
        name: "Egress Testnet Variable Debt xETH",
        symbol: "variableDebtTxETH",
        decimals: 18,
      },
    },
  });
  await verifyTestnetDeploymentRuntime(publicClient, {
    manifest,
    config: {
      environmentId: manifest.environmentId,
      manifestHash: manifest.manifestHash,
      chainId: manifest.chainId,
      anchorBlockNumber: BigInt(manifest.deploymentBlockNumber),
      anchorBlockHash: manifest.deploymentBlockHash,
      egressContract: manifest.egressContract,
      keeperAddress: manifest.keeper,
      protocol: manifest.protocol,
    },
  });
  await persistFinalPhase11Manifest(OUT, manifest);
  await persistPhase11DeploymentJournal(
    JOURNAL,
    finalizePhase11DeploymentJournal(completedJournal, manifest.manifestHash, new Date().toISOString()),
  );
  process.stdout.write(`${JSON.stringify({
    environmentId: manifest.environmentId,
    chainId: manifest.chainId,
    manifestHash: manifest.manifestHash,
    deploymentBlockNumber: manifest.deploymentBlockNumber,
    egressContract: manifest.egressContract,
    keeper: manifest.keeper,
    policyId: manifest.scenario.policyId,
    policyRegistrationTransactionHash: manifest.scenario.policyRegistrationTransactionHash,
    manifestPath: OUT,
  })}\n`);
}

async function artifactFor(contract: string): Promise<Artifact> {
  const candidates = [
    resolve(ROOT, `out/Phase11Compatibility.sol/${contract}.json`),
    resolve(ROOT, `out/EgressExecutor.sol/${contract}.json`),
  ];
  for (const path of candidates) {
    try {
      return JSON.parse(await readFile(path, "utf8")) as Artifact;
    } catch {
      // Try the next Foundry artifact path.
    }
  }
  throw new Error(`Foundry artifact for ${contract} was not found. Run forge build first.`);
}

async function signPermit(input: {
  publicClient: ReturnType<typeof createPublicClient>;
  borrower: ReturnType<typeof privateKeyToAccount>;
  token: Address;
  egressContract: Address;
  amount: bigint;
  deadline: bigint;
}): Promise<Hex> {
  const [nonce, domainSeparator, typeHash] = await Promise.all([
    input.publicClient.readContract({
      address: input.token,
      abi: aTokenPermitAuthorizationAbi,
      functionName: "nonces",
      args: [input.borrower.address],
    }),
    input.publicClient.readContract({
      address: input.token,
      abi: aTokenPermitAuthorizationAbi,
      functionName: "DOMAIN_SEPARATOR",
    }),
    input.publicClient.readContract({
      address: input.token,
      abi: aTokenPermitAuthorizationAbi,
      functionName: "PERMIT_TYPEHASH",
    }),
  ]);
  const structHash = keccak256(encodeAbiParameters(PERMIT_PARAMETERS, [
    typeHash,
    input.borrower.address,
    input.egressContract,
    input.amount,
    nonce,
    input.deadline,
  ]));
  return input.borrower.sign({
    hash: keccak256(concatHex(["0x1901", domainSeparator, structHash])),
  });
}

async function codeHashes<const T extends Record<string, Address>>(
  publicClient: ReturnType<typeof createPublicClient>,
  addresses: T,
): Promise<{ [K in keyof T]: Hex }> {
  const entries = await Promise.all((Object.entries(addresses) as Array<[keyof T, Address]>).map(async ([role, address]) => {
    const bytecode = await publicClient.getBytecode({ address });
    if (!bytecode || bytecode === "0x") throw new Error(`No runtime bytecode at ${String(role)} ${address}.`);
    return [role, keccak256(bytecode)] as const;
  }));
  return Object.fromEntries(entries) as { [K in keyof T]: Hex };
}

function requiredUrl(key: string): string {
  const raw = process.env[key]?.trim() || "";
  if (!raw) throw new Error(`${key} is required.`);
  const parsed = new URL(raw);
  if (parsed.protocol !== "https:" || parsed.hostname === "localhost" || parsed.hostname === "127.0.0.1") {
    throw new Error(`${key} must be a non-local HTTPS endpoint.`);
  }
  if (parsed.username || parsed.password) throw new Error(`${key} must not contain embedded credentials.`);
  return parsed.toString();
}

function requiredKey(key: string): Hex {
  const raw = process.env[key]?.trim() || "";
  if (!/^0x[0-9a-fA-F]{64}$/.test(raw)) throw new Error(`${key} must be a 32-byte hex key.`);
  return raw as Hex;
}

function requiredAddress(key: string): Address {
  const raw = process.env[key]?.trim() || "";
  if (!isAddress(raw)) throw new Error(`${key} must be an EVM address.`);
  return raw as Address;
}

function requiredNonce(key: string): number {
  const raw = process.env[key]?.trim() || "";
  if (!/^(0|[1-9][0-9]*)$/.test(raw)) throw new Error(`${key} must be an explicit non-negative decimal integer.`);
  const nonce = Number(raw);
  const maximumStart = Number.MAX_SAFE_INTEGER - (PHASE11_DEPLOYMENT_SEQUENCE.length - 1);
  if (!Number.isSafeInteger(nonce) || nonce > maximumStart) {
    throw new Error(`${key} is outside the supported safe-integer nonce range.`);
  }
  return nonce;
}

await main();
