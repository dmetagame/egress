import { createHash, randomUUID } from "node:crypto";
import {
  link,
  lstat,
  open,
  readFile,
  realpath,
  unlink,
} from "node:fs/promises";
import { dirname, resolve } from "node:path";
import {
  decodeFunctionData,
  getAddress,
  keccak256,
  parseAbi,
  type Address,
  type Hex,
  type PublicClient,
} from "viem";
import {
  addressSchema,
} from "../domain/schemas.js";
import {
  egressAutonomousAbi,
} from "../autonomy/contract.js";
import {
  onchainProtectionPolicySchema,
  type OnchainProtectionPolicy,
} from "../autonomy/schemas.js";
import { protectionPolicyId } from "../authorization/protection-policy.js";
import { executionProtocolConfigHash } from "./protocol.js";
import {
  PHASE11_DEPLOYMENT_FINALITY_POLICY,
  PHASE11_DEPLOYMENT_FINALITY_POLICY_VERSION,
  PHASE11_EXPECTED_TRANSACTION_COUNT,
  PHASE11_LEGACY_DEPLOYMENT_JOURNAL_SCHEMA_VERSION,
  Phase11DeploymentReconciliationError,
  phase11DeploymentConfigurationHash,
  phase11DeploymentId,
  validateLegacyPhase11DeploymentJournal,
  type LegacyPhase11DeploymentJournal,
  type Phase11DeploymentActionId,
  type Phase11FinalizedInclusion,
  type Phase11SafeInclusion,
} from "./testnet-deployment-journal.js";
import {
  PHASE11_EXISTING_DEPLOYMENT_JOURNAL_SHA256,
  verifyPhase11ReconciliationArtifact,
  type Phase11ReconciliationArtifact,
} from "./testnet-deployment-reconciliation.js";
import {
  createTestnetDeploymentManifest,
  testnetExecutionBoundsSchema,
  verifyTestnetDeploymentManifest,
  verifyTestnetDeploymentRuntime,
  XLAYER_TESTNET_CHAIN_ID,
  XLAYER_TESTNET_ENVIRONMENT_ID,
  type TestnetDeploymentManifest,
  type TestnetExecutionBounds,
} from "./testnet-deployment.js";

export const PHASE11_MANIFEST_PUBLISHER_SOFTWARE_VERSION = "phase11-manifest-publisher-v1" as const;
export const PHASE11_MANIFEST_COMPATIBILITY_LABEL = "Egress Phase 11 compatibility deployment v1" as const;
export const PHASE11_EXISTING_RECONCILIATION_ARTIFACT_SHA256 =
  "sha256:113036b609e8847b546a9d5936c844cfa687645730f3d19cd0d1f3937d4a8bdb" as const;
export const PHASE11_EXISTING_RECONCILIATION_ARTIFACT_INTERNAL_HASH =
  "0xff49ef45da2a4010cf986ba6d93f4df918a2c1d81a65f2559dfb85f4b51ff93b" as const;
export const PHASE11_POLICY_NONCE = "11001" as const;
export const PHASE11_INITIAL_COLLATERAL_WEI = "50000000000000000000" as const;
export const PHASE11_INITIAL_DEBT_WEI = "44000000000000000000" as const;

export const PHASE11_DEFAULT_EXECUTION_BOUNDS: TestnetExecutionBounds = {
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
};

const egressIdentityAbi = parseAbi([
  "function POOL_FEE() view returns (uint24)",
  "function policyStates(bytes32 policyId) view returns (address user,bool active,uint256 executionCount,uint256 lastExecutionAt,uint256 cumulativeRepayment,uint256 cumulativeCollateral,uint256 enrollmentCollateral,uint256 enrollmentDebt)",
]);

const protocolReadAbi = parseAbi([
  "function getSourceOfAsset(address asset) view returns (address)",
]);

const tokenIdentityAbi = parseAbi([
  "function name() view returns (string)",
  "function symbol() view returns (string)",
  "function decimals() view returns (uint8)",
]);

const policyFields = [
  "user",
  "keeper",
  "riskAttestor",
  "protocolConfigHash",
  "minimumRiskLevel",
  "maxRepaymentPerExecution",
  "maxCollateralPerExecution",
  "maxCumulativeRepayment",
  "maxCumulativeCollateral",
  "maxCollateralPercentageBps",
  "maxPositionDebt",
  "maxSlippageBps",
  "maxOracleDeviationBps",
  "maxFlashLoanPremiumBps",
  "maxPreHealthFactor",
  "minPostHealthFactor",
  "cooldownSeconds",
  "maxExecutions",
  "maxRiskAgeSeconds",
  "maxClockSkewSeconds",
  "expiresAt",
  "nonce",
  "revocationNonce",
] as const;

export interface Phase11ManifestPublicationConfiguration {
  compatibilityLabel: string;
  executionBounds: TestnetExecutionBounds;
}

export interface Phase11ManifestChainEvidence {
  protocol: TestnetDeploymentManifest["protocol"];
  protocolConfigHash: Hex;
  oracleSources: { xbEth: Address; xeth: Address };
  runtimeCodeHashes: Record<string, Hex>;
  tokens: {
    xbEth: { address: Address; name: string; symbol: string; decimals: number };
    xeth: { address: Address; name: string; symbol: string; decimals: number };
    aXbEth: { address: Address; name: string; symbol: string; decimals: number };
    variableDebtXeth: { address: Address; name: string; symbol: string; decimals: number };
  };
  policy: OnchainProtectionPolicy;
  initialCollateralWei: string;
  initialDebtWei: string;
}

export interface Phase11ManifestPublicationResult {
  manifest: TestnetDeploymentManifest;
  journalPath: string;
  artifactPath: string;
  journalSha256: `sha256:${string}`;
  artifactSha256: `sha256:${string}`;
  manifestSha256: `sha256:${string}`;
  artifactInternalHash: Hex;
  runtimeVerification: "PASS";
  published: boolean;
}

export class Phase11ManifestPublicationError extends Phase11DeploymentReconciliationError {
  constructor(message: string) {
    super(message);
    this.name = "Phase11ManifestPublicationError";
  }
}

export function sha256Bytes(value: Uint8Array): `sha256:${string}` {
  return `sha256:${createHash("sha256").update(value).digest("hex")}`;
}

export function buildPhase11ManifestFromEvidence(input: {
  journal: LegacyPhase11DeploymentJournal;
  artifact: Phase11ReconciliationArtifact;
  journalPath: string;
  artifactPath: string;
  journalSha256: `sha256:${string}`;
  artifactSha256: `sha256:${string}`;
  configuration: Phase11ManifestPublicationConfiguration;
  chainEvidence: Phase11ManifestChainEvidence;
  createdAt: string;
  nodeVersion?: string;
}): TestnetDeploymentManifest {
  assertSourceIdentity(input);
  const deployer = getAddress(input.journal.deployer);
  const keeper = getAddress(input.artifact.runtimeVerification.keeper);
  const borrower = getAddress(input.artifact.runtimeVerification.borrower);
  const riskAttestor = getAddress(input.artifact.runtimeVerification.riskAttestor);
  const configurationHash = phase11DeploymentConfigurationHash({
    chainId: XLAYER_TESTNET_CHAIN_ID,
    environmentId: XLAYER_TESTNET_ENVIRONMENT_ID,
    deployer,
    keeper,
    borrower,
    riskAttestor,
    compatibilityLabel: input.configuration.compatibilityLabel,
    executionBounds: input.configuration.executionBounds,
    startingNonce: input.journal.startingNonce,
  });
  if (configurationHash.toLowerCase() !== input.journal.configurationHash.toLowerCase() ||
      configurationHash.toLowerCase() !== input.artifact.configurationHash.toLowerCase()) {
    throw new Phase11ManifestPublicationError("Publication configuration does not match the immutable deployment identity.");
  }
  const deploymentId = phase11DeploymentId({
    chainId: XLAYER_TESTNET_CHAIN_ID,
    environmentId: XLAYER_TESTNET_ENVIRONMENT_ID,
    deployer,
    startingNonce: input.journal.startingNonce,
    configurationHash,
  });
  if (deploymentId.toLowerCase() !== input.journal.deploymentId.toLowerCase() ||
      deploymentId.toLowerCase() !== input.artifact.deploymentId.toLowerCase()) {
    throw new Phase11ManifestPublicationError("Publication deployment ID does not match the immutable deployment identity.");
  }

  assertPolicyEvidence({
    artifact: input.artifact,
    configurationHash,
    deploymentId,
    deployer,
    keeper,
    borrower,
    riskAttestor,
  });

  const deploymentTransactions = input.artifact.transactions.map((transaction) => {
    const safeInclusion: Phase11SafeInclusion = {
      stage: "SAFE_CANONICAL",
      receiptStatus: "SUCCESS",
      blockNumber: transaction.SAFE_CANONICAL_BLOCK_NUMBER,
      blockHash: transaction.SAFE_CANONICAL_BLOCK_HASH as Hex,
      transactionIndex: transaction.safeInclusion.transactionIndex,
      contractAddress: transaction.safeInclusion.contractAddress
        ? getAddress(transaction.safeInclusion.contractAddress) as Address
        : null,
      finalityHeadBlockNumber: transaction.safeInclusion.finalityHeadBlockNumber,
      finalityHeadBlockHash: transaction.safeInclusion.finalityHeadBlockHash as Hex,
      observedAt: transaction.safeInclusion.observedAt,
    };
    const finalizedInclusion: Phase11FinalizedInclusion = {
      stage: "FINALIZED_CANONICAL",
      receiptStatus: "SUCCESS",
      blockNumber: transaction.FINALIZED_CANONICAL_BLOCK_NUMBER,
      blockHash: transaction.FINALIZED_CANONICAL_BLOCK_HASH as Hex,
      transactionIndex: transaction.finalizedInclusion.transactionIndex,
      contractAddress: transaction.finalizedInclusion.contractAddress
        ? getAddress(transaction.finalizedInclusion.contractAddress) as Address
        : null,
      finalityHeadBlockNumber: transaction.finalizedInclusion.finalityHeadBlockNumber,
      finalityHeadBlockHash: transaction.finalizedInclusion.finalityHeadBlockHash as Hex,
      observedAt: transaction.finalizedInclusion.observedAt,
    };
    return {
      deploymentId,
      chainId: XLAYER_TESTNET_CHAIN_ID,
      environmentId: XLAYER_TESTNET_ENVIRONMENT_ID,
      sequence: transaction.sequence,
      actionId: transaction.actionId as Phase11DeploymentActionId,
      from: getAddress(transaction.from) as Address,
      nonce: transaction.nonce,
      to: transaction.to ? getAddress(transaction.to) as Address : null,
      value: transaction.value,
      calldataHash: transaction.calldataHash as Hex,
      transactionHash: transaction.transactionHash as Hex,
      initialInclusion: {
        stage: "INITIAL_UNSAFE" as const,
        receiptStatus: transaction.initialInclusion.receiptStatus,
        blockNumber: transaction.INITIAL_UNSAFE_BLOCK_NUMBER,
        blockHash: transaction.INITIAL_UNSAFE_BLOCK_HASH as Hex,
        transactionIndex: transaction.INITIAL_UNSAFE_TRANSACTION_INDEX,
        contractAddress: transaction.initialInclusion.contractAddress
          ? getAddress(transaction.initialInclusion.contractAddress) as Address
          : null,
        observedAt: null,
      },
      safeInclusion,
      finalizedInclusion,
      canonicalInclusionClass: transaction.reIncluded
        ? "REINCLUDED_AFTER_UNSAFE_REORG" as const
        : "INITIAL_UNSAFE_CANONICAL" as const,
      contractAddress: transaction.finalizedInclusion.contractAddress
        ? getAddress(transaction.finalizedInclusion.contractAddress) as Address
        : null,
    };
  });

  const runtimeVerification = {
    status: "PASS" as const,
    verifiedTransactionCount: PHASE11_EXPECTED_TRANSACTION_COUNT,
    contractAddresses: input.artifact.runtimeVerification.contractAddresses,
    protocolConfigHash: input.artifact.runtimeVerification.protocolConfigHash as Hex,
    policyId: input.artifact.runtimeVerification.policyId as Hex,
    borrower,
    keeper,
    riskAttestor,
    policyActive: true as const,
    protocolRelationshipsVerified: true as const,
    tokenMetadataVerified: true as const,
    oracleStateVerified: true as const,
    verificationSource: "RECONCILIATION_ARTIFACT" as const,
  };

  return createTestnetDeploymentManifest({
    schemaVersion: 4,
    manifestType: "EGRESS_XLAYER_TESTNET_COMPATIBILITY",
    environmentId: XLAYER_TESTNET_ENVIRONMENT_ID,
    compatibilityLabel: input.configuration.compatibilityLabel,
    chainId: XLAYER_TESTNET_CHAIN_ID,
    deploymentId,
    finalityPolicy: {
      version: PHASE11_DEPLOYMENT_FINALITY_POLICY_VERSION,
      publication: PHASE11_DEPLOYMENT_FINALITY_POLICY,
      safeTag: "safe",
      finalizedTag: "finalized",
    },
    startingNonce: input.journal.startingNonce,
    configurationHash,
    expectedTransactionCount: PHASE11_EXPECTED_TRANSACTION_COUNT,
    publicationSource: "RECONCILIATION_ARTIFACT",
    originalJournalPath: resolve(input.journalPath),
    originalJournalSchemaVersion: PHASE11_LEGACY_DEPLOYMENT_JOURNAL_SCHEMA_VERSION,
    originalJournalSha256: input.journalSha256,
    reconciliationArtifactPath: resolve(input.artifactPath),
    reconciliationArtifactSchemaVersion: input.artifact.schemaVersion,
    reconciliationArtifactSha256: input.artifactSha256,
    reconciliationArtifactInternalHash: input.artifact.artifactHash as Hex,
    manifestCreationTimestamp: input.createdAt,
    software: {
      publisher: PHASE11_MANIFEST_PUBLISHER_SOFTWARE_VERSION,
      node: input.nodeVersion ?? process.version,
    },
    deploymentBlockNumber: input.artifact.deploymentAnchor.finalizedBlockNumber,
    deploymentBlockHash: input.artifact.deploymentAnchor.finalizedBlockHash as Hex,
    deploymentTransactions,
    egressContract: getAddress(input.artifact.runtimeVerification.contractAddresses.egressContract!),
    guardian: deployer,
    keeper,
    protocol: input.chainEvidence.protocol,
    oracleSources: input.chainEvidence.oracleSources,
    protocolConfigHash: input.chainEvidence.protocolConfigHash,
    executionBounds: input.configuration.executionBounds,
    runtimeVerification,
    scenario: {
      borrower,
      riskAttestor,
      initialCollateralWei: input.chainEvidence.initialCollateralWei,
      initialDebtWei: input.chainEvidence.initialDebtWei,
      policyNonce: input.chainEvidence.policy.nonce,
      policyExpiresAt: input.chainEvidence.policy.expiresAt,
      policyId: input.artifact.runtimeVerification.policyId as Hex,
      policyRegistrationTransactionHash: input.artifact.deploymentAnchor.transactionHash as Hex,
    },
    runtimeCodeHashes: input.chainEvidence.runtimeCodeHashes as never,
    tokens: input.chainEvidence.tokens,
  });
}

export function verifyPhase11ManifestPublicationSources(input: {
  manifest: TestnetDeploymentManifest;
  journal: LegacyPhase11DeploymentJournal;
  artifact: Phase11ReconciliationArtifact;
  journalPath: string;
  artifactPath: string;
  journalSha256: `sha256:${string}`;
  artifactSha256: `sha256:${string}`;
}): void {
  verifyTestnetDeploymentManifest(input.manifest, input.manifest.manifestHash);
  if (input.manifest.originalJournalSha256 !== input.journalSha256 ||
      input.manifest.reconciliationArtifactSha256 !== input.artifactSha256 ||
      input.manifest.reconciliationArtifactInternalHash?.toLowerCase() !== input.artifact.artifactHash.toLowerCase()) {
    throw new Phase11ManifestPublicationError("Manifest source digests do not match the immutable evidence files.");
  }
  if (resolve(input.manifest.originalJournalPath ?? "") !== resolve(input.journalPath) ||
      resolve(input.manifest.reconciliationArtifactPath ?? "") !== resolve(input.artifactPath)) {
    throw new Phase11ManifestPublicationError("Manifest source paths do not match the immutable evidence files.");
  }
  for (const [index, transaction] of input.artifact.transactions.entries()) {
    const record = input.manifest.deploymentTransactions[index];
    if (!record ||
        record.sequence !== transaction.sequence ||
        record.actionId !== transaction.actionId ||
        record.transactionHash.toLowerCase() !== transaction.transactionHash.toLowerCase() ||
        record.initialInclusion.blockNumber !== transaction.INITIAL_UNSAFE_BLOCK_NUMBER ||
        record.initialInclusion.blockHash.toLowerCase() !== transaction.INITIAL_UNSAFE_BLOCK_HASH.toLowerCase() ||
        record.safeInclusion.blockNumber !== transaction.SAFE_CANONICAL_BLOCK_NUMBER ||
        record.safeInclusion.blockHash.toLowerCase() !== transaction.SAFE_CANONICAL_BLOCK_HASH.toLowerCase() ||
        record.finalizedInclusion.blockNumber !== transaction.FINALIZED_CANONICAL_BLOCK_NUMBER ||
        record.finalizedInclusion.blockHash.toLowerCase() !== transaction.FINALIZED_CANONICAL_BLOCK_HASH.toLowerCase() ||
        record.canonicalInclusionClass !== (transaction.reIncluded ? "REINCLUDED_AFTER_UNSAFE_REORG" : "INITIAL_UNSAFE_CANONICAL")) {
      throw new Phase11ManifestPublicationError(`Manifest evidence projection is invalid at step ${index + 1}.`);
    }
  }
}

export async function publishPhase11Manifest(input: {
  manifestPath: string;
  journalPath: string;
  artifactPath: string;
  client: PublicClient;
  configuration?: Partial<Phase11ManifestPublicationConfiguration>;
  expectedJournalSha256?: `sha256:${string}`;
  expectedArtifactSha256?: `sha256:${string}`;
  expectedArtifactInternalHash?: Hex;
  now?: () => Date;
}): Promise<Phase11ManifestPublicationResult> {
  const journalPath = resolve(input.journalPath);
  const artifactPath = resolve(input.artifactPath);
  const manifestPath = resolve(input.manifestPath);

  await assertRegularFilePath(journalPath);
  await assertRegularFilePath(artifactPath);
  await assertDirectoryPath(dirname(manifestPath));
  await assertPublicationSourceFilesDistinct(journalPath, artifactPath);

  const journalBytesBefore = await readFile(journalPath);
  const journalSha256 = sha256Bytes(journalBytesBefore);
  const expectedJournalSha256 = input.expectedJournalSha256 ?? PHASE11_EXISTING_DEPLOYMENT_JOURNAL_SHA256;
  if (journalSha256 !== expectedJournalSha256) {
    throw new Phase11ManifestPublicationError(
      `Immutable Phase 11 journal SHA-256 mismatch: expected ${expectedJournalSha256}, received ${journalSha256}.`,
    );
  }
  const journal = parseLegacyJournal(journalBytesBefore, journalPath);
  const artifactBytesBefore = await readFile(artifactPath);
  const artifactSha256 = sha256Bytes(artifactBytesBefore);
  const expectedArtifactSha256 = input.expectedArtifactSha256 ?? PHASE11_EXISTING_RECONCILIATION_ARTIFACT_SHA256;
  if (artifactSha256 !== expectedArtifactSha256) {
    throw new Phase11ManifestPublicationError(
      `Reconciliation artifact SHA-256 mismatch: expected ${expectedArtifactSha256}, received ${artifactSha256}.`,
    );
  }
  const artifact = parseArtifact(artifactBytesBefore, artifactPath);
  const expectedArtifactInternalHash = input.expectedArtifactInternalHash ?? PHASE11_EXISTING_RECONCILIATION_ARTIFACT_INTERNAL_HASH;
  if (artifact.artifactHash.toLowerCase() !== expectedArtifactInternalHash.toLowerCase()) {
    throw new Phase11ManifestPublicationError(
      `Reconciliation artifact internal hash mismatch: expected ${expectedArtifactInternalHash}, received ${artifact.artifactHash}.`,
    );
  }
  if (artifact.originalJournalSha256 !== journalSha256 ||
      resolve(artifact.originalJournalPath) !== journalPath) {
    throw new Phase11ManifestPublicationError("Reconciliation artifact does not bind to the immutable journal.");
  }
  if (await pathExists(manifestPath)) {
    throw new Phase11ManifestPublicationError(`Refusing to overwrite existing Phase 11 manifest ${manifestPath}.`);
  }
  assertPublicationPaths({ manifestPath, journalPath, artifactPath });
  const observedChainId = await input.client.getChainId();
  if (observedChainId !== XLAYER_TESTNET_CHAIN_ID) {
    throw new Phase11ManifestPublicationError(`Manifest publication requires X Layer testnet chain ${XLAYER_TESTNET_CHAIN_ID}; observed ${observedChainId}.`);
  }

  const configuration = {
    compatibilityLabel: input.configuration?.compatibilityLabel?.trim() || PHASE11_MANIFEST_COMPATIBILITY_LABEL,
    executionBounds: testnetExecutionBoundsSchema.parse(
      input.configuration?.executionBounds ?? PHASE11_DEFAULT_EXECUTION_BOUNDS,
    ),
  };
  const chainEvidence = await collectChainEvidence(input.client, artifact, configuration.executionBounds);
  const manifest = buildPhase11ManifestFromEvidence({
    journal,
    artifact,
    journalPath,
    artifactPath,
    journalSha256,
    artifactSha256,
    configuration,
    chainEvidence,
    createdAt: (input.now ?? (() => new Date()))().toISOString(),
  });
  verifyPhase11ManifestPublicationSources({
    manifest,
    journal,
    artifact,
    journalPath,
    artifactPath,
    journalSha256,
    artifactSha256,
  });
  await verifyTestnetDeploymentRuntime(input.client, {
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

  const serialized = `${JSON.stringify(manifest, null, 2)}\n`;
  const manifestSha256 = sha256Bytes(Buffer.from(serialized, "utf8"));
  const temporaryPath = await writeTemporaryManifest(manifestPath, serialized);
  try {
    const temporaryManifest = verifyTestnetDeploymentManifest(
      JSON.parse(await readFile(temporaryPath, "utf8")),
      manifest.manifestHash,
    );
    verifyPhase11ManifestPublicationSources({
      manifest: temporaryManifest,
      journal,
      artifact,
      journalPath,
      artifactPath,
      journalSha256,
      artifactSha256,
    });
    await assertPathAbsent(manifestPath);
    await assertImmutableSourcesUnchanged(journalPath, journalSha256, artifactPath, artifactSha256);
    await link(temporaryPath, manifestPath);
  } catch (error) {
    await unlink(temporaryPath).catch(() => undefined);
    if (errorCode(error) === "EEXIST") {
      throw new Phase11ManifestPublicationError(`Refusing to overwrite existing Phase 11 manifest ${manifestPath}.`);
    }
    throw error;
  }
  await unlink(temporaryPath);
  await syncParentDirectory(manifestPath);

  const publishedManifest = verifyTestnetDeploymentManifest(
    JSON.parse(await readFile(manifestPath, "utf8")),
    manifest.manifestHash,
  );
  verifyPhase11ManifestPublicationSources({
    manifest: publishedManifest,
    journal,
    artifact,
    journalPath,
    artifactPath,
    journalSha256,
    artifactSha256,
  });
  await verifyTestnetDeploymentRuntime(input.client, {
    manifest: publishedManifest,
    config: {
      environmentId: publishedManifest.environmentId,
      manifestHash: publishedManifest.manifestHash,
      chainId: publishedManifest.chainId,
      anchorBlockNumber: BigInt(publishedManifest.deploymentBlockNumber),
      anchorBlockHash: publishedManifest.deploymentBlockHash,
      egressContract: publishedManifest.egressContract,
      keeperAddress: publishedManifest.keeper,
      protocol: publishedManifest.protocol,
    },
  });
  const journalSha256After = sha256Bytes(await readFile(journalPath));
  const artifactSha256After = sha256Bytes(await readFile(artifactPath));
  if (journalSha256After !== journalSha256 || artifactSha256After !== artifactSha256) {
    throw new Phase11ManifestPublicationError("Immutable publication source evidence changed during manifest publication.");
  }
  const publishedBytes = await readFile(manifestPath);
  const publishedManifestSha256 = sha256Bytes(publishedBytes);
  if (publishedManifestSha256 !== manifestSha256) {
    throw new Phase11ManifestPublicationError("Serialized manifest changed between temporary verification and publication.");
  }
  return {
    manifest: publishedManifest,
    journalPath,
    artifactPath,
    journalSha256,
    artifactSha256,
    manifestSha256: publishedManifestSha256,
    artifactInternalHash: artifact.artifactHash as Hex,
    runtimeVerification: "PASS",
    published: true,
  };
}

async function collectChainEvidence(
  client: PublicClient,
  artifact: Phase11ReconciliationArtifact,
  bounds: TestnetExecutionBounds,
): Promise<Phase11ManifestChainEvidence> {
  const addresses = artifact.runtimeVerification.contractAddresses;
  const address = (role: string): Address => {
    const value = addresses[role];
    if (!value || !addressSchema.safeParse(value).success) {
      throw new Phase11ManifestPublicationError(`Reconciliation runtime evidence has no valid ${role} address.`);
    }
    return getAddress(value) as Address;
  };
  const protocolBase = {
    addressesProvider: address("addressesProvider"),
    aavePool: address("aavePool"),
    aaveOracle: address("aaveOracle"),
    xbEth: address("xbEth"),
    xeth: address("xeth"),
    aXbEth: address("aXbEth"),
    variableDebtXeth: address("variableDebtXeth"),
    uniswapFactory: address("uniswapFactory"),
    swapRouter: address("swapRouter"),
    quoterV2: address("quoterV2"),
    swapPool: address("swapPool"),
  };
  const poolFee = Number(await client.readContract({
    address: address("egressContract"),
    abi: egressIdentityAbi,
    functionName: "POOL_FEE",
  }));
  const protocol: TestnetDeploymentManifest["protocol"] = { ...protocolBase, poolFee };
  const protocolConfigHash = executionProtocolConfigHash(protocol);
  if (protocolConfigHash.toLowerCase() !== artifact.runtimeVerification.protocolConfigHash.toLowerCase()) {
    throw new Phase11ManifestPublicationError("Read-only protocol configuration hash does not match reconciliation evidence.");
  }
  const [xbEthSource, xethSource] = await Promise.all([
    client.readContract({ address: protocol.aaveOracle, abi: protocolReadAbi, functionName: "getSourceOfAsset", args: [protocol.xbEth] }),
    client.readContract({ address: protocol.aaveOracle, abi: protocolReadAbi, functionName: "getSourceOfAsset", args: [protocol.xeth] }),
  ]);
  const oracleSources = {
    xbEth: getAddress(xbEthSource) as Address,
    xeth: getAddress(xethSource) as Address,
  };
  const runtimeCodeHashes: Record<string, Hex> = {};
  for (const [role, value] of Object.entries({
    egressContract: address("egressContract"),
    ...protocolBase,
    xbEthOracleSource: oracleSources.xbEth,
    xethOracleSource: oracleSources.xeth,
  })) {
    const bytecode = await client.getBytecode({ address: value });
    if (!bytecode || bytecode === "0x") throw new Phase11ManifestPublicationError(`No runtime bytecode at ${role}.`);
    runtimeCodeHashes[role] = keccak256(bytecode);
  }
  const tokenEntries = [
    ["xbEth", protocol.xbEth, "Egress Testnet xBETH", "txBETH"],
    ["xeth", protocol.xeth, "Egress Testnet xETH", "txETH"],
    ["aXbEth", protocol.aXbEth, "Egress Testnet Aave xBETH", "atxBETH"],
    ["variableDebtXeth", protocol.variableDebtXeth, "Egress Testnet Variable Debt xETH", "variableDebtTxETH"],
  ] as const;
  const tokens = {} as Phase11ManifestChainEvidence["tokens"];
  for (const [role, tokenAddress, expectedName, expectedSymbol] of tokenEntries) {
    const [name, symbol, decimals] = await Promise.all([
      client.readContract({ address: tokenAddress, abi: tokenIdentityAbi, functionName: "name" }),
      client.readContract({ address: tokenAddress, abi: tokenIdentityAbi, functionName: "symbol" }),
      client.readContract({ address: tokenAddress, abi: tokenIdentityAbi, functionName: "decimals" }),
    ]);
    if (name !== expectedName || symbol !== expectedSymbol || Number(decimals) !== 18) {
      throw new Phase11ManifestPublicationError(`Token metadata does not match expected deployment metadata for ${role}.`);
    }
    tokens[role] = {
      address: tokenAddress as Address,
      name: name as string,
      symbol: symbol as string,
      decimals: Number(decimals),
    };
  }
  const anchor = artifact.transactions[PHASE11_EXPECTED_TRANSACTION_COUNT - 1];
  if (!anchor) throw new Phase11ManifestPublicationError("Reconciliation artifact has no deployment anchor transaction.");
  const anchorTransaction = await client.getTransaction({ hash: anchor.transactionHash as Hex });
  const decoded = decodeFunctionData({ abi: egressAutonomousAbi, data: anchorTransaction.input });
  if (decoded.functionName !== "registerProtectionPolicy") {
    throw new Phase11ManifestPublicationError("Deployment anchor calldata is not policy registration.");
  }
  const policy = normalizePolicy((decoded.args as readonly unknown[])[0]);
  const expectedPolicyId = protectionPolicyId({
    chainId: XLAYER_TESTNET_CHAIN_ID,
    egressContract: address("egressContract"),
    policy,
  });
  if (expectedPolicyId.toLowerCase() !== artifact.runtimeVerification.policyId.toLowerCase() ||
      policy.protocolConfigHash.toLowerCase() !== protocolConfigHash.toLowerCase() ||
      policy.keeper.toLowerCase() !== artifact.runtimeVerification.keeper.toLowerCase() ||
      policy.user.toLowerCase() !== artifact.runtimeVerification.borrower.toLowerCase() ||
      policy.riskAttestor.toLowerCase() !== artifact.runtimeVerification.riskAttestor.toLowerCase() ||
      policy.nonce !== PHASE11_POLICY_NONCE ||
      policy.minimumRiskLevel !== bounds.minimumRiskLevel ||
      policy.maxRepaymentPerExecution !== bounds.maxRepaymentPerExecution ||
      policy.maxCollateralPerExecution !== bounds.maxCollateralPerExecution ||
      policy.maxCumulativeRepayment !== bounds.maxCumulativeRepayment ||
      policy.maxCumulativeCollateral !== bounds.maxCumulativeCollateral ||
      policy.maxCollateralPercentageBps !== bounds.maxCollateralPercentageBps ||
      policy.maxPositionDebt !== bounds.maxPositionDebt ||
      policy.maxSlippageBps !== bounds.maxSlippageBps ||
      policy.maxOracleDeviationBps !== bounds.maxOracleDeviationBps ||
      policy.maxFlashLoanPremiumBps !== bounds.maxFlashLoanPremiumBps ||
      policy.maxPreHealthFactor !== bounds.maxPreHealthFactor ||
      policy.minPostHealthFactor !== bounds.minPostHealthFactor ||
      policy.cooldownSeconds !== bounds.minCooldownSeconds ||
      policy.maxExecutions !== bounds.maxExecutions ||
      policy.maxRiskAgeSeconds !== bounds.maxRiskAgeSeconds ||
      policy.maxClockSkewSeconds !== bounds.maxClockSkewSeconds) {
    throw new Phase11ManifestPublicationError("Registered policy calldata does not match the deployment configuration.");
  }
  const state = await client.readContract({
    address: address("egressContract"),
    abi: egressIdentityAbi,
    functionName: "policyStates",
    args: [expectedPolicyId],
  }) as readonly [Address, boolean, bigint, bigint, bigint, bigint, bigint, bigint];
  if (state[0].toLowerCase() !== policy.user.toLowerCase() ||
      !state[1] ||
      state[6].toString() !== PHASE11_INITIAL_COLLATERAL_WEI ||
      state[7].toString() !== PHASE11_INITIAL_DEBT_WEI) {
    throw new Phase11ManifestPublicationError("Registered policy state does not match the pinned Phase 11 seeded borrower state.");
  }
  return {
    protocol,
    protocolConfigHash,
    oracleSources,
    runtimeCodeHashes,
    tokens,
    policy,
    initialCollateralWei: state[6].toString(),
    initialDebtWei: state[7].toString(),
  };
}

function assertSourceIdentity(input: {
  journal: LegacyPhase11DeploymentJournal;
  artifact: Phase11ReconciliationArtifact;
  journalPath: string;
  artifactPath: string;
}): void {
  if (input.journal.schemaVersion !== PHASE11_LEGACY_DEPLOYMENT_JOURNAL_SCHEMA_VERSION ||
      input.journal.status !== "COMPLETE" ||
      input.artifact.schemaVersion !== 1 ||
      input.artifact.overallStatus !== "PASS" ||
      input.artifact.transactions.length !== PHASE11_EXPECTED_TRANSACTION_COUNT ||
      resolve(input.artifact.originalJournalPath) !== resolve(input.journalPath) ||
      resolve(input.journalPath) === resolve(input.artifactPath)) {
    throw new Phase11ManifestPublicationError("Immutable publication sources are incomplete or incorrectly bound.");
  }
}

function assertPolicyEvidence(input: {
  artifact: Phase11ReconciliationArtifact;
  configurationHash: Hex;
  deploymentId: Hex;
  deployer: Address;
  keeper: Address;
  borrower: Address;
  riskAttestor: Address;
}): void {
  if (input.configurationHash.toLowerCase() !== input.artifact.configurationHash.toLowerCase() ||
      input.deploymentId.toLowerCase() !== input.artifact.deploymentId.toLowerCase() ||
      input.deployer.toLowerCase() !== input.artifact.deployer.toLowerCase() ||
      input.keeper.toLowerCase() !== input.artifact.runtimeVerification.keeper.toLowerCase() ||
      input.borrower.toLowerCase() !== input.artifact.runtimeVerification.borrower.toLowerCase() ||
      input.riskAttestor.toLowerCase() !== input.artifact.runtimeVerification.riskAttestor.toLowerCase()) {
    throw new Phase11ManifestPublicationError("Policy identity does not match reconciliation identity.");
  }
  if (input.artifact.runtimeVerification.status !== "PASS" ||
      input.artifact.runtimeVerification.policyActive !== true ||
      input.artifact.runtimeVerification.protocolRelationshipsVerified !== true ||
      input.artifact.runtimeVerification.tokenMetadataVerified !== true ||
      input.artifact.runtimeVerification.oracleStateVerified !== true) {
    throw new Phase11ManifestPublicationError("Reconciliation runtime verification is not a complete PASS.");
  }
}

function normalizePolicy(value: unknown): OnchainProtectionPolicy {
  if (!value || typeof value !== "object") throw new Phase11ManifestPublicationError("Policy registration calldata has no policy tuple.");
  const record = value as Record<string, unknown>;
  const normalized: Record<string, unknown> = {};
  for (const field of policyFields) {
    const fieldValue = record[field];
    if (fieldValue === undefined) throw new Phase11ManifestPublicationError(`Policy registration calldata is missing ${field}.`);
    normalized[field] = field === "user" || field === "keeper" || field === "riskAttestor" || field === "protocolConfigHash"
      ? field === "protocolConfigHash" ? String(fieldValue) : getAddress(String(fieldValue))
      : field === "minimumRiskLevel" ? Number(fieldValue) : String(fieldValue);
  }
  return onchainProtectionPolicySchema.parse(normalized) as OnchainProtectionPolicy;
}

function parseLegacyJournal(bytes: Uint8Array, path: string): LegacyPhase11DeploymentJournal {
  try {
    return validateLegacyPhase11DeploymentJournal(JSON.parse(Buffer.from(bytes).toString("utf8")));
  } catch (error) {
    throw new Phase11ManifestPublicationError(`Immutable Phase 11 journal at ${path} is invalid: ${errorMessage(error)}.`);
  }
}

function parseArtifact(bytes: Uint8Array, path: string): Phase11ReconciliationArtifact {
  try {
    return verifyPhase11ReconciliationArtifact(JSON.parse(Buffer.from(bytes).toString("utf8")));
  } catch (error) {
    throw new Phase11ManifestPublicationError(`Phase 11 reconciliation artifact at ${path} is invalid: ${errorMessage(error)}.`);
  }
}

async function assertRegularFilePath(path: string): Promise<void> {
  const info = await lstat(path);
  if (!info.isFile() || info.isSymbolicLink() || (await realpath(path)) !== path) {
    throw new Phase11ManifestPublicationError(`Publication source is not a non-aliased regular file: ${path}.`);
  }
}

async function assertDirectoryPath(path: string): Promise<void> {
  const info = await lstat(path);
  if (!info.isDirectory() || info.isSymbolicLink() || (await realpath(path)) !== path) {
    throw new Phase11ManifestPublicationError(`Manifest directory is not a non-aliased directory: ${path}.`);
  }
}

function assertPublicationPaths(input: { manifestPath: string; journalPath: string; artifactPath: string }): void {
  if (input.manifestPath === input.journalPath || input.manifestPath === input.artifactPath || input.journalPath === input.artifactPath) {
    throw new Phase11ManifestPublicationError("Manifest, journal, and reconciliation artifact paths must be distinct.");
  }
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await lstat(path);
    return true;
  } catch (error) {
    if (errorCode(error) === "ENOENT") return false;
    throw error;
  }
}

async function assertPathAbsent(path: string): Promise<void> {
  if (await pathExists(path)) {
    throw new Phase11ManifestPublicationError(`Refusing to overwrite existing Phase 11 manifest ${path}.`);
  }
}

async function assertPublicationSourceFilesDistinct(journalPath: string, artifactPath: string): Promise<void> {
  const [journalInfo, artifactInfo] = await Promise.all([lstat(journalPath), lstat(artifactPath)]);
  if (journalInfo.dev === artifactInfo.dev && journalInfo.ino === artifactInfo.ino) {
    throw new Phase11ManifestPublicationError("Journal and reconciliation artifact must not be the same filesystem object.");
  }
}

async function assertImmutableSourcesUnchanged(
  journalPath: string,
  journalSha256: `sha256:${string}`,
  artifactPath: string,
  artifactSha256: `sha256:${string}`,
): Promise<void> {
  await assertRegularFilePath(journalPath);
  await assertRegularFilePath(artifactPath);
  const currentJournalSha256 = sha256Bytes(await readFile(journalPath));
  const currentArtifactSha256 = sha256Bytes(await readFile(artifactPath));
  if (currentJournalSha256 !== journalSha256 || currentArtifactSha256 !== artifactSha256) {
    throw new Phase11ManifestPublicationError("Immutable publication source evidence changed during manifest publication.");
  }
}

async function writeTemporaryManifest(path: string, serialized: string): Promise<string> {
  const directory = dirname(path);
  await assertDirectoryPath(directory);
  const temporaryPath = `${path}.${process.pid}.${randomUUID()}.tmp`;
  const handle = await open(temporaryPath, "wx", 0o600);
  try {
    await handle.writeFile(serialized, "utf8");
    await handle.sync();
  } finally {
    await handle.close();
  }
  return temporaryPath;
}

async function syncParentDirectory(path: string): Promise<void> {
  const handle = await open(dirname(path), "r");
  try {
    await handle.sync();
  } catch (error) {
    if (![
      "EINVAL", "ENOTSUP", "EBADF", "EISDIR", "EPERM",
    ].includes(errorCode(error) ?? "")) throw error;
  } finally {
    await handle.close();
  }
}

function errorCode(error: unknown): string | null {
  return typeof error === "object" && error !== null && "code" in error
    ? String((error as { code?: unknown }).code ?? "")
    : null;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message.split("\n")[0] ?? error.name : String(error);
}
