import { createHash, randomUUID } from "node:crypto";
import {
  link,
  mkdir,
  open,
  readFile,
  unlink,
} from "node:fs/promises";
import { dirname, resolve } from "node:path";
import {
  decodeFunctionData,
  getAddress,
  getContractAddress,
  keccak256,
  parseAbi,
  type Address,
  type Hex,
  type PublicClient,
} from "viem";
import { z } from "zod";
import {
  objectHash,
} from "../domain/hash.js";
import {
  addressSchema,
  hex32Schema,
  sha256Schema,
  uintStringSchema,
} from "../domain/schemas.js";
import { executionProtocolConfigHash } from "./protocol.js";
import type { ExecutionProtocolIdentity } from "./schemas.js";
import {
  PHASE11_DEPLOYMENT_FINALITY_POLICY_VERSION,
  PHASE11_DEPLOYMENT_SEQUENCE,
  PHASE11_EXPECTED_TRANSACTION_COUNT,
  phase11ExpectedTransactionTarget,
  validateLegacyPhase11DeploymentJournal,
  Phase11DeploymentReconciliationError,
  type LegacyPhase11DeploymentJournal,
  type Phase11DeploymentActionId,
  type Phase11FinalizedInclusion,
  type Phase11SafeInclusion,
} from "./testnet-deployment-journal.js";
import {
  phase11FinalityExpectationFromProvenance,
  readPhase11CanonicalInclusion,
  type Phase11FinalityExpectation,
} from "./testnet-deployment-finality.js";
import {
  egressAutonomousAbi,
} from "../autonomy/contract.js";
import { protectionPolicyId } from "../authorization/protection-policy.js";
import {
  onchainProtectionPolicySchema,
  type OnchainProtectionPolicy,
} from "../autonomy/schemas.js";
import {
  XLAYER_TESTNET_CHAIN_ID,
  XLAYER_TESTNET_ENVIRONMENT_ID,
  XLAYER_TESTNET_PUBLIC_RPC,
} from "./testnet-deployment.js";

export const PHASE11_RECONCILIATION_SCHEMA_VERSION = 1 as const;
export const PHASE11_RECONCILIATION_ARTIFACT_TYPE = "EGRESS_PHASE11_DEPLOYMENT_RECONCILIATION" as const;
export const PHASE11_RECONCILIATION_FINALITY_POLICY = "FINALIZED" as const;
export const PHASE11_RECONCILIATION_SOFTWARE_VERSION = "phase11-reconciliation-v1" as const;
export const PHASE11_EXISTING_DEPLOYMENT_JOURNAL_SHA256 =
  "sha256:f1b7dc9a4d4b03f05a0850cd67f23166ceb3b616b5cf574b49ff6b749000fa8a" as const;

const canonicalInclusionSchema = z.object({
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

const initialUnsafeEvidenceSchema = z.object({
  receiptStatus: z.enum(["SUCCESS", "REVERTED"]),
  blockNumber: uintStringSchema,
  blockHash: hex32Schema,
  transactionIndex: uintStringSchema.nullable(),
  contractAddress: addressSchema.nullable(),
});

const reconciliationValidationSchema = z.object({
  transactionHash: z.literal(true),
  nonce: z.literal(true),
  sender: z.literal(true),
  target: z.literal(true),
  calldataHash: z.literal(true),
  receiptStatus: z.literal(true),
  createAddress: z.literal(true),
  safeCanonical: z.literal(true),
  finalizedCanonical: z.literal(true),
});

const reconciliationTransactionSchema = z.object({
  sequence: z.number().int().min(1).max(PHASE11_EXPECTED_TRANSACTION_COUNT),
  actionId: z.string().min(1),
  transactionHash: hex32Schema,
  nonce: uintStringSchema,
  from: addressSchema,
  to: addressSchema.nullable(),
  value: uintStringSchema,
  calldataHash: hex32Schema,
  initialInclusion: initialUnsafeEvidenceSchema,
  INITIAL_UNSAFE_BLOCK_NUMBER: uintStringSchema,
  INITIAL_UNSAFE_BLOCK_HASH: hex32Schema,
  INITIAL_UNSAFE_TRANSACTION_INDEX: uintStringSchema.nullable(),
  safeInclusion: canonicalInclusionSchema,
  SAFE_CANONICAL_BLOCK_NUMBER: uintStringSchema,
  SAFE_CANONICAL_BLOCK_HASH: hex32Schema,
  finalizedInclusion: canonicalInclusionSchema,
  FINALIZED_CANONICAL_BLOCK_NUMBER: uintStringSchema,
  FINALIZED_CANONICAL_BLOCK_HASH: hex32Schema,
  reIncluded: z.boolean(),
  canonicalInclusionStatus: z.literal("SAFE_AND_FINALIZED"),
  validation: reconciliationValidationSchema,
});

const runtimeVerificationSchema = z.object({
  status: z.literal("PASS"),
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
});

const reconciliationArtifactPayloadSchema = z.object({
  schemaVersion: z.literal(PHASE11_RECONCILIATION_SCHEMA_VERSION),
  artifactType: z.literal(PHASE11_RECONCILIATION_ARTIFACT_TYPE),
  deploymentId: hex32Schema,
  deployer: addressSchema,
  startingNonce: uintStringSchema,
  configurationHash: hex32Schema,
  originalJournalPath: z.string().min(1),
  originalJournalSha256: sha256Schema,
  reconciliationTimestamp: z.string().datetime(),
  verificationTimestamp: z.string().datetime(),
  chainId: z.literal(XLAYER_TESTNET_CHAIN_ID),
  environmentId: z.literal(XLAYER_TESTNET_ENVIRONMENT_ID),
  rpcEndpointIdentity: z.string().min(1),
  finalityPolicy: z.object({
    version: z.literal(PHASE11_DEPLOYMENT_FINALITY_POLICY_VERSION),
    publication: z.literal(PHASE11_RECONCILIATION_FINALITY_POLICY),
    safeTag: z.literal("safe"),
    finalizedTag: z.literal("finalized"),
  }),
  transactions: z.array(reconciliationTransactionSchema).length(PHASE11_EXPECTED_TRANSACTION_COUNT),
  deploymentAnchor: z.object({
    sequence: z.literal(PHASE11_EXPECTED_TRANSACTION_COUNT),
    transactionHash: hex32Schema,
    finalizedBlockNumber: uintStringSchema,
    finalizedBlockHash: hex32Schema,
  }),
  runtimeVerification: runtimeVerificationSchema,
  overallStatus: z.literal("PASS"),
  software: z.object({
    reconciler: z.literal(PHASE11_RECONCILIATION_SOFTWARE_VERSION),
    node: z.string().min(1),
  }),
});

export const phase11ReconciliationArtifactSchema = reconciliationArtifactPayloadSchema.extend({
  artifactHash: hex32Schema,
});

export type Phase11ReconciliationArtifact = z.infer<typeof phase11ReconciliationArtifactSchema>;
export type Phase11ReconciliationTransaction = z.infer<typeof reconciliationTransactionSchema>;
export type Phase11ReconciliationRuntimeVerification = z.infer<typeof runtimeVerificationSchema>;

interface Phase11AddressBook {
  egressContract: Address;
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
}

export interface Phase11ReconciliationInput {
  journalPath: string;
  rpcEndpoint: string;
  client: PublicClient;
  now?: () => Date;
  expectedJournalSha256?: `sha256:${string}`;
  approvedRpcEndpoints?: readonly string[];
  readCanonicalInclusion?: (
    client: PublicClient,
    input: { expectation: Phase11FinalityExpectation; stage: "SAFE_CANONICAL" | "FINALIZED_CANONICAL"; observedAt: string },
  ) => Promise<Phase11SafeInclusion | Phase11FinalizedInclusion>;
  verifyRuntime?: (
    client: PublicClient,
    journal: LegacyPhase11DeploymentJournal,
    transactions: readonly Phase11ReconciliationTransaction[],
  ) => Promise<Phase11ReconciliationRuntimeVerification>;
}

export async function reconcilePhase11Deployment(
  input: Phase11ReconciliationInput,
): Promise<Phase11ReconciliationArtifact> {
  const now = input.now ?? (() => new Date());
  const journalPath = resolve(input.journalPath);
  const initialBytes = await readFile(journalPath);
  const originalJournalSha256 = sha256Bytes(initialBytes);
  if (input.expectedJournalSha256 && originalJournalSha256 !== input.expectedJournalSha256) {
    throw new Phase11DeploymentReconciliationError(
      `Immutable Phase 11 journal SHA-256 mismatch: expected ${input.expectedJournalSha256}, received ${originalJournalSha256}.`,
    );
  }
  const journal = parseLegacyJournal(initialBytes, journalPath);
  assertCompleteLegacyJournal(journal);
  assertEndpointIdentity(input.rpcEndpoint, input.approvedRpcEndpoints ?? [XLAYER_TESTNET_PUBLIC_RPC]);

  const observedChainId = await input.client.getChainId();
  await assertJournalUnchanged(journalPath, originalJournalSha256);
  if (observedChainId !== XLAYER_TESTNET_CHAIN_ID || journal.chainId !== XLAYER_TESTNET_CHAIN_ID) {
    throw new Phase11DeploymentReconciliationError(
      `Phase 11 reconciliation requires chain ${XLAYER_TESTNET_CHAIN_ID}; observed ${observedChainId}.`,
    );
  }

  const readCanonical = input.readCanonicalInclusion ?? (async (
    client: PublicClient,
    args: {
      expectation: Phase11FinalityExpectation;
      stage: "SAFE_CANONICAL" | "FINALIZED_CANONICAL";
      observedAt: string;
    },
  ): Promise<Phase11SafeInclusion | Phase11FinalizedInclusion> => {
    if (args.stage === "SAFE_CANONICAL") {
      return readPhase11CanonicalInclusion(client, {
        expectation: args.expectation,
        stage: "SAFE_CANONICAL",
        observedAt: args.observedAt,
      });
    }
    return readPhase11CanonicalInclusion(client, {
      expectation: args.expectation,
      stage: "FINALIZED_CANONICAL",
      observedAt: args.observedAt,
    });
  });
  const transactions: Phase11ReconciliationTransaction[] = [];
  const observedAt = now().toISOString();

  for (const step of journal.steps) {
    await assertJournalUnchanged(journalPath, originalJournalSha256);
    if (!step.transactionHash || !step.from || step.nonce === null || step.value === null ||
        !step.calldataHash || step.blockNumber === null || !step.blockHash || step.receiptStatus !== "SUCCESS") {
      throw new Phase11DeploymentReconciliationError(
        `Phase 11 legacy journal step ${step.sequence} is incomplete for read-only reconciliation.`,
      );
    }
    const expectation = phase11FinalityExpectationFromProvenance({
      transactionHash: step.transactionHash,
      chainId: journal.chainId,
      sequence: step.sequence,
      from: step.from,
      nonce: step.nonce,
      to: step.to,
      value: step.value,
      calldataHash: step.calldataHash,
      contractAddress: step.contractAddress,
    });

    let safeInclusion: Phase11SafeInclusion;
    let finalizedInclusion: Phase11FinalizedInclusion;
    try {
      safeInclusion = await readCanonical(input.client, {
        expectation,
        stage: "SAFE_CANONICAL",
        observedAt,
      }) as Phase11SafeInclusion;
      await assertJournalUnchanged(journalPath, originalJournalSha256);
      finalizedInclusion = await readCanonical(input.client, {
        expectation,
        stage: "FINALIZED_CANONICAL",
        observedAt,
      }) as Phase11FinalizedInclusion;
    } catch (error) {
      await assertJournalUnchanged(journalPath, originalJournalSha256);
      throw new Phase11DeploymentReconciliationError(
        `Phase 11 step ${step.sequence} canonical ${errorMessage(error)}.`,
      );
    }
    await assertJournalUnchanged(journalPath, originalJournalSha256);

    if (!sameNullableAddress(step.contractAddress, safeInclusion.contractAddress) ||
        !sameNullableAddress(step.contractAddress, finalizedInclusion.contractAddress)) {
      throw new Phase11DeploymentReconciliationError(
        `Phase 11 step ${step.sequence} canonical CREATE address differs from immutable journal evidence.`,
      );
    }

    const reIncluded = step.blockNumber !== safeInclusion.blockNumber ||
      step.blockHash.toLowerCase() !== safeInclusion.blockHash.toLowerCase();
    transactions.push({
      sequence: step.sequence,
      actionId: step.actionId,
      transactionHash: step.transactionHash,
      nonce: step.nonce,
      from: step.from,
      to: step.to,
      value: step.value,
      calldataHash: step.calldataHash,
      initialInclusion: {
        receiptStatus: step.receiptStatus,
        blockNumber: step.blockNumber,
        blockHash: step.blockHash,
        transactionIndex: null,
        contractAddress: step.contractAddress,
      },
      INITIAL_UNSAFE_BLOCK_NUMBER: step.blockNumber,
      INITIAL_UNSAFE_BLOCK_HASH: step.blockHash,
      INITIAL_UNSAFE_TRANSACTION_INDEX: null,
      safeInclusion,
      SAFE_CANONICAL_BLOCK_NUMBER: safeInclusion.blockNumber,
      SAFE_CANONICAL_BLOCK_HASH: safeInclusion.blockHash,
      finalizedInclusion,
      FINALIZED_CANONICAL_BLOCK_NUMBER: finalizedInclusion.blockNumber,
      FINALIZED_CANONICAL_BLOCK_HASH: finalizedInclusion.blockHash,
      reIncluded,
      canonicalInclusionStatus: "SAFE_AND_FINALIZED",
      validation: {
        transactionHash: true,
        nonce: true,
        sender: true,
        target: true,
        calldataHash: true,
        receiptStatus: true,
        createAddress: true,
        safeCanonical: true,
        finalizedCanonical: true,
      },
    });
  }

  const runtimeVerification = input.verifyRuntime
    ? await input.verifyRuntime(input.client, journal, transactions)
    : await verifyPhase11ReconciledRuntime(input.client, journal, transactions);
  await assertJournalUnchanged(journalPath, originalJournalSha256);
  const finalTransaction = transactions[PHASE11_EXPECTED_TRANSACTION_COUNT - 1];
  if (!finalTransaction || finalTransaction.actionId !== "REGISTER_PROTECTION_POLICY") {
    throw new Phase11DeploymentReconciliationError("Phase 11 deployment anchor is not the policy-registration transaction.");
  }
  const payload = {
    schemaVersion: PHASE11_RECONCILIATION_SCHEMA_VERSION,
    artifactType: PHASE11_RECONCILIATION_ARTIFACT_TYPE,
    deploymentId: journal.deploymentId,
    deployer: journal.deployer,
    startingNonce: journal.startingNonce,
    configurationHash: journal.configurationHash,
    originalJournalPath: journalPath,
    originalJournalSha256,
    reconciliationTimestamp: observedAt,
    verificationTimestamp: now().toISOString(),
    chainId: journal.chainId,
    environmentId: journal.environmentId,
    rpcEndpointIdentity: endpointIdentity(input.rpcEndpoint),
    finalityPolicy: {
      version: PHASE11_DEPLOYMENT_FINALITY_POLICY_VERSION,
      publication: PHASE11_RECONCILIATION_FINALITY_POLICY,
      safeTag: "safe" as const,
      finalizedTag: "finalized" as const,
    },
    transactions,
    deploymentAnchor: {
      sequence: PHASE11_EXPECTED_TRANSACTION_COUNT,
      transactionHash: finalTransaction.transactionHash as Hex,
      finalizedBlockNumber: finalTransaction.FINALIZED_CANONICAL_BLOCK_NUMBER,
      finalizedBlockHash: finalTransaction.FINALIZED_CANONICAL_BLOCK_HASH,
    },
    runtimeVerification,
    overallStatus: "PASS" as const,
    software: {
      reconciler: PHASE11_RECONCILIATION_SOFTWARE_VERSION,
      node: process.version,
    },
  };
  const artifact = phase11ReconciliationArtifactSchema.parse({
    ...payload,
    artifactHash: objectHash(payload),
  }) as Phase11ReconciliationArtifact;
  await assertJournalUnchanged(journalPath, originalJournalSha256);
  return artifact;
}

export function verifyPhase11ReconciliationArtifact(value: unknown): Phase11ReconciliationArtifact {
  const artifact = phase11ReconciliationArtifactSchema.parse(value) as Phase11ReconciliationArtifact;
  const { artifactHash: _artifactHash, ...payload } = artifact;
  if (objectHash(payload).toLowerCase() !== artifact.artifactHash.toLowerCase()) {
    throw new Phase11DeploymentReconciliationError("Phase 11 reconciliation artifact integrity verification failed.");
  }
  assertReconciliationArtifactSemantics(artifact);
  return artifact;
}

export async function persistPhase11ReconciliationArtifact(
  path: string,
  artifact: Phase11ReconciliationArtifact,
): Promise<void> {
  const resolvedPath = resolve(path);
  if (resolvedPath === resolve(artifact.originalJournalPath)) {
    throw new Phase11DeploymentReconciliationError("Reconciliation artifact path must be distinct from the immutable journal path.");
  }
  const validated = verifyPhase11ReconciliationArtifact(artifact);
  await assertJournalUnchanged(
    validated.originalJournalPath,
    validated.originalJournalSha256 as `sha256:${string}`,
  );
  await atomicWriteExclusiveJson(resolvedPath, validated);
  await assertJournalUnchanged(
    validated.originalJournalPath,
    validated.originalJournalSha256 as `sha256:${string}`,
  );
}

async function verifyPhase11ReconciledRuntime(
  client: PublicClient,
  journal: LegacyPhase11DeploymentJournal,
  transactions: readonly Phase11ReconciliationTransaction[],
): Promise<Phase11ReconciliationRuntimeVerification> {
  const addresses = addressBook(journal, transactions);
  const codeAddresses = Object.entries(addresses) as Array<[string, Address]>;
  await Promise.all(codeAddresses.map(async ([role, address]) => {
    const code = await client.getBytecode({ address });
    if (!code || code === "0x") throw new Phase11DeploymentReconciliationError(`Missing runtime bytecode for ${role}.`);
  }));

  const protocol: ExecutionProtocolIdentity = {
    addressesProvider: addresses.addressesProvider as Address,
    aavePool: addresses.aavePool as Address,
    aaveOracle: addresses.aaveOracle as Address,
    xbEth: addresses.xbEth as Address,
    xeth: addresses.xeth as Address,
    aXbEth: addresses.aXbEth as Address,
    variableDebtXeth: addresses.variableDebtXeth as Address,
    uniswapFactory: addresses.uniswapFactory as Address,
    swapRouter: addresses.swapRouter as Address,
    quoterV2: addresses.quoterV2 as Address,
    swapPool: addresses.swapPool as Address,
    poolFee: 100,
  };
  const protocolConfigHash = executionProtocolConfigHash(protocol);
  const [egressValues, relationships, metadata] = await Promise.all([
    readEgressIdentity(client, addresses.egressContract),
    readProtocolRelationships(client, protocol),
    readTokenMetadata(client, protocol),
  ]);
  if (!sameAddress(egressValues.aavePool, protocol.aavePool) ||
      !sameAddress(egressValues.aXbEth, protocol.aXbEth) ||
      !sameAddress(egressValues.swapRouter, protocol.swapRouter) ||
      !sameAddress(egressValues.provider, protocol.addressesProvider) ||
      !sameAddress(egressValues.oracle, protocol.aaveOracle) ||
      !sameAddress(egressValues.xeth, protocol.xeth) ||
      !sameAddress(egressValues.xbEth, protocol.xbEth) ||
      !sameAddress(egressValues.debtToken, protocol.variableDebtXeth) ||
      !sameAddress(egressValues.factory, protocol.uniswapFactory) ||
      !sameAddress(egressValues.swapPool, protocol.swapPool) ||
      !sameAddress(egressValues.guardian, journal.deployer) ||
      Number(egressValues.poolFee) !== protocol.poolFee ||
      String(egressValues.protocolConfigHash).toLowerCase() !== protocolConfigHash.toLowerCase() ||
      egressValues.paused) {
    throw new Phase11DeploymentReconciliationError("Egress immutable or paused state is inconsistent with the deployment sequence.");
  }

  const finalTransaction = transactions[PHASE11_EXPECTED_TRANSACTION_COUNT - 1]!;
  const policyTransaction = await client.getTransaction({ hash: finalTransaction.transactionHash as Hex });
  const decoded = decodeFunctionData({ abi: egressAutonomousAbi, data: policyTransaction.input });
  if (decoded.functionName !== "registerProtectionPolicy") {
    throw new Phase11DeploymentReconciliationError("Deployment anchor calldata is not policy registration.");
  }
  const policy = normalizeDecodedPolicy((decoded.args as readonly unknown[])[0]);
  if (policy.protocolConfigHash.toLowerCase() !== protocolConfigHash.toLowerCase()) {
    throw new Phase11DeploymentReconciliationError("Registered policy protocol configuration hash is inconsistent.");
  }
  const policyId = protectionPolicyId({
    chainId: XLAYER_TESTNET_CHAIN_ID,
    egressContract: addresses.egressContract as Address,
    policy,
  });
  const state = await client.readContract({
    address: addresses.egressContract as Address,
    abi: egressIdentityAbi,
    functionName: "policyStates",
    args: [policyId],
  }) as readonly [Address, boolean, bigint, bigint, bigint, bigint, bigint, bigint];
  if (!sameAddress(state[0], policy.user) || !state[1] || state[6] <= 0n || state[7] <= 0n) {
    throw new Phase11DeploymentReconciliationError("Registered policy state is missing, inactive, or has no seeded borrower position.");
  }
  return {
    status: "PASS",
    contractAddresses: Object.fromEntries(Object.entries(addresses)) as Record<string, Address>,
    protocolConfigHash,
    policyId,
    borrower: policy.user,
    keeper: policy.keeper,
    riskAttestor: policy.riskAttestor,
    policyActive: true,
    protocolRelationshipsVerified: relationships,
    tokenMetadataVerified: metadata,
    oracleStateVerified: true,
  };
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
  "function policyStates(bytes32) view returns (address,bool,uint256,uint256,uint256,uint256,uint256,uint256)",
]);

const protocolIdentityAbi = parseAbi([
  "function ADDRESSES_PROVIDER() view returns (address)",
  "function getPool() view returns (address)",
  "function getPriceOracle() view returns (address)",
  "function POOL() view returns (address)",
  "function UNDERLYING_ASSET_ADDRESS() view returns (address)",
  "function factory() view returns (address)",
  "function token0() view returns (address)",
  "function token1() view returns (address)",
  "function fee() view returns (uint24)",
  "function getPool(address,address,uint24) view returns (address)",
  "function getAssetPrice(address) view returns (uint256)",
  "function getSourceOfAsset(address) view returns (address)",
  "function FLASHLOAN_PREMIUM_TOTAL() view returns (uint128)",
]);

const tokenIdentityAbi = parseAbi([
  "function name() view returns (string)",
  "function symbol() view returns (string)",
  "function decimals() view returns (uint8)",
]);

async function readEgressIdentity(client: PublicClient, address: Address) {
  const values = await Promise.all([
    client.readContract({ address, abi: egressIdentityAbi, functionName: "AAVE_POOL" }),
    client.readContract({ address, abi: egressIdentityAbi, functionName: "A_XBETH" }),
    client.readContract({ address, abi: egressIdentityAbi, functionName: "SWAP_ROUTER" }),
    client.readContract({ address, abi: egressIdentityAbi, functionName: "POOL_ADDRESSES_PROVIDER" }),
    client.readContract({ address, abi: egressIdentityAbi, functionName: "AAVE_ORACLE" }),
    client.readContract({ address, abi: egressIdentityAbi, functionName: "XETH" }),
    client.readContract({ address, abi: egressIdentityAbi, functionName: "XBETH" }),
    client.readContract({ address, abi: egressIdentityAbi, functionName: "VARIABLE_DEBT_XETH" }),
    client.readContract({ address, abi: egressIdentityAbi, functionName: "UNISWAP_FACTORY" }),
    client.readContract({ address, abi: egressIdentityAbi, functionName: "SWAP_POOL" }),
    client.readContract({ address, abi: egressIdentityAbi, functionName: "GUARDIAN" }),
    client.readContract({ address, abi: egressIdentityAbi, functionName: "POOL_FEE" }),
    client.readContract({ address, abi: egressIdentityAbi, functionName: "PROTOCOL_CONFIG_HASH" }),
    client.readContract({ address, abi: egressIdentityAbi, functionName: "paused" }),
  ]);
  return {
    aavePool: values[0] as Address,
    aXbEth: values[1] as Address,
    swapRouter: values[2] as Address,
    provider: values[3] as Address,
    oracle: values[4] as Address,
    xeth: values[5] as Address,
    xbEth: values[6] as Address,
    debtToken: values[7] as Address,
    factory: values[8] as Address,
    swapPool: values[9] as Address,
    guardian: values[10] as Address,
    poolFee: Number(values[11]),
    protocolConfigHash: values[12] as Hex,
    paused: values[13] as boolean,
  };
}

async function readProtocolRelationships(client: PublicClient, protocol: ExecutionProtocolIdentity): Promise<true> {
  const values = await Promise.all([
    client.readContract({ address: protocol.aavePool as Address, abi: protocolIdentityAbi, functionName: "ADDRESSES_PROVIDER" }),
    client.readContract({ address: protocol.addressesProvider as Address, abi: protocolIdentityAbi, functionName: "getPool" }),
    client.readContract({ address: protocol.addressesProvider as Address, abi: protocolIdentityAbi, functionName: "getPriceOracle" }),
    client.readContract({ address: protocol.aXbEth as Address, abi: protocolIdentityAbi, functionName: "POOL" }),
    client.readContract({ address: protocol.aXbEth as Address, abi: protocolIdentityAbi, functionName: "UNDERLYING_ASSET_ADDRESS" }),
    client.readContract({ address: protocol.variableDebtXeth as Address, abi: protocolIdentityAbi, functionName: "POOL" }),
    client.readContract({ address: protocol.variableDebtXeth as Address, abi: protocolIdentityAbi, functionName: "UNDERLYING_ASSET_ADDRESS" }),
    client.readContract({ address: protocol.swapRouter as Address, abi: protocolIdentityAbi, functionName: "factory" }),
    client.readContract({ address: protocol.quoterV2 as Address, abi: protocolIdentityAbi, functionName: "factory" }),
    client.readContract({ address: protocol.swapPool as Address, abi: protocolIdentityAbi, functionName: "factory" }),
    client.readContract({ address: protocol.swapPool as Address, abi: protocolIdentityAbi, functionName: "token0" }),
    client.readContract({ address: protocol.swapPool as Address, abi: protocolIdentityAbi, functionName: "token1" }),
    client.readContract({ address: protocol.swapPool as Address, abi: protocolIdentityAbi, functionName: "fee" }),
    client.readContract({ address: protocol.uniswapFactory as Address, abi: protocolIdentityAbi, functionName: "getPool", args: [protocol.xbEth as Address, protocol.xeth as Address, protocol.poolFee] }),
    client.readContract({ address: protocol.aaveOracle as Address, abi: protocolIdentityAbi, functionName: "getAssetPrice", args: [protocol.xbEth as Address] }),
    client.readContract({ address: protocol.aaveOracle as Address, abi: protocolIdentityAbi, functionName: "getAssetPrice", args: [protocol.xeth as Address] }),
    client.readContract({ address: protocol.aaveOracle as Address, abi: protocolIdentityAbi, functionName: "getSourceOfAsset", args: [protocol.xbEth as Address] }),
    client.readContract({ address: protocol.aaveOracle as Address, abi: protocolIdentityAbi, functionName: "getSourceOfAsset", args: [protocol.xeth as Address] }),
    client.readContract({ address: protocol.aavePool as Address, abi: protocolIdentityAbi, functionName: "FLASHLOAN_PREMIUM_TOTAL" }),
  ]);
  const addressChecks: Array<[unknown, Address]> = [
    [values[0], protocol.addressesProvider as Address],
    [values[1], protocol.aavePool as Address],
    [values[2], protocol.aaveOracle as Address],
    [values[3], protocol.aavePool as Address],
    [values[4], protocol.xbEth as Address],
    [values[5], protocol.aavePool as Address],
    [values[6], protocol.xeth as Address],
    [values[7], protocol.uniswapFactory as Address],
    [values[8], protocol.uniswapFactory as Address],
    [values[9], protocol.uniswapFactory as Address],
    [values[10], protocol.xbEth as Address],
    [values[11], protocol.xeth as Address],
    [values[13], protocol.swapPool as Address],
    [values[16], protocol.aaveOracle as Address],
    [values[17], protocol.aaveOracle as Address],
  ];
  if (addressChecks.some(([actual, expected]) => !sameAddress(actual as Address, expected)) ||
      Number(values[12]) !== protocol.poolFee ||
      (values[14] as bigint) <= 0n ||
      (values[15] as bigint) <= 0n ||
      BigInt(values[18] as bigint) !== 5n) {
    throw new Phase11DeploymentReconciliationError("Deployed protocol relationships or oracle state are inconsistent.");
  }
  return true;
}

async function readTokenMetadata(client: PublicClient, protocol: ExecutionProtocolIdentity): Promise<true> {
  const expected = [
    [protocol.xbEth, "Egress Testnet xBETH", "txBETH"],
    [protocol.xeth, "Egress Testnet xETH", "txETH"],
    [protocol.aXbEth, "Egress Testnet Aave xBETH", "atxBETH"],
    [protocol.variableDebtXeth, "Egress Testnet Variable Debt xETH", "variableDebtTxETH"],
  ] as const;
  for (const [address, nameExpected, symbolExpected] of expected) {
    const [name, symbol, decimals] = await Promise.all([
      client.readContract({ address: address as Address, abi: tokenIdentityAbi, functionName: "name" }),
      client.readContract({ address: address as Address, abi: tokenIdentityAbi, functionName: "symbol" }),
      client.readContract({ address: address as Address, abi: tokenIdentityAbi, functionName: "decimals" }),
    ]);
    if (name !== nameExpected || symbol !== symbolExpected || Number(decimals) !== 18) {
      throw new Phase11DeploymentReconciliationError(`Token metadata mismatch at ${address}.`);
    }
  }
  return true;
}

function addressBook(
  journal: LegacyPhase11DeploymentJournal,
  transactions: readonly Phase11ReconciliationTransaction[],
): Phase11AddressBook {
  const map = new Map(transactions.map((transaction) => [transaction.actionId, transaction]));
  const deploymentAddress = (actionId: string): Address => {
    const transaction = map.get(actionId);
    if (!transaction || !transaction.initialInclusion.contractAddress) {
      throw new Phase11DeploymentReconciliationError(`Missing deployed address for ${actionId}.`);
    }
    const expected = getContractAddress({ from: journal.deployer, nonce: BigInt(transaction.nonce) });
    if (!sameAddress(transaction.initialInclusion.contractAddress, expected)) {
      throw new Phase11DeploymentReconciliationError(`CREATE address mismatch for ${actionId}.`);
    }
    return getAddress(transaction.initialInclusion.contractAddress);
  };
  return {
    egressContract: deploymentAddress("DEPLOY_EGRESS_EXECUTOR"),
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
  };
}

function normalizeDecodedPolicy(value: unknown): OnchainProtectionPolicy {
  if (!value || typeof value !== "object") throw new Phase11DeploymentReconciliationError("Policy registration calldata has no policy tuple.");
  const record = value as Record<string, unknown>;
  const numericKeys = [
    "maxRepaymentPerExecution", "maxCollateralPerExecution", "maxCumulativeRepayment",
    "maxCumulativeCollateral", "maxCollateralPercentageBps", "maxPositionDebt", "maxSlippageBps",
    "maxOracleDeviationBps", "maxFlashLoanPremiumBps", "maxPreHealthFactor", "minPostHealthFactor",
    "cooldownSeconds", "maxExecutions", "maxRiskAgeSeconds", "maxClockSkewSeconds", "expiresAt",
    "nonce", "revocationNonce",
  ];
  return onchainProtectionPolicySchema.parse({
    user: getAddress(String(record.user)),
    keeper: getAddress(String(record.keeper)),
    riskAttestor: getAddress(String(record.riskAttestor)),
    protocolConfigHash: String(record.protocolConfigHash) as Hex,
    minimumRiskLevel: Number(record.minimumRiskLevel),
    ...Object.fromEntries(numericKeys.map((key) => [key, String(record[key])])),
  }) as OnchainProtectionPolicy;
}

function parseLegacyJournal(bytes: Buffer, path: string): LegacyPhase11DeploymentJournal {
  try {
    return validateLegacyPhase11DeploymentJournal(JSON.parse(bytes.toString("utf8")));
  } catch (error) {
    throw new Phase11DeploymentReconciliationError(`Immutable Phase 11 journal at ${path} is invalid: ${errorMessage(error)}.`);
  }
}

function assertCompleteLegacyJournal(journal: LegacyPhase11DeploymentJournal): void {
  if (journal.status !== "COMPLETE" || journal.steps.length !== PHASE11_EXPECTED_TRANSACTION_COUNT) {
    throw new Phase11DeploymentReconciliationError("Only a complete 26-step legacy Phase 11 journal can be reconciled.");
  }
  const hashes = new Set<string>();
  for (const [index, step] of journal.steps.entries()) {
    const expected = PHASE11_DEPLOYMENT_SEQUENCE[index]!;
    if (step.sequence !== expected.sequence || step.actionId !== expected.actionId || step.status !== "CONFIRMED") {
      throw new Phase11DeploymentReconciliationError(`Legacy journal sequence is invalid at step ${index + 1}.`);
    }
    if (!step.transactionHash || hashes.has(step.transactionHash.toLowerCase())) {
      throw new Phase11DeploymentReconciliationError("Legacy journal transaction hashes are missing or duplicated.");
    }
    hashes.add(step.transactionHash.toLowerCase());
    const expectedNonce = BigInt(journal.startingNonce) + BigInt(index);
    if (!step.from || step.from.toLowerCase() !== journal.deployer.toLowerCase() ||
        step.nonce === null || BigInt(step.nonce) !== expectedNonce || step.value !== "0" ||
        !step.calldataHash || step.blockNumber === null || !step.blockHash ||
        step.receiptStatus !== "SUCCESS") {
      throw new Phase11DeploymentReconciliationError(`Legacy journal provenance is invalid at step ${index + 1}.`);
    }
    const expectedTarget = phase11ExpectedTransactionTarget({
      deployer: journal.deployer,
      startingNonce: journal.startingNonce,
      actionId: step.actionId,
    });
    if (!sameNullableAddress(step.to, expectedTarget)) {
      throw new Phase11DeploymentReconciliationError(`Legacy journal target is invalid at step ${index + 1}.`);
    }
  }
}

async function assertJournalUnchanged(path: string, expectedHash: `sha256:${string}`): Promise<void> {
  const currentHash = sha256Bytes(await readFile(path));
  if (currentHash !== expectedHash) {
    throw new Phase11DeploymentReconciliationError("The immutable Phase 11 journal changed during reconciliation.");
  }
}

function sha256Bytes(value: Uint8Array): `sha256:${string}` {
  return `sha256:${createHash("sha256").update(value).digest("hex")}`;
}

function assertReconciliationArtifactSemantics(artifact: Phase11ReconciliationArtifact): void {
  if (
    artifact.chainId !== XLAYER_TESTNET_CHAIN_ID ||
    artifact.environmentId !== XLAYER_TESTNET_ENVIRONMENT_ID ||
    artifact.transactions.length !== PHASE11_EXPECTED_TRANSACTION_COUNT
  ) {
    throw new Phase11DeploymentReconciliationError("Phase 11 reconciliation artifact identity or transaction count is invalid.");
  }
  const hashes = new Set<string>();
  let previousSafeBlock = 0n;
  let previousFinalizedBlock = 0n;
  for (const [index, transaction] of artifact.transactions.entries()) {
    const expected = PHASE11_DEPLOYMENT_SEQUENCE[index]!;
    if (
      transaction.sequence !== expected.sequence ||
      transaction.actionId !== expected.actionId ||
      hashes.has(transaction.transactionHash.toLowerCase()) ||
      BigInt(transaction.nonce) !== BigInt(artifact.startingNonce) + BigInt(index) ||
      transaction.from.toLowerCase() !== artifact.deployer.toLowerCase() ||
      !sameNullableAddress(
        transaction.to,
        phase11ExpectedTransactionTarget({
          deployer: artifact.deployer as Address,
          startingNonce: artifact.startingNonce,
          actionId: transaction.actionId as Phase11DeploymentActionId,
        }),
      )
    ) {
      throw new Phase11DeploymentReconciliationError(`Phase 11 reconciliation artifact transaction identity is invalid at step ${index + 1}.`);
    }
    hashes.add(transaction.transactionHash.toLowerCase());
    if (
      transaction.initialInclusion.receiptStatus !== "SUCCESS" ||
      transaction.safeInclusion.stage !== "SAFE_CANONICAL" ||
      transaction.finalizedInclusion.stage !== "FINALIZED_CANONICAL" ||
      BigInt(transaction.safeInclusion.finalityHeadBlockNumber) < BigInt(transaction.safeInclusion.blockNumber) ||
      BigInt(transaction.finalizedInclusion.finalityHeadBlockNumber) < BigInt(transaction.finalizedInclusion.blockNumber) ||
      BigInt(transaction.safeInclusion.blockNumber) < previousSafeBlock ||
      BigInt(transaction.finalizedInclusion.blockNumber) < previousFinalizedBlock ||
      transaction.initialInclusion.blockNumber !== transaction.INITIAL_UNSAFE_BLOCK_NUMBER ||
      transaction.initialInclusion.blockHash.toLowerCase() !== transaction.INITIAL_UNSAFE_BLOCK_HASH.toLowerCase() ||
      transaction.safeInclusion.blockNumber !== transaction.SAFE_CANONICAL_BLOCK_NUMBER ||
      transaction.safeInclusion.blockHash.toLowerCase() !== transaction.SAFE_CANONICAL_BLOCK_HASH.toLowerCase() ||
      transaction.finalizedInclusion.blockNumber !== transaction.FINALIZED_CANONICAL_BLOCK_NUMBER ||
      transaction.finalizedInclusion.blockHash.toLowerCase() !== transaction.FINALIZED_CANONICAL_BLOCK_HASH.toLowerCase() ||
      transaction.reIncluded !== (
        transaction.initialInclusion.blockNumber !== transaction.safeInclusion.blockNumber ||
        transaction.initialInclusion.blockHash.toLowerCase() !== transaction.safeInclusion.blockHash.toLowerCase()
      ) ||
      !sameNullableAddress(transaction.initialInclusion.contractAddress, transaction.safeInclusion.contractAddress) ||
      !sameNullableAddress(transaction.safeInclusion.contractAddress, transaction.finalizedInclusion.contractAddress)
    ) {
      throw new Phase11DeploymentReconciliationError(`Phase 11 reconciliation finality evidence is invalid at step ${index + 1}.`);
    }
    if (expected.kind === "DEPLOYMENT") {
      const expectedAddress = getContractAddress({
        from: artifact.deployer as Address,
        nonce: BigInt(transaction.nonce),
      });
      if (!sameNullableAddress(transaction.finalizedInclusion.contractAddress, expectedAddress)) {
        throw new Phase11DeploymentReconciliationError(`Phase 11 reconciliation CREATE address is invalid at step ${index + 1}.`);
      }
    } else if (transaction.finalizedInclusion.contractAddress !== null) {
      throw new Phase11DeploymentReconciliationError(`Phase 11 reconciliation call step ${index + 1} unexpectedly created a contract.`);
    }
    previousSafeBlock = BigInt(transaction.safeInclusion.blockNumber);
    previousFinalizedBlock = BigInt(transaction.finalizedInclusion.blockNumber);
  }
  const anchor = artifact.transactions[PHASE11_EXPECTED_TRANSACTION_COUNT - 1]!;
  if (
    anchor.actionId !== "REGISTER_PROTECTION_POLICY" ||
    artifact.deploymentAnchor.sequence !== PHASE11_EXPECTED_TRANSACTION_COUNT ||
    artifact.deploymentAnchor.transactionHash.toLowerCase() !== anchor.transactionHash.toLowerCase() ||
    artifact.deploymentAnchor.finalizedBlockNumber !== anchor.FINALIZED_CANONICAL_BLOCK_NUMBER ||
    artifact.deploymentAnchor.finalizedBlockHash.toLowerCase() !== anchor.FINALIZED_CANONICAL_BLOCK_HASH.toLowerCase()
  ) {
    throw new Phase11DeploymentReconciliationError("Phase 11 reconciliation deployment anchor is invalid.");
  }
}

function endpointIdentity(value: string): string {
  const url = new URL(value);
  return `${url.protocol}//${url.host}${url.pathname}`;
}

function assertEndpointIdentity(value: string, approvedEndpoints: readonly string[]): void {
  const url = new URL(value);
  if (url.protocol !== "https:" || url.username || url.password ||
      ["localhost", "127.0.0.1", "::1"].includes(url.hostname)) {
    throw new Phase11DeploymentReconciliationError("Phase 11 reconciliation requires a credential-free HTTPS public RPC endpoint.");
  }
  const identity = endpointIdentity(value);
  const approved = approvedEndpoints.map(endpointIdentity);
  if (!approved.includes(identity)) {
    throw new Phase11DeploymentReconciliationError("Phase 11 reconciliation RPC is not an approved X Layer testnet endpoint.");
  }
}

async function atomicWriteExclusiveJson(path: string, value: unknown): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const temporaryPath = `${path}.${process.pid}.${randomUUID()}.tmp`;
  let handle: Awaited<ReturnType<typeof open>> | null = null;
  try {
    handle = await open(temporaryPath, "wx", 0o600);
    await handle.writeFile(`${JSON.stringify(value, null, 2)}\n`, "utf8");
    await handle.sync();
    await handle.close();
    handle = null;
    await link(temporaryPath, path);
    await unlink(temporaryPath);
    await syncParentDirectory(path);
  } catch (error) {
    if (handle) await handle.close().catch(() => undefined);
    await unlink(temporaryPath).catch(() => undefined);
    if (errorCode(error) === "EEXIST") {
      throw new Phase11DeploymentReconciliationError(`Refusing to overwrite existing reconciliation artifact ${path}.`);
    }
    throw error;
  }
}

async function syncParentDirectory(path: string): Promise<void> {
  let handle: Awaited<ReturnType<typeof open>> | null = null;
  try {
    handle = await open(dirname(path), "r");
    await handle.sync();
  } catch (error) {
    if (!["EINVAL", "ENOTSUP", "EBADF", "EISDIR", "EPERM"].includes(errorCode(error) ?? "")) throw error;
  } finally {
    await handle?.close().catch(() => undefined);
  }
}

function sameAddress(left: Address | string | null | undefined, right: Address | string): boolean {
  return Boolean(left) && String(left).toLowerCase() === String(right).toLowerCase();
}

function sameNullableAddress(left: string | null, right: string | null): boolean {
  if (left === null || right === null) return left === right;
  return left.toLowerCase() === right.toLowerCase();
}

function errorCode(error: unknown): string | null {
  return typeof error === "object" && error !== null && "code" in error
    ? String((error as { code?: unknown }).code ?? "")
    : null;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message.split("\n")[0] ?? error.name : String(error);
}
