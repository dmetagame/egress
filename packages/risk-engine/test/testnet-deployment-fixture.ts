import {
  getContractAddress,
  keccak256,
  stringToHex,
  type Address,
  type Hex,
} from "viem";
import {
  createTestnetDeploymentManifest,
  executionProtocolConfigHash,
  phase11DeploymentConfigurationHash,
  phase11DeploymentId,
  phase11ExpectedTransactionTarget,
  PHASE11_DEPLOYMENT_FINALITY_POLICY,
  PHASE11_DEPLOYMENT_FINALITY_POLICY_VERSION,
  PHASE11_DEPLOYMENT_MANIFEST_SCHEMA_VERSION,
  PHASE11_DEPLOYMENT_SEQUENCE,
  type Phase11DeploymentActionId,
  type Phase11TransactionProvenance,
  type TestnetDeploymentManifest,
} from "../src/index.js";

export const TESTNET_BYTECODE = "0x60006000" as Hex;
export const TESTNET_CODE_HASH = keccak256(TESTNET_BYTECODE);
export const TESTNET_BLOCK_HASH = `0x${"71".repeat(32)}` as Hex;
export const TESTNET_BLOCK_NUMBER = "123456";
export const TESTNET_STARTING_NONCE = "100";
export const TESTNET_POLICY_ID = `0x${"73".repeat(32)}` as Hex;

const COMPATIBILITY_LABEL = "Egress Phase 11 deterministic compatibility deployment";
const address = (value: number) => `0x${value.toString(16).padStart(40, "0")}` as Address;
const guardian = address(2_001);

function deploymentAddress(actionId: Phase11DeploymentActionId): Address {
  const action = PHASE11_DEPLOYMENT_SEQUENCE.find((entry) => entry.actionId === actionId);
  if (!action || action.kind !== "DEPLOYMENT") throw new Error(`${actionId} is not a deployment action.`);
  return getContractAddress({
    from: guardian,
    nonce: BigInt(TESTNET_STARTING_NONCE) + BigInt(action.sequence - 1),
  });
}

export const TESTNET_ADDRESSES = {
  egressContract: deploymentAddress("DEPLOY_EGRESS_EXECUTOR"),
  guardian,
  keeper: address(2_002),
  addressesProvider: deploymentAddress("DEPLOY_ADDRESSES_PROVIDER"),
  aavePool: deploymentAddress("DEPLOY_AAVE_POOL"),
  aaveOracle: deploymentAddress("DEPLOY_ORACLE"),
  xbEth: deploymentAddress("DEPLOY_XBETH"),
  xeth: deploymentAddress("DEPLOY_XETH"),
  aXbEth: deploymentAddress("DEPLOY_ATOKEN"),
  variableDebtXeth: deploymentAddress("DEPLOY_VARIABLE_DEBT_TOKEN"),
  uniswapFactory: deploymentAddress("DEPLOY_SWAP_FACTORY"),
  swapRouter: deploymentAddress("DEPLOY_SWAP_ROUTER"),
  quoterV2: deploymentAddress("DEPLOY_QUOTER"),
  swapPool: deploymentAddress("DEPLOY_SWAP_POOL"),
  borrower: address(2_003),
  riskAttestor: address(2_004),
} as const;

export function testnetTransactionInput(sequence: number): Hex {
  return stringToHex(`egress-phase11-fixture-transaction-${sequence}`);
}

export function testnetTransactionHash(sequence: number): Hex {
  return keccak256(stringToHex(`egress-phase11-fixture-hash-${sequence}`));
}

export function testnetBlockHash(sequence: number): Hex {
  return sequence === PHASE11_DEPLOYMENT_SEQUENCE.length
    ? TESTNET_BLOCK_HASH
    : keccak256(stringToHex(`egress-phase11-fixture-block-${sequence}`));
}

export const TESTNET_TRANSACTION_HASH = testnetTransactionHash(1);
export const TESTNET_POLICY_REGISTRATION_HASH = testnetTransactionHash(26);

export function createTestnetManifestFixture(): TestnetDeploymentManifest {
  const protocol = {
    addressesProvider: TESTNET_ADDRESSES.addressesProvider,
    aavePool: TESTNET_ADDRESSES.aavePool,
    aaveOracle: TESTNET_ADDRESSES.aaveOracle,
    xbEth: TESTNET_ADDRESSES.xbEth,
    xeth: TESTNET_ADDRESSES.xeth,
    aXbEth: TESTNET_ADDRESSES.aXbEth,
    variableDebtXeth: TESTNET_ADDRESSES.variableDebtXeth,
    uniswapFactory: TESTNET_ADDRESSES.uniswapFactory,
    swapRouter: TESTNET_ADDRESSES.swapRouter,
    quoterV2: TESTNET_ADDRESSES.quoterV2,
    swapPool: TESTNET_ADDRESSES.swapPool,
    poolFee: 100,
  };
  const executionBounds = {
    minimumRiskLevel: 3,
    maxRepaymentPerExecution: "12000000000000000000",
    maxCollateralPerExecution: "12000000000000000000",
    maxCumulativeRepayment: "12000000000000000000",
    maxCumulativeCollateral: "12500000000000000000",
    maxCollateralPercentageBps: "2500",
    maxPositionDebt: "46000000000000000000",
    maxSlippageBps: "100",
    maxOracleDeviationBps: "125",
    maxFlashLoanPremiumBps: "5",
    maxPreHealthFactor: "1050000000000000000",
    minPostHealthFactor: "1065000000000000000",
    minCooldownSeconds: "0",
    maxExecutions: "1",
    maxRiskAgeSeconds: "86400",
    maxClockSkewSeconds: "60",
  } as const;
  const configurationHash = phase11DeploymentConfigurationHash({
    chainId: 1952,
    environmentId: "xlayer-testnet-1952",
    deployer: TESTNET_ADDRESSES.guardian,
    keeper: TESTNET_ADDRESSES.keeper,
    borrower: TESTNET_ADDRESSES.borrower,
    riskAttestor: TESTNET_ADDRESSES.riskAttestor,
    compatibilityLabel: COMPATIBILITY_LABEL,
    executionBounds,
    startingNonce: TESTNET_STARTING_NONCE,
  });
  const deploymentId = phase11DeploymentId({
    chainId: 1952,
    environmentId: "xlayer-testnet-1952",
    deployer: TESTNET_ADDRESSES.guardian,
    startingNonce: TESTNET_STARTING_NONCE,
    configurationHash,
  });
  const deploymentTransactions: Phase11TransactionProvenance[] = PHASE11_DEPLOYMENT_SEQUENCE.map((step) => {
    const nonce = BigInt(TESTNET_STARTING_NONCE) + BigInt(step.sequence - 1);
    const blockNumber = (123_430n + BigInt(step.sequence)).toString();
    const blockHash = testnetBlockHash(step.sequence);
    const contractAddress = step.kind === "DEPLOYMENT"
      ? getContractAddress({ from: TESTNET_ADDRESSES.guardian, nonce })
      : null;
    return {
      deploymentId,
      chainId: 1952,
      environmentId: "xlayer-testnet-1952",
      sequence: step.sequence,
      actionId: step.actionId,
      from: TESTNET_ADDRESSES.guardian,
      nonce: nonce.toString(),
      to: phase11ExpectedTransactionTarget({
        deployer: TESTNET_ADDRESSES.guardian,
        startingNonce: TESTNET_STARTING_NONCE,
        actionId: step.actionId,
      }),
      value: "0",
      calldataHash: keccak256(testnetTransactionInput(step.sequence)),
      transactionHash: testnetTransactionHash(step.sequence),
      initialInclusion: {
        stage: "INITIAL_UNSAFE",
        receiptStatus: "SUCCESS",
        blockNumber,
        blockHash,
        transactionIndex: "0",
        contractAddress,
        observedAt: "2026-08-17T10:00:00.000Z",
      },
      safeInclusion: {
        stage: "SAFE_CANONICAL",
        receiptStatus: "SUCCESS",
        blockNumber,
        blockHash,
        transactionIndex: "0",
        contractAddress,
        finalityHeadBlockNumber: TESTNET_BLOCK_NUMBER,
        finalityHeadBlockHash: TESTNET_BLOCK_HASH,
        observedAt: "2026-08-17T10:01:00.000Z",
      },
      finalizedInclusion: {
        stage: "FINALIZED_CANONICAL",
        receiptStatus: "SUCCESS",
        blockNumber,
        blockHash,
        transactionIndex: "0",
        contractAddress,
        finalityHeadBlockNumber: TESTNET_BLOCK_NUMBER,
        finalityHeadBlockHash: TESTNET_BLOCK_HASH,
        observedAt: "2026-08-17T10:02:00.000Z",
      },
      canonicalInclusionClass: "INITIAL_UNSAFE_CANONICAL",
      contractAddress,
    };
  });
  const runtimeCodeHashes = {
    egressContract: TESTNET_CODE_HASH,
    addressesProvider: TESTNET_CODE_HASH,
    aavePool: TESTNET_CODE_HASH,
    aaveOracle: TESTNET_CODE_HASH,
    xbEthOracleSource: TESTNET_CODE_HASH,
    xethOracleSource: TESTNET_CODE_HASH,
    xbEth: TESTNET_CODE_HASH,
    xeth: TESTNET_CODE_HASH,
    aXbEth: TESTNET_CODE_HASH,
    variableDebtXeth: TESTNET_CODE_HASH,
    uniswapFactory: TESTNET_CODE_HASH,
    swapRouter: TESTNET_CODE_HASH,
    quoterV2: TESTNET_CODE_HASH,
    swapPool: TESTNET_CODE_HASH,
  };
  return createTestnetDeploymentManifest({
    schemaVersion: PHASE11_DEPLOYMENT_MANIFEST_SCHEMA_VERSION,
    manifestType: "EGRESS_XLAYER_TESTNET_COMPATIBILITY",
    environmentId: "xlayer-testnet-1952",
    compatibilityLabel: COMPATIBILITY_LABEL,
    chainId: 1952,
    deploymentId,
    finalityPolicy: {
      version: PHASE11_DEPLOYMENT_FINALITY_POLICY_VERSION,
      publication: PHASE11_DEPLOYMENT_FINALITY_POLICY,
      safeTag: "safe",
      finalizedTag: "finalized",
    },
    startingNonce: TESTNET_STARTING_NONCE,
    configurationHash,
    deploymentBlockNumber: TESTNET_BLOCK_NUMBER,
    deploymentBlockHash: TESTNET_BLOCK_HASH,
    deploymentTransactions,
    egressContract: TESTNET_ADDRESSES.egressContract,
    guardian: TESTNET_ADDRESSES.guardian,
    keeper: TESTNET_ADDRESSES.keeper,
    protocol,
    oracleSources: {
      xbEth: TESTNET_ADDRESSES.aaveOracle,
      xeth: TESTNET_ADDRESSES.aaveOracle,
    },
    protocolConfigHash: executionProtocolConfigHash(protocol),
    executionBounds,
    scenario: {
      borrower: TESTNET_ADDRESSES.borrower,
      riskAttestor: TESTNET_ADDRESSES.riskAttestor,
      initialCollateralWei: "50000000000000000000",
      initialDebtWei: "44000000000000000000",
      policyNonce: "11001",
      policyExpiresAt: "2000000000",
      policyId: TESTNET_POLICY_ID,
      policyRegistrationTransactionHash: TESTNET_POLICY_REGISTRATION_HASH,
    },
    runtimeCodeHashes,
    tokens: {
      xbEth: { address: protocol.xbEth, name: "Egress Testnet xBETH", symbol: "txBETH", decimals: 18 },
      xeth: { address: protocol.xeth, name: "Egress Testnet xETH", symbol: "txETH", decimals: 18 },
      aXbEth: { address: protocol.aXbEth, name: "Egress Testnet Aave xBETH", symbol: "atxBETH", decimals: 18 },
      variableDebtXeth: {
        address: protocol.variableDebtXeth,
        name: "Egress Testnet Variable Debt xETH",
        symbol: "variableDebtTxETH",
        decimals: 18,
      },
    },
  });
}

export function createLegacyTwoTransactionManifestFixture(): unknown {
  const manifest = createTestnetManifestFixture();
  const {
    manifestHash: _manifestHash,
    deploymentId: _deploymentId,
    startingNonce: _startingNonce,
    configurationHash: _configurationHash,
    deploymentTransactions,
    ...legacyFields
  } = manifest;
  return {
    ...legacyFields,
    schemaVersion: 1,
    deploymentTransactionHashes: [
      deploymentTransactions[0]!.transactionHash,
      deploymentTransactions[deploymentTransactions.length - 1]!.transactionHash,
    ],
    manifestHash: TESTNET_CODE_HASH,
  };
}
