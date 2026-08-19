import { readFile } from "node:fs/promises";
import {
  getAddress,
  getContractAddress,
  keccak256,
  parseAbi,
  type Address,
  type Hex,
  type PublicClient,
} from "viem";
import { z } from "zod";
import { objectHash } from "../domain/hash.js";
import { addressSchema, hex32Schema, sha256Schema, uintStringSchema } from "../domain/schemas.js";
import { executionProtocolConfigHash } from "./protocol.js";
import { executionProtocolIdentitySchema, type ExecutionProtocolIdentity } from "./schemas.js";
import {
  PHASE11_DEPLOYMENT_SEQUENCE,
  PHASE11_DEPLOYMENT_FINALITY_POLICY,
  PHASE11_DEPLOYMENT_FINALITY_POLICY_VERSION,
  PHASE11_EXPECTED_TRANSACTION_COUNT,
  phase11DeploymentConfigurationHash,
  phase11DeploymentId,
  type Phase11DeploymentActionId,
  type Phase11FinalizedInclusion,
  type Phase11SafeInclusion,
} from "./testnet-deployment-journal.js";

export const XLAYER_TESTNET_CHAIN_ID = 1_952;
export const XLAYER_TESTNET_ENVIRONMENT_ID = "xlayer-testnet-1952";
export const XLAYER_TESTNET_PUBLIC_RPC = "https://testrpc.xlayer.tech/terigon";
export const PHASE11_MANIFEST_TYPE = "EGRESS_XLAYER_TESTNET_COMPATIBILITY";
export const PHASE11_DEPLOYMENT_MANIFEST_SCHEMA_VERSION = 4 as const;

const deploymentFinalityPolicySchema = z.object({
  version: z.literal(PHASE11_DEPLOYMENT_FINALITY_POLICY_VERSION),
  publication: z.literal(PHASE11_DEPLOYMENT_FINALITY_POLICY),
  safeTag: z.literal("safe"),
  finalizedTag: z.literal("finalized"),
});

const testnetTokenIdentitySchema = z.object({
  address: addressSchema,
  name: z.string().min(1).max(96),
  symbol: z.string().min(1).max(32),
  decimals: z.number().int().min(0).max(255),
});

export const testnetExecutionBoundsSchema = z.object({
  minimumRiskLevel: z.number().int().min(3).max(4),
  maxRepaymentPerExecution: uintStringSchema,
  maxCollateralPerExecution: uintStringSchema,
  maxCumulativeRepayment: uintStringSchema,
  maxCumulativeCollateral: uintStringSchema,
  maxCollateralPercentageBps: uintStringSchema,
  maxPositionDebt: uintStringSchema,
  maxSlippageBps: uintStringSchema,
  maxOracleDeviationBps: uintStringSchema,
  maxFlashLoanPremiumBps: uintStringSchema,
  maxPreHealthFactor: uintStringSchema,
  minPostHealthFactor: uintStringSchema,
  minCooldownSeconds: uintStringSchema,
  maxExecutions: uintStringSchema,
  maxRiskAgeSeconds: uintStringSchema,
  maxClockSkewSeconds: uintStringSchema,
});

const runtimeCodeHashesSchema = z.object({
  egressContract: hex32Schema,
  addressesProvider: hex32Schema,
  aavePool: hex32Schema,
  aaveOracle: hex32Schema,
  xbEthOracleSource: hex32Schema,
  xethOracleSource: hex32Schema,
  xbEth: hex32Schema,
  xeth: hex32Schema,
  aXbEth: hex32Schema,
  variableDebtXeth: hex32Schema,
  uniswapFactory: hex32Schema,
  swapRouter: hex32Schema,
  quoterV2: hex32Schema,
  swapPool: hex32Schema,
});

const manifestInitialInclusionSchema = z.object({
  stage: z.literal("INITIAL_UNSAFE"),
  receiptStatus: z.enum(["SUCCESS", "REVERTED"]),
  blockNumber: uintStringSchema,
  blockHash: hex32Schema,
  transactionIndex: uintStringSchema.nullable(),
  contractAddress: addressSchema.nullable(),
  observedAt: z.string().datetime().nullable(),
});

const manifestCanonicalInclusionSchema = z.object({
  stage: z.enum(["SAFE_CANONICAL", "FINALIZED_CANONICAL"]),
  receiptStatus: z.literal("SUCCESS"),
  blockNumber: uintStringSchema,
  blockHash: hex32Schema,
  transactionIndex: uintStringSchema,
  contractAddress: addressSchema.nullable(),
  finalityHeadBlockNumber: uintStringSchema,
  finalityHeadBlockHash: hex32Schema,
  observedAt: z.string().datetime(),
});

const manifestTransactionProvenanceSchema = z.object({
  deploymentId: hex32Schema,
  chainId: z.number().int().positive(),
  environmentId: z.string().min(1).max(96),
  sequence: z.number().int().min(1).max(PHASE11_EXPECTED_TRANSACTION_COUNT),
  actionId: z.string().min(1),
  from: addressSchema,
  nonce: uintStringSchema,
  to: addressSchema.nullable(),
  value: uintStringSchema,
  calldataHash: hex32Schema,
  transactionHash: hex32Schema,
  initialInclusion: manifestInitialInclusionSchema,
  safeInclusion: manifestCanonicalInclusionSchema.extend({ stage: z.literal("SAFE_CANONICAL") }),
  finalizedInclusion: manifestCanonicalInclusionSchema.extend({ stage: z.literal("FINALIZED_CANONICAL") }),
  canonicalInclusionClass: z.enum(["INITIAL_UNSAFE_CANONICAL", "REINCLUDED_AFTER_UNSAFE_REORG"]),
  contractAddress: addressSchema.nullable(),
});

const manifestRuntimeVerificationSchema = z.object({
  status: z.literal("PASS"),
  verifiedTransactionCount: z.number().int().min(PHASE11_EXPECTED_TRANSACTION_COUNT),
  contractAddresses: z.record(z.string(), addressSchema),
  protocolConfigHash: hex32Schema,
  policyId: hex32Schema,
  borrower: addressSchema,
  keeper: addressSchema,
  riskAttestor: addressSchema,
  policyActive: z.literal(true),
  protocolRelationshipsVerified: z.literal(true),
  tokenMetadataVerified: z.literal(true),
  oracleStateVerified: z.literal(true),
  verificationSource: z.enum(["RECONCILIATION_ARTIFACT", "DIRECT_FINALITY"]),
});

export const testnetDeploymentManifestPayloadSchema = z.object({
  schemaVersion: z.literal(PHASE11_DEPLOYMENT_MANIFEST_SCHEMA_VERSION),
  manifestType: z.literal(PHASE11_MANIFEST_TYPE),
  environmentId: z.literal(XLAYER_TESTNET_ENVIRONMENT_ID),
  compatibilityLabel: z.string().min(1).max(160),
  chainId: z.literal(XLAYER_TESTNET_CHAIN_ID),
  deploymentId: hex32Schema,
  finalityPolicy: deploymentFinalityPolicySchema,
  startingNonce: uintStringSchema,
  configurationHash: hex32Schema,
  expectedTransactionCount: z.literal(PHASE11_EXPECTED_TRANSACTION_COUNT).optional(),
  publicationSource: z.enum(["RECONCILIATION_ARTIFACT", "DIRECT_FINALITY"]).optional(),
  originalJournalPath: z.string().min(1).optional(),
  originalJournalSchemaVersion: z.number().int().positive().optional(),
  originalJournalSha256: sha256Schema.nullable().optional(),
  reconciliationArtifactPath: z.string().min(1).nullable().optional(),
  reconciliationArtifactSchemaVersion: z.number().int().positive().nullable().optional(),
  reconciliationArtifactSha256: sha256Schema.nullable().optional(),
  reconciliationArtifactInternalHash: hex32Schema.nullable().optional(),
  manifestCreationTimestamp: z.string().datetime().optional(),
  software: z.object({
    publisher: z.string().min(1),
    node: z.string().min(1),
  }).optional(),
  deploymentBlockNumber: uintStringSchema,
  deploymentBlockHash: hex32Schema,
  deploymentTransactions: z.array(manifestTransactionProvenanceSchema).length(PHASE11_EXPECTED_TRANSACTION_COUNT),
  egressContract: addressSchema,
  guardian: addressSchema,
  keeper: addressSchema,
  protocol: executionProtocolIdentitySchema,
  oracleSources: z.object({
    xbEth: addressSchema,
    xeth: addressSchema,
  }),
  protocolConfigHash: hex32Schema,
  executionBounds: testnetExecutionBoundsSchema,
  runtimeVerification: manifestRuntimeVerificationSchema.optional(),
  scenario: z.object({
    borrower: addressSchema,
    riskAttestor: addressSchema,
    initialCollateralWei: uintStringSchema,
    initialDebtWei: uintStringSchema,
    policyNonce: uintStringSchema,
    policyExpiresAt: uintStringSchema,
    policyId: hex32Schema,
    policyRegistrationTransactionHash: hex32Schema,
  }),
  runtimeCodeHashes: runtimeCodeHashesSchema,
  tokens: z.object({
    xbEth: testnetTokenIdentitySchema,
    xeth: testnetTokenIdentitySchema,
    aXbEth: testnetTokenIdentitySchema,
    variableDebtXeth: testnetTokenIdentitySchema,
  }),
});

export const testnetDeploymentManifestSchema = testnetDeploymentManifestPayloadSchema.extend({
  manifestHash: hex32Schema,
});

export type TestnetExecutionBounds = z.infer<typeof testnetExecutionBoundsSchema>;
export type TestnetDeploymentManifestPayload = z.infer<typeof testnetDeploymentManifestPayloadSchema>;
type ManifestInitialInclusion = Omit<z.infer<typeof manifestInitialInclusionSchema>, "blockHash" | "contractAddress"> & {
  blockHash: Hex;
  contractAddress: Address | null;
};
export type Phase11ManifestTransactionProvenance = Omit<
  z.infer<typeof manifestTransactionProvenanceSchema>,
  "deploymentId" | "actionId" | "from" | "to" | "calldataHash" | "transactionHash" | "initialInclusion" | "safeInclusion" | "finalizedInclusion" | "contractAddress"
> & {
  deploymentId: Hex;
  actionId: Phase11DeploymentActionId;
  from: Address;
  to: Address | null;
  calldataHash: Hex;
  transactionHash: Hex;
  initialInclusion: ManifestInitialInclusion;
  safeInclusion: Phase11SafeInclusion;
  finalizedInclusion: Phase11FinalizedInclusion;
  contractAddress: Address | null;
};
type ManifestProtocol = Omit<ExecutionProtocolIdentity, keyof ExecutionProtocolIdentity> & {
  addressesProvider: Address;
  aavePool: Address;
  aaveOracle: Address;
  xbEth: Address;
  xeth: Address;
  aXbEth: Address;
  variableDebtXeth: Address;
  uniswapFactory: Address;
  swapRouter: Address;
  quoterV2: Address;
  swapPool: Address;
  poolFee: number;
};
type ManifestRuntimeCodeHashes = {
  [key in keyof z.infer<typeof runtimeCodeHashesSchema>]: Hex;
};
export type TestnetDeploymentManifest = Omit<z.infer<typeof testnetDeploymentManifestSchema>,
  "manifestHash" | "deploymentId" | "configurationHash" | "deploymentBlockHash" | "deploymentTransactions" | "egressContract" | "guardian" | "keeper" | "protocol" | "oracleSources" | "protocolConfigHash" | "runtimeCodeHashes" | "tokens" | "scenario"> & {
  manifestHash: Hex;
  deploymentId: Hex;
  configurationHash: Hex;
  deploymentBlockHash: Hex;
  deploymentTransactions: Phase11ManifestTransactionProvenance[];
  egressContract: Address;
  guardian: Address;
  keeper: Address;
  protocol: ManifestProtocol;
  oracleSources: { xbEth: Address; xeth: Address };
  protocolConfigHash: Hex;
  runtimeCodeHashes: ManifestRuntimeCodeHashes;
  scenario: {
    borrower: Address;
    riskAttestor: Address;
    initialCollateralWei: string;
    initialDebtWei: string;
    policyNonce: string;
    policyExpiresAt: string;
    policyId: Hex;
    policyRegistrationTransactionHash: Hex;
  };
  runtimeVerification?: z.infer<typeof manifestRuntimeVerificationSchema>;
  tokens: {
    xbEth: { address: Address; name: string; symbol: string; decimals: number };
    xeth: { address: Address; name: string; symbol: string; decimals: number };
    aXbEth: { address: Address; name: string; symbol: string; decimals: number };
    variableDebtXeth: { address: Address; name: string; symbol: string; decimals: number };
  };
};

export interface TestnetDeploymentConfigurationIdentity {
  environmentId: string | null;
  manifestHash: Hex | null;
  chainId: number | null;
  anchorBlockNumber: bigint | null;
  anchorBlockHash: Hex | null;
  egressContract: Address | null;
  keeperAddress: Address | null;
  protocol: ExecutionProtocolIdentity | null;
}

export interface TestnetDeploymentVerification {
  environmentId: typeof XLAYER_TESTNET_ENVIRONMENT_ID;
  chainId: typeof XLAYER_TESTNET_CHAIN_ID;
  manifestHash: Hex;
  deploymentBlockNumber: bigint;
  deploymentBlockHash: Hex;
  egressContract: Address;
  keeper: Address;
  protocolConfigHash: Hex;
  policyId: Hex;
  policyRegistrationTransactionHash: Hex;
  verifiedTransactionCount: number;
  verifiedCodeHashes: Record<string, Hex>;
}

export class TestnetDeploymentVerificationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "TestnetDeploymentVerificationError";
  }
}

export interface Phase11EvmIdentityInput {
  deployer?: unknown;
  keeper?: unknown;
  borrower?: unknown;
  riskAttestor?: unknown;
}

export interface Phase11EvmIdentities {
  deployer: Address;
  keeper: Address;
  borrower: Address;
  riskAttestor: Address;
}

export class Phase11EvmIdentityValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "Phase11EvmIdentityValidationError";
  }
}

export function validatePhase11EvmIdentities(
  input: Phase11EvmIdentityInput,
): Phase11EvmIdentities {
  const names = ["deployer", "keeper", "borrower", "riskAttestor"] as const;
  const identities = {} as Phase11EvmIdentities;
  for (const name of names) {
    const value = input[name];
    if (typeof value !== "string" || value.trim().length === 0) {
      throw new Phase11EvmIdentityValidationError(`Phase 11 ${identityLabel(name)} address is required.`);
    }
    try {
      identities[name] = getAddress(value.trim());
    } catch {
      throw new Phase11EvmIdentityValidationError(
        `Phase 11 ${identityLabel(name)} address is not a valid EVM address.`,
      );
    }
  }

  for (let leftIndex = 0; leftIndex < names.length; leftIndex += 1) {
    for (let rightIndex = leftIndex + 1; rightIndex < names.length; rightIndex += 1) {
      const left = names[leftIndex]!;
      const right = names[rightIndex]!;
      if (identities[left].toLowerCase() === identities[right].toLowerCase()) {
        throw new Phase11EvmIdentityValidationError(
          `Phase 11 ${identityLabel(left)} and ${identityLabel(right)} identities must be distinct.`,
        );
      }
    }
  }
  return identities;
}

export function createTestnetDeploymentManifest(
  input: TestnetDeploymentManifestPayload,
): TestnetDeploymentManifest {
  validateTestnetManifestIdentities(input);
  const payload = testnetDeploymentManifestPayloadSchema.parse(input);
  assertTestnetDeploymentProvenance(payload as TestnetDeploymentManifestPayload);
  return testnetDeploymentManifestSchema.parse({
    ...payload,
    manifestHash: objectHash(payload),
  }) as TestnetDeploymentManifest;
}

export function verifyTestnetDeploymentManifest(
  value: unknown,
  expectedManifestHash?: Hex | null,
): TestnetDeploymentManifest {
  validateTestnetManifestIdentities(value);
  const manifest = testnetDeploymentManifestSchema.parse(value) as TestnetDeploymentManifest;
  assertTestnetDeploymentProvenance(manifest);
  const { manifestHash: _manifestHash, ...payload } = manifest;
  const computedHash = objectHash(payload);
  if (computedHash.toLowerCase() !== manifest.manifestHash.toLowerCase()) {
    throw new TestnetDeploymentVerificationError("Testnet deployment manifest integrity verification failed.");
  }
  if (expectedManifestHash && computedHash.toLowerCase() !== expectedManifestHash.toLowerCase()) {
    throw new TestnetDeploymentVerificationError(
      "Testnet deployment manifest does not match EGRESS_EXECUTION_TESTNET_MANIFEST_HASH.",
    );
  }
  if (executionProtocolConfigHash(manifest.protocol).toLowerCase() !== manifest.protocolConfigHash.toLowerCase()) {
    throw new TestnetDeploymentVerificationError(
      "Testnet deployment manifest protocol configuration hash is invalid.",
    );
  }
  assertTokenAddresses(manifest);
  return manifest;
}

export async function loadTestnetDeploymentManifest(
  path: string,
  expectedManifestHash: Hex,
): Promise<TestnetDeploymentManifest> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(await readFile(path, "utf8"));
  } catch (error) {
    throw new TestnetDeploymentVerificationError(
      `Unable to load the configured testnet deployment manifest: ${errorMessage(error)}`,
    );
  }
  return verifyTestnetDeploymentManifest(parsed, expectedManifestHash);
}

export function assertTestnetManifestMatchesConfiguration(input: {
  manifest: TestnetDeploymentManifest;
  config: TestnetDeploymentConfigurationIdentity;
}): void {
  const { manifest, config } = input;
  const mismatches = [
    config.environmentId !== manifest.environmentId ? "environment identifier" : null,
    config.manifestHash?.toLowerCase() !== manifest.manifestHash.toLowerCase() ? "manifest hash" : null,
    config.chainId !== manifest.chainId ? "chain ID" : null,
    config.anchorBlockNumber !== BigInt(manifest.deploymentBlockNumber) ? "deployment anchor block" : null,
    config.anchorBlockHash?.toLowerCase() !== manifest.deploymentBlockHash.toLowerCase() ? "deployment anchor hash" : null,
    !sameAddress(config.egressContract, manifest.egressContract) ? "Egress contract" : null,
    !sameAddress(config.keeperAddress, manifest.keeper) ? "keeper" : null,
    objectHash(config.protocol) !== objectHash(manifest.protocol) ? "protocol address book" : null,
  ].filter((value): value is string => value !== null);
  if (mismatches.length > 0) {
    throw new TestnetDeploymentVerificationError(
      `Configured TESTNET_WRITE identity differs from the signed deployment manifest: ${mismatches.join(", ")}.`,
    );
  }
}

export function testnetPolicyBoundViolations(
  policy: Record<string, string | number>,
  bounds: TestnetExecutionBounds,
): string[] {
  const maximum = (policyKey: string, boundKey: keyof TestnetExecutionBounds) =>
    BigInt(String(policy[policyKey])) > BigInt(String(bounds[boundKey])) ? policyKey : null;
  const minimum = (policyKey: string, boundKey: keyof TestnetExecutionBounds) =>
    BigInt(String(policy[policyKey])) < BigInt(String(bounds[boundKey])) ? policyKey : null;
  return [
    Number(policy.minimumRiskLevel) < bounds.minimumRiskLevel ? "minimumRiskLevel" : null,
    maximum("maxRepaymentPerExecution", "maxRepaymentPerExecution"),
    maximum("maxCollateralPerExecution", "maxCollateralPerExecution"),
    maximum("maxCumulativeRepayment", "maxCumulativeRepayment"),
    maximum("maxCumulativeCollateral", "maxCumulativeCollateral"),
    maximum("maxCollateralPercentageBps", "maxCollateralPercentageBps"),
    maximum("maxPositionDebt", "maxPositionDebt"),
    maximum("maxSlippageBps", "maxSlippageBps"),
    maximum("maxOracleDeviationBps", "maxOracleDeviationBps"),
    maximum("maxFlashLoanPremiumBps", "maxFlashLoanPremiumBps"),
    maximum("maxPreHealthFactor", "maxPreHealthFactor"),
    minimum("minPostHealthFactor", "minPostHealthFactor"),
    minimum("cooldownSeconds", "minCooldownSeconds"),
    maximum("maxExecutions", "maxExecutions"),
    maximum("maxRiskAgeSeconds", "maxRiskAgeSeconds"),
    maximum("maxClockSkewSeconds", "maxClockSkewSeconds"),
  ].filter((value): value is string => value !== null);
}

export async function verifyTestnetDeploymentRuntime(
  client: PublicClient,
  input: {
    manifest: TestnetDeploymentManifest;
    config: TestnetDeploymentConfigurationIdentity;
  },
): Promise<TestnetDeploymentVerification> {
  const manifest = verifyTestnetDeploymentManifest(input.manifest, input.config.manifestHash);
  assertTestnetManifestMatchesConfiguration({ manifest, config: input.config });

  const observedChainId = await client.getChainId();
  if (observedChainId !== XLAYER_TESTNET_CHAIN_ID) {
    throw new TestnetDeploymentVerificationError(
      `TESTNET_WRITE RPC returned chain ${observedChainId}; expected ${XLAYER_TESTNET_CHAIN_ID}.`,
    );
  }
  const deploymentBlockNumber = BigInt(manifest.deploymentBlockNumber);
  const deploymentBlock = await client.getBlock({ blockNumber: deploymentBlockNumber });
  if (!deploymentBlock.hash || deploymentBlock.hash.toLowerCase() !== manifest.deploymentBlockHash.toLowerCase()) {
    throw new TestnetDeploymentVerificationError(
      "The manifest deployment block is absent from the configured X Layer testnet RPC.",
    );
  }
  const finalizedHead = await client.getBlock({ blockTag: "finalized" });
  if (
    finalizedHead.number === null ||
    !finalizedHead.hash ||
    finalizedHead.number < deploymentBlockNumber
  ) {
    throw new TestnetDeploymentVerificationError(
      "The configured X Layer testnet RPC has not finalized the deployment anchor.",
    );
  }
  const deploymentEvidence = await Promise.all(manifest.deploymentTransactions.map(async (record) => ({
    record,
    receipt: await client.getTransactionReceipt({ hash: record.transactionHash }),
    transaction: await client.getTransaction({ hash: record.transactionHash }),
    block: await client.getBlock({
      blockNumber: BigInt(record.finalizedInclusion.blockNumber),
      includeTransactions: true,
    }),
  })));
  for (const evidence of deploymentEvidence) {
    assertRuntimeTransactionEvidence(evidence, deploymentBlockNumber);
    assertRuntimeCanonicalBlockEvidence(evidence);
  }

  const addresses = runtimeAddresses(manifest);
  const codeEntries = await Promise.all(Object.entries(addresses).map(async ([role, address]) => {
    const bytecode = await client.getBytecode({ address });
    if (!bytecode || bytecode === "0x") {
      throw new TestnetDeploymentVerificationError(`Missing runtime bytecode for ${role} at ${address}.`);
    }
    return [role, keccak256(bytecode)] as const;
  }));
  const verifiedCodeHashes = Object.fromEntries(codeEntries) as Record<string, Hex>;
  for (const [role, actual] of Object.entries(verifiedCodeHashes)) {
    const expected = manifest.runtimeCodeHashes[role as keyof typeof manifest.runtimeCodeHashes];
    if (!expected || actual.toLowerCase() !== expected.toLowerCase()) {
      throw new TestnetDeploymentVerificationError(`Runtime bytecode hash mismatch for ${role}.`);
    }
  }

  await verifyEgressIdentity(client, manifest);
  await verifyProtocolIdentity(client, manifest);
  await verifyTokenIdentity(client, manifest);

  return {
    environmentId: manifest.environmentId,
    chainId: manifest.chainId,
    manifestHash: manifest.manifestHash as Hex,
    deploymentBlockNumber,
    deploymentBlockHash: manifest.deploymentBlockHash as Hex,
    egressContract: getAddress(manifest.egressContract),
    keeper: getAddress(manifest.keeper),
    protocolConfigHash: manifest.protocolConfigHash as Hex,
    policyId: manifest.scenario.policyId,
    policyRegistrationTransactionHash: manifest.scenario.policyRegistrationTransactionHash,
    verifiedTransactionCount: deploymentEvidence.length,
    verifiedCodeHashes,
  };
}

function assertTestnetDeploymentProvenance(
  manifest: TestnetDeploymentManifestPayload | TestnetDeploymentManifest,
): void {
  const deployer = getAddress(manifest.guardian);
  const keeper = getAddress(manifest.keeper);
  const borrower = getAddress(manifest.scenario.borrower);
  const riskAttestor = getAddress(manifest.scenario.riskAttestor);
  const configurationHash = manifest.configurationHash as Hex;
  const expectedConfigurationHash = phase11DeploymentConfigurationHash({
    chainId: manifest.chainId,
    environmentId: manifest.environmentId,
    deployer,
    keeper,
    borrower,
    riskAttestor,
    compatibilityLabel: manifest.compatibilityLabel,
    executionBounds: manifest.executionBounds,
    startingNonce: manifest.startingNonce,
  });
  if (expectedConfigurationHash.toLowerCase() !== manifest.configurationHash.toLowerCase()) {
    throw new TestnetDeploymentVerificationError("Testnet deployment configuration hash is inconsistent with the manifest.");
  }
  const expectedDeploymentId = phase11DeploymentId({
    chainId: manifest.chainId,
    environmentId: manifest.environmentId,
    deployer,
    startingNonce: manifest.startingNonce,
    configurationHash,
  });
  if (expectedDeploymentId.toLowerCase() !== manifest.deploymentId.toLowerCase()) {
    throw new TestnetDeploymentVerificationError("Testnet deployment ID is inconsistent with the manifest.");
  }
  if (manifest.deploymentTransactions.length !== PHASE11_EXPECTED_TRANSACTION_COUNT) {
    throw new TestnetDeploymentVerificationError(
      `Testnet deployment provenance must contain exactly ${PHASE11_EXPECTED_TRANSACTION_COUNT} transactions.`,
    );
  }
  if (
    manifest.expectedTransactionCount !== undefined &&
    manifest.expectedTransactionCount !== PHASE11_EXPECTED_TRANSACTION_COUNT
  ) {
    throw new TestnetDeploymentVerificationError("Testnet deployment expected transaction count is invalid.");
  }
  if (manifest.publicationSource === "RECONCILIATION_ARTIFACT") {
    if (
      !manifest.originalJournalPath ||
      !manifest.originalJournalSha256 ||
      !manifest.reconciliationArtifactPath ||
      !manifest.reconciliationArtifactSchemaVersion ||
      !manifest.reconciliationArtifactSha256 ||
      !manifest.reconciliationArtifactInternalHash ||
      manifest.originalJournalPath === manifest.reconciliationArtifactPath
    ) {
      throw new TestnetDeploymentVerificationError(
        "Reconciled testnet deployment manifest source provenance is incomplete.",
      );
    }
  } else if (manifest.publicationSource === "DIRECT_FINALITY") {
    if (
      manifest.reconciliationArtifactPath !== null ||
      manifest.reconciliationArtifactSchemaVersion !== null ||
      manifest.reconciliationArtifactSha256 !== null ||
      manifest.reconciliationArtifactInternalHash !== null
    ) {
      throw new TestnetDeploymentVerificationError(
        "Direct-finality testnet deployment manifest unexpectedly references reconciliation evidence.",
      );
    }
  }
  if (manifest.runtimeVerification) {
    const runtime = manifest.runtimeVerification;
    if (
      runtime.verifiedTransactionCount !== PHASE11_EXPECTED_TRANSACTION_COUNT ||
      runtime.protocolConfigHash.toLowerCase() !== manifest.protocolConfigHash.toLowerCase() ||
      runtime.policyId.toLowerCase() !== manifest.scenario.policyId.toLowerCase() ||
      !sameAddress(runtime.borrower, manifest.scenario.borrower) ||
      !sameAddress(runtime.keeper, manifest.keeper) ||
      !sameAddress(runtime.riskAttestor, manifest.scenario.riskAttestor)
    ) {
      throw new TestnetDeploymentVerificationError("Testnet deployment runtime verification evidence is inconsistent.");
    }
  }
  if (
    manifest.finalityPolicy.version !== PHASE11_DEPLOYMENT_FINALITY_POLICY_VERSION ||
    manifest.finalityPolicy.publication !== PHASE11_DEPLOYMENT_FINALITY_POLICY ||
    manifest.finalityPolicy.safeTag !== "safe" ||
    manifest.finalityPolicy.finalizedTag !== "finalized"
  ) {
    throw new TestnetDeploymentVerificationError("Testnet deployment finality policy is invalid.");
  }
  const transactionHashes = new Set<string>();
  const blockHashesByNumber = new Map<string, string>();
  let previousBlockNumber = 0n;
  for (let index = 0; index < PHASE11_DEPLOYMENT_SEQUENCE.length; index += 1) {
    const expected = PHASE11_DEPLOYMENT_SEQUENCE[index]!;
    const record = manifest.deploymentTransactions[index];
    if (!record || record.sequence !== expected.sequence || record.actionId !== expected.actionId) {
      throw new TestnetDeploymentVerificationError(
        `Testnet deployment provenance step ${index + 1} does not match ${expected.actionId}.`,
      );
    }
    if (transactionHashes.has(record.transactionHash.toLowerCase())) {
      throw new TestnetDeploymentVerificationError("Testnet deployment provenance contains duplicate transaction hashes.");
    }
    transactionHashes.add(record.transactionHash.toLowerCase());
    if (
      record.deploymentId.toLowerCase() !== manifest.deploymentId.toLowerCase() ||
      record.chainId !== manifest.chainId ||
      record.environmentId !== manifest.environmentId ||
      !sameAddress(record.from, manifest.guardian) ||
      record.initialInclusion.receiptStatus !== "SUCCESS" ||
      record.safeInclusion.receiptStatus !== "SUCCESS" ||
      record.finalizedInclusion.receiptStatus !== "SUCCESS" ||
      record.value !== "0"
    ) {
      throw new TestnetDeploymentVerificationError(
        `Testnet deployment provenance identity is inconsistent at step ${record.sequence}.`,
      );
    }
    const expectedNonce = BigInt(manifest.startingNonce) + BigInt(index);
    if (BigInt(record.nonce) !== expectedNonce) {
      throw new TestnetDeploymentVerificationError(
        `Testnet deployment provenance nonce is inconsistent at step ${record.sequence}.`,
      );
    }
    const expectedIdentity = expectedTransactionIdentity(manifest, expected.actionId);
    if (expected.kind === "DEPLOYMENT") {
      if (record.to !== null || !record.contractAddress || !sameAddress(record.contractAddress, expectedIdentity.address)) {
        throw new TestnetDeploymentVerificationError(
          `Testnet deployment contract address is inconsistent at step ${record.sequence}.`,
        );
      }
      const derivedAddress = getContractAddress({ from: getAddress(record.from), nonce: BigInt(record.nonce) });
      if (!sameAddress(record.contractAddress, derivedAddress)) {
        throw new TestnetDeploymentVerificationError(
          `Testnet deployment contract address does not match the deployer nonce at step ${record.sequence}.`,
        );
      }
    } else if (record.to === null || !sameAddress(record.to, expectedIdentity.address) || record.contractAddress !== null) {
      throw new TestnetDeploymentVerificationError(
        `Testnet deployment call target is inconsistent at step ${record.sequence}.`,
      );
    }
    if (
      record.initialInclusion.stage !== "INITIAL_UNSAFE" ||
      record.safeInclusion.stage !== "SAFE_CANONICAL" ||
      record.finalizedInclusion.stage !== "FINALIZED_CANONICAL" ||
      record.safeInclusion.blockNumber !== record.finalizedInclusion.blockNumber ||
      record.safeInclusion.blockHash.toLowerCase() !== record.finalizedInclusion.blockHash.toLowerCase() ||
      record.safeInclusion.transactionIndex !== record.finalizedInclusion.transactionIndex ||
      !sameNullableAddress(record.safeInclusion.contractAddress, record.finalizedInclusion.contractAddress) ||
      BigInt(record.safeInclusion.finalityHeadBlockNumber) < BigInt(record.safeInclusion.blockNumber) ||
      BigInt(record.finalizedInclusion.finalityHeadBlockNumber) < BigInt(record.finalizedInclusion.blockNumber)
    ) {
      throw new TestnetDeploymentVerificationError(
        `Testnet deployment finality evidence is inconsistent at step ${record.sequence}.`,
      );
    }
    const expectedInclusionClass = record.initialInclusion.blockNumber === record.safeInclusion.blockNumber &&
      record.initialInclusion.blockHash.toLowerCase() === record.safeInclusion.blockHash.toLowerCase()
      ? "INITIAL_UNSAFE_CANONICAL"
      : "REINCLUDED_AFTER_UNSAFE_REORG";
    if (record.canonicalInclusionClass !== expectedInclusionClass) {
      throw new TestnetDeploymentVerificationError(
        `Testnet deployment canonical inclusion class is inconsistent at step ${record.sequence}.`,
      );
    }
    const blockNumber = BigInt(record.finalizedInclusion.blockNumber);
    const normalizedBlockHash = record.finalizedInclusion.blockHash.toLowerCase();
    const recordedBlockHash = blockHashesByNumber.get(record.finalizedInclusion.blockNumber);
    if (recordedBlockHash && recordedBlockHash !== normalizedBlockHash) {
      throw new TestnetDeploymentVerificationError(
        `Testnet deployment block hash is inconsistent at step ${record.sequence}.`,
      );
    }
    blockHashesByNumber.set(record.finalizedInclusion.blockNumber, normalizedBlockHash);
    if (blockNumber < previousBlockNumber) {
      throw new TestnetDeploymentVerificationError(
        `Testnet deployment transaction blocks are out of order at step ${record.sequence}.`,
      );
    }
    previousBlockNumber = blockNumber;
    if (blockNumber > BigInt(manifest.deploymentBlockNumber)) {
      throw new TestnetDeploymentVerificationError(
        `Testnet deployment transaction at step ${record.sequence} is newer than the deployment anchor.`,
      );
    }
  }
  const policyRecord = manifest.deploymentTransactions[PHASE11_EXPECTED_TRANSACTION_COUNT - 1]!;
  if (policyRecord.actionId !== "REGISTER_PROTECTION_POLICY" ||
      policyRecord.transactionHash.toLowerCase() !== manifest.scenario.policyRegistrationTransactionHash.toLowerCase() ||
      policyRecord.finalizedInclusion.blockNumber !== manifest.deploymentBlockNumber ||
      policyRecord.finalizedInclusion.blockHash.toLowerCase() !== manifest.deploymentBlockHash.toLowerCase()) {
    throw new TestnetDeploymentVerificationError("Policy registration must be the final deployment transaction.");
  }
}

function expectedTransactionIdentity(
  manifest: TestnetDeploymentManifestPayload | TestnetDeploymentManifest,
  actionId: Phase11DeploymentActionId,
): { address: Address } {
  const protocol = manifest.protocol;
  const identityByAction: Partial<Record<Phase11DeploymentActionId, Address>> = {
    DEPLOY_XBETH: getAddress(protocol.xbEth),
    DEPLOY_XETH: getAddress(protocol.xeth),
    DEPLOY_ADDRESSES_PROVIDER: getAddress(protocol.addressesProvider),
    DEPLOY_ORACLE: getAddress(protocol.aaveOracle),
    DEPLOY_AAVE_POOL: getAddress(protocol.aavePool),
    DEPLOY_ATOKEN: getAddress(protocol.aXbEth),
    DEPLOY_VARIABLE_DEBT_TOKEN: getAddress(protocol.variableDebtXeth),
    CONFIGURE_PROVIDER: getAddress(protocol.addressesProvider),
    CONFIGURE_POOL_RESERVES: getAddress(protocol.aavePool),
    ENABLE_XBETH_MINTER: getAddress(protocol.xbEth),
    ENABLE_XETH_MINTER: getAddress(protocol.xeth),
    ENABLE_ATOKEN_MINTER: getAddress(protocol.aXbEth),
    ENABLE_DEBT_TOKEN_MINTER: getAddress(protocol.variableDebtXeth),
    SET_XBETH_ORACLE_PRICE: getAddress(protocol.aaveOracle),
    SET_XETH_ORACLE_PRICE: getAddress(protocol.aaveOracle),
    DEPLOY_SWAP_FACTORY: getAddress(protocol.uniswapFactory),
    DEPLOY_SWAP_ROUTER: getAddress(protocol.swapRouter),
    DEPLOY_QUOTER: getAddress(protocol.quoterV2),
    DEPLOY_SWAP_POOL: getAddress(protocol.swapPool),
    CONFIGURE_SWAP_FACTORY: getAddress(protocol.uniswapFactory),
    MINT_XBETH_SWAP_LIQUIDITY: getAddress(protocol.xbEth),
    MINT_XETH_SWAP_LIQUIDITY: getAddress(protocol.xeth),
    SEED_BORROWER_POSITION: getAddress(protocol.aavePool),
    SEED_FLASH_LIQUIDITY: getAddress(protocol.aavePool),
    DEPLOY_EGRESS_EXECUTOR: getAddress(manifest.egressContract),
    REGISTER_PROTECTION_POLICY: getAddress(manifest.egressContract),
  };
  const address = identityByAction[actionId];
  if (!address) throw new TestnetDeploymentVerificationError(`No target identity is defined for ${actionId}.`);
  return { address };
}

function assertRuntimeTransactionEvidence(
  evidence: {
    record: Phase11ManifestTransactionProvenance;
    receipt: Awaited<ReturnType<PublicClient["getTransactionReceipt"]>>;
    transaction: Awaited<ReturnType<PublicClient["getTransaction"]>>;
  },
  deploymentBlockNumber: bigint,
): void {
  const { record, receipt, transaction } = evidence;
  if (
    receipt.transactionHash.toLowerCase() !== record.transactionHash.toLowerCase() ||
    receipt.status !== "success" ||
    receipt.blockNumber !== BigInt(record.finalizedInclusion.blockNumber) ||
    !receipt.blockHash ||
    receipt.blockHash.toLowerCase() !== record.finalizedInclusion.blockHash.toLowerCase() ||
    receipt.transactionIndex !== Number(record.finalizedInclusion.transactionIndex) ||
    receipt.blockNumber > deploymentBlockNumber ||
    !sameAddress(receipt.from, record.from) ||
    !sameNullableAddress(receipt.to, record.to)
  ) {
    throw new TestnetDeploymentVerificationError(
      `Deployment receipt does not match provenance at step ${record.sequence}.`,
    );
  }
  if (!transaction ||
      transaction.hash.toLowerCase() !== record.transactionHash.toLowerCase() ||
      !sameAddress(transaction.from, record.from) ||
      BigInt(transaction.nonce) !== BigInt(record.nonce) ||
      !sameNullableAddress(transaction.to, record.to) ||
      transaction.value !== BigInt(record.value) ||
      keccak256(transaction.input).toLowerCase() !== record.calldataHash.toLowerCase() ||
      (transaction.chainId !== undefined && Number(transaction.chainId) !== record.chainId)) {
    throw new TestnetDeploymentVerificationError(
      `Deployment transaction does not match provenance at step ${record.sequence}.`,
    );
  }
  const expected = PHASE11_DEPLOYMENT_SEQUENCE[record.sequence - 1]!;
  if (expected.kind === "DEPLOYMENT") {
    const derivedAddress = getContractAddress({ from: record.from, nonce: BigInt(record.nonce) });
    if (!record.contractAddress || !sameAddress(record.contractAddress, derivedAddress) ||
      !sameNullableAddress(receipt.contractAddress, record.contractAddress) ||
      !sameNullableAddress(record.finalizedInclusion.contractAddress, record.contractAddress)) {
      throw new TestnetDeploymentVerificationError(
        `Deployment receipt contract address does not match provenance at step ${record.sequence}.`,
      );
    }
  } else if (record.contractAddress !== null || receipt.contractAddress) {
    throw new TestnetDeploymentVerificationError(
      `Non-deployment transaction unexpectedly contains a contract address at step ${record.sequence}.`,
    );
  }
}

function assertRuntimeCanonicalBlockEvidence(evidence: {
  record: Phase11ManifestTransactionProvenance;
  receipt: Awaited<ReturnType<PublicClient["getTransactionReceipt"]>>;
  block: Awaited<ReturnType<PublicClient["getBlock"]>>;
}): void {
  const { record, receipt, block } = evidence;
  if (
    !block.hash ||
    block.number === null ||
    block.number !== receipt.blockNumber ||
    block.hash.toLowerCase() !== record.finalizedInclusion.blockHash.toLowerCase()
  ) {
    throw new TestnetDeploymentVerificationError(
      `Deployment canonical block does not match provenance at step ${record.sequence}.`,
    );
  }
  const transaction = (block.transactions as readonly unknown[])[receipt.transactionIndex];
  const hash = typeof transaction === "string"
    ? transaction
    : typeof transaction === "object" && transaction !== null && "hash" in transaction
      ? String((transaction as { hash: unknown }).hash)
      : null;
  if (!hash || hash.toLowerCase() !== record.transactionHash.toLowerCase()) {
    throw new TestnetDeploymentVerificationError(
      `Deployment transaction is absent from its finalized canonical block at step ${record.sequence}.`,
    );
  }
}

const egressIdentityAbi = parseAbi([
  "function AAVE_POOL() view returns (address)",
  "function A_XBETH() view returns (address)",
  "function SWAP_ROUTER() view returns (address)",
  "function POOL_ADDRESSES_PROVIDER() view returns (address)",
  "function AAVE_ORACLE() view returns (address)",
  "function XETH() view returns (address)",
  "function XBETH() view returns (address)",
  "function VARIABLE_DEBT_XETH() view returns (address)",
  "function UNISWAP_FACTORY() view returns (address)",
  "function SWAP_POOL() view returns (address)",
  "function GUARDIAN() view returns (address)",
  "function POOL_FEE() view returns (uint24)",
  "function PROTOCOL_CONFIG_HASH() view returns (bytes32)",
  "function paused() view returns (bool)",
  "function policyStates(bytes32 policyId) view returns (address user,bool active,uint256 executionCount,uint256 lastExecutionAt,uint256 cumulativeRepayment,uint256 cumulativeCollateral,uint256 enrollmentCollateral,uint256 enrollmentDebt)",
]);

const protocolIdentityAbi = parseAbi([
  "function ADDRESSES_PROVIDER() view returns (address)",
  "function FLASHLOAN_PREMIUM_TOTAL() view returns (uint128)",
  "function getPool() view returns (address)",
  "function getPriceOracle() view returns (address)",
  "function getAssetPrice(address asset) view returns (uint256)",
  "function getSourceOfAsset(address asset) view returns (address)",
  "function POOL() view returns (address)",
  "function UNDERLYING_ASSET_ADDRESS() view returns (address)",
  "function factory() view returns (address)",
  "function token0() view returns (address)",
  "function token1() view returns (address)",
  "function fee() view returns (uint24)",
  "function getPool(address tokenA,address tokenB,uint24 fee) view returns (address)",
]);

const tokenIdentityAbi = parseAbi([
  "function name() view returns (string)",
  "function symbol() view returns (string)",
  "function decimals() view returns (uint8)",
]);

async function verifyEgressIdentity(client: PublicClient, manifest: TestnetDeploymentManifest): Promise<void> {
  const protocol = manifest.protocol;
  const reads = await Promise.all([
    readAddress(client, manifest.egressContract, "AAVE_POOL"),
    readAddress(client, manifest.egressContract, "A_XBETH"),
    readAddress(client, manifest.egressContract, "SWAP_ROUTER"),
    readAddress(client, manifest.egressContract, "POOL_ADDRESSES_PROVIDER"),
    readAddress(client, manifest.egressContract, "AAVE_ORACLE"),
    readAddress(client, manifest.egressContract, "XETH"),
    readAddress(client, manifest.egressContract, "XBETH"),
    readAddress(client, manifest.egressContract, "VARIABLE_DEBT_XETH"),
    readAddress(client, manifest.egressContract, "UNISWAP_FACTORY"),
    readAddress(client, manifest.egressContract, "SWAP_POOL"),
    readAddress(client, manifest.egressContract, "GUARDIAN"),
    client.readContract({ address: manifest.egressContract, abi: egressIdentityAbi, functionName: "POOL_FEE" }),
    client.readContract({ address: manifest.egressContract, abi: egressIdentityAbi, functionName: "PROTOCOL_CONFIG_HASH" }),
    client.readContract({ address: manifest.egressContract, abi: egressIdentityAbi, functionName: "paused" }),
  ]);
  const expected = [
    protocol.aavePool,
    protocol.aXbEth,
    protocol.swapRouter,
    protocol.addressesProvider,
    protocol.aaveOracle,
    protocol.xeth,
    protocol.xbEth,
    protocol.variableDebtXeth,
    protocol.uniswapFactory,
    protocol.swapPool,
    manifest.guardian,
  ];
  for (let index = 0; index < expected.length; index += 1) {
    if (!sameAddress(reads[index] as Address, expected[index]!)) {
      throw new TestnetDeploymentVerificationError("Egress immutable protocol identity does not match the manifest.");
    }
  }
  if (Number(reads[11]) !== protocol.poolFee) {
    throw new TestnetDeploymentVerificationError("Egress pool fee does not match the manifest.");
  }
  if (String(reads[12]).toLowerCase() !== manifest.protocolConfigHash.toLowerCase()) {
    throw new TestnetDeploymentVerificationError("Egress protocol configuration hash does not match the manifest.");
  }
  if (reads[13] !== false) {
    throw new TestnetDeploymentVerificationError("The configured testnet Egress executor is paused.");
  }
  const policyState = await client.readContract({
    address: manifest.egressContract,
    abi: egressIdentityAbi,
    functionName: "policyStates",
    args: [manifest.scenario.policyId],
  }) as readonly [Address, boolean, bigint, bigint, bigint, bigint, bigint, bigint];
  if (
    !sameAddress(policyState[0], manifest.scenario.borrower) ||
    !policyState[1] ||
    policyState[2] > BigInt(manifest.executionBounds.maxExecutions) ||
    policyState[4] > BigInt(manifest.executionBounds.maxCumulativeRepayment) ||
    policyState[5] > BigInt(manifest.executionBounds.maxCumulativeCollateral) ||
    policyState[6] !== BigInt(manifest.scenario.initialCollateralWei) ||
    policyState[7] !== BigInt(manifest.scenario.initialDebtWei)
  ) {
    throw new TestnetDeploymentVerificationError(
      "The manifest-pinned protection policy is missing, inactive, or outside its registered bounds.",
    );
  }
}

async function verifyProtocolIdentity(client: PublicClient, manifest: TestnetDeploymentManifest): Promise<void> {
  const protocol = manifest.protocol;
  const [
    poolProvider,
    providerPool,
    providerOracle,
    aTokenPool,
    aTokenUnderlying,
    debtTokenPool,
    debtTokenUnderlying,
    routerFactory,
    quoterFactory,
    poolFactory,
    poolToken0,
    poolToken1,
    poolFee,
    factoryPool,
    xbEthPrice,
    xethPrice,
    xbEthSource,
    xethSource,
    flashLoanPremiumBps,
  ] = await Promise.all([
    readAddress(client, protocol.aavePool, "ADDRESSES_PROVIDER"),
    readAddress(client, protocol.addressesProvider, "getPool"),
    readAddress(client, protocol.addressesProvider, "getPriceOracle"),
    readAddress(client, protocol.aXbEth, "POOL"),
    readAddress(client, protocol.aXbEth, "UNDERLYING_ASSET_ADDRESS"),
    readAddress(client, protocol.variableDebtXeth, "POOL"),
    readAddress(client, protocol.variableDebtXeth, "UNDERLYING_ASSET_ADDRESS"),
    readAddress(client, protocol.swapRouter, "factory"),
    readAddress(client, protocol.quoterV2, "factory"),
    readAddress(client, protocol.swapPool, "factory"),
    readAddress(client, protocol.swapPool, "token0"),
    readAddress(client, protocol.swapPool, "token1"),
    client.readContract({ address: protocol.swapPool, abi: protocolIdentityAbi, functionName: "fee" }),
    client.readContract({
      address: protocol.uniswapFactory,
      abi: protocolIdentityAbi,
      functionName: "getPool",
      args: [protocol.xbEth, protocol.xeth, protocol.poolFee],
    }),
    client.readContract({ address: protocol.aaveOracle, abi: protocolIdentityAbi, functionName: "getAssetPrice", args: [protocol.xbEth] }),
    client.readContract({ address: protocol.aaveOracle, abi: protocolIdentityAbi, functionName: "getAssetPrice", args: [protocol.xeth] }),
    client.readContract({ address: protocol.aaveOracle, abi: protocolIdentityAbi, functionName: "getSourceOfAsset", args: [protocol.xbEth] }),
    client.readContract({ address: protocol.aaveOracle, abi: protocolIdentityAbi, functionName: "getSourceOfAsset", args: [protocol.xeth] }),
    client.readContract({ address: protocol.aavePool, abi: protocolIdentityAbi, functionName: "FLASHLOAN_PREMIUM_TOTAL" }),
  ]);
  const addressChecks: Array<[Address, Address]> = [
    [poolProvider, protocol.addressesProvider],
    [providerPool, protocol.aavePool],
    [providerOracle, protocol.aaveOracle],
    [aTokenPool, protocol.aavePool],
    [aTokenUnderlying, protocol.xbEth],
    [debtTokenPool, protocol.aavePool],
    [debtTokenUnderlying, protocol.xeth],
    [routerFactory, protocol.uniswapFactory],
    [quoterFactory, protocol.uniswapFactory],
    [poolFactory, protocol.uniswapFactory],
    [poolToken0, protocol.xbEth],
    [poolToken1, protocol.xeth],
    [factoryPool, protocol.swapPool],
    [xbEthSource, manifest.oracleSources.xbEth],
    [xethSource, manifest.oracleSources.xeth],
  ];
  if (addressChecks.some(([actual, expected]) => !sameAddress(actual, expected))) {
    throw new TestnetDeploymentVerificationError("Testnet Aave or Uniswap contract relationships do not match the manifest.");
  }
  if (Number(poolFee) !== protocol.poolFee) {
    throw new TestnetDeploymentVerificationError("Testnet swap pool fee does not match the manifest.");
  }
  if (xbEthPrice <= 0n || xethPrice <= 0n) {
    throw new TestnetDeploymentVerificationError("Testnet oracle returned a non-positive configured asset price.");
  }
  if (BigInt(flashLoanPremiumBps) > BigInt(manifest.executionBounds.maxFlashLoanPremiumBps)) {
    throw new TestnetDeploymentVerificationError("Testnet flash-loan premium exceeds the manifest execution bound.");
  }
}

async function verifyTokenIdentity(client: PublicClient, manifest: TestnetDeploymentManifest): Promise<void> {
  for (const [role, expected] of Object.entries(manifest.tokens)) {
    const [name, symbol, decimals] = await Promise.all([
      client.readContract({ address: expected.address, abi: tokenIdentityAbi, functionName: "name" }),
      client.readContract({ address: expected.address, abi: tokenIdentityAbi, functionName: "symbol" }),
      client.readContract({ address: expected.address, abi: tokenIdentityAbi, functionName: "decimals" }),
    ]);
    if (name !== expected.name || symbol !== expected.symbol || Number(decimals) !== expected.decimals) {
      throw new TestnetDeploymentVerificationError(`Token identity mismatch for ${role}.`);
    }
  }
}

async function readAddress(
  client: PublicClient,
  address: Address,
  functionName:
    | "AAVE_POOL"
    | "A_XBETH"
    | "SWAP_ROUTER"
    | "POOL_ADDRESSES_PROVIDER"
    | "AAVE_ORACLE"
    | "XETH"
    | "XBETH"
    | "VARIABLE_DEBT_XETH"
    | "UNISWAP_FACTORY"
    | "SWAP_POOL"
    | "GUARDIAN"
    | "ADDRESSES_PROVIDER"
    | "getPool"
    | "getPriceOracle"
    | "POOL"
    | "UNDERLYING_ASSET_ADDRESS"
    | "factory"
    | "token0"
    | "token1",
): Promise<Address> {
  return await client.readContract({
    address,
    abi: functionName === "AAVE_POOL" || functionName === "A_XBETH" || functionName === "SWAP_ROUTER" ||
      functionName === "POOL_ADDRESSES_PROVIDER" || functionName === "AAVE_ORACLE" || functionName === "XETH" ||
      functionName === "XBETH" || functionName === "VARIABLE_DEBT_XETH" || functionName === "UNISWAP_FACTORY" ||
      functionName === "SWAP_POOL" || functionName === "GUARDIAN"
      ? egressIdentityAbi
      : protocolIdentityAbi,
    functionName,
  } as never) as Address;
}

function runtimeAddresses(manifest: TestnetDeploymentManifest): Record<keyof TestnetDeploymentManifest["runtimeCodeHashes"], Address> {
  return {
    egressContract: manifest.egressContract,
    addressesProvider: manifest.protocol.addressesProvider,
    aavePool: manifest.protocol.aavePool,
    aaveOracle: manifest.protocol.aaveOracle,
    xbEthOracleSource: manifest.oracleSources.xbEth,
    xethOracleSource: manifest.oracleSources.xeth,
    xbEth: manifest.protocol.xbEth,
    xeth: manifest.protocol.xeth,
    aXbEth: manifest.protocol.aXbEth,
    variableDebtXeth: manifest.protocol.variableDebtXeth,
    uniswapFactory: manifest.protocol.uniswapFactory,
    swapRouter: manifest.protocol.swapRouter,
    quoterV2: manifest.protocol.quoterV2,
    swapPool: manifest.protocol.swapPool,
  };
}

function assertTokenAddresses(manifest: TestnetDeploymentManifest): void {
  const expected: Array<[Address, Address]> = [
    [manifest.tokens.xbEth.address, manifest.protocol.xbEth],
    [manifest.tokens.xeth.address, manifest.protocol.xeth],
    [manifest.tokens.aXbEth.address, manifest.protocol.aXbEth],
    [manifest.tokens.variableDebtXeth.address, manifest.protocol.variableDebtXeth],
  ];
  if (expected.some(([actual, protocolAddress]) => !sameAddress(actual, protocolAddress))) {
    throw new TestnetDeploymentVerificationError("Manifest token identities do not match the protocol address book.");
  }
}

function validateTestnetManifestIdentities(value: unknown): Phase11EvmIdentities {
  const manifest = recordValue(value);
  const scenario = recordValue(manifest.scenario);
  return validatePhase11EvmIdentities({
    deployer: manifest.guardian,
    keeper: manifest.keeper,
    borrower: scenario.borrower,
    riskAttestor: scenario.riskAttestor,
  });
}

function recordValue(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function identityLabel(name: keyof Phase11EvmIdentities): string {
  return name === "riskAttestor" ? "risk attestor" : name;
}

function sameAddress(left: string | null | undefined, right: string): boolean {
  return Boolean(left) && left!.toLowerCase() === right.toLowerCase();
}

function sameNullableAddress(
  left: string | null | undefined,
  right: string | null | undefined,
): boolean {
  if (left === null || left === undefined || right === null || right === undefined) {
    return (left === null || left === undefined) && (right === null || right === undefined);
  }
  return left.toLowerCase() === right.toLowerCase();
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message.split("\n")[0] ?? error.name : String(error);
}
