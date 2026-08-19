import { randomUUID } from "node:crypto";
import {
  access,
  link,
  mkdir,
  open,
  readFile,
  rename,
  unlink,
} from "node:fs/promises";
import { dirname, resolve } from "node:path";
import {
  getAddress,
  getContractAddress,
  keccak256,
  type Address,
  type Hex,
} from "viem";
import { z } from "zod";
import { objectHash } from "../domain/hash.js";
import { addressSchema, hex32Schema, uintStringSchema } from "../domain/schemas.js";

export const PHASE11_EXPECTED_TRANSACTION_COUNT = 26;
export const PHASE11_LEGACY_DEPLOYMENT_JOURNAL_SCHEMA_VERSION = 2 as const;
export const PHASE11_DEPLOYMENT_JOURNAL_SCHEMA_VERSION = 3 as const;
export const PHASE11_DEPLOYMENT_FINALITY_POLICY_VERSION = 1 as const;
export const PHASE11_DEPLOYMENT_FINALITY_POLICY = "FINALIZED" as const;

export const PHASE11_DEPLOYMENT_SEQUENCE = [
  { sequence: 1, actionId: "DEPLOY_XBETH", label: "Deploy xBETH token", kind: "DEPLOYMENT" },
  { sequence: 2, actionId: "DEPLOY_XETH", label: "Deploy xETH token", kind: "DEPLOYMENT" },
  { sequence: 3, actionId: "DEPLOY_ADDRESSES_PROVIDER", label: "Deploy addresses provider", kind: "DEPLOYMENT" },
  { sequence: 4, actionId: "DEPLOY_ORACLE", label: "Deploy oracle", kind: "DEPLOYMENT" },
  { sequence: 5, actionId: "DEPLOY_AAVE_POOL", label: "Deploy Aave-compatible pool", kind: "DEPLOYMENT" },
  { sequence: 6, actionId: "DEPLOY_ATOKEN", label: "Deploy aToken", kind: "DEPLOYMENT" },
  { sequence: 7, actionId: "DEPLOY_VARIABLE_DEBT_TOKEN", label: "Deploy variable-debt token", kind: "DEPLOYMENT" },
  { sequence: 8, actionId: "CONFIGURE_PROVIDER", label: "Configure provider", kind: "CALL" },
  { sequence: 9, actionId: "CONFIGURE_POOL_RESERVES", label: "Configure pool reserves", kind: "CALL" },
  { sequence: 10, actionId: "ENABLE_XBETH_MINTER", label: "Enable pool as xBETH minter", kind: "CALL" },
  { sequence: 11, actionId: "ENABLE_XETH_MINTER", label: "Enable pool as xETH minter", kind: "CALL" },
  { sequence: 12, actionId: "ENABLE_ATOKEN_MINTER", label: "Enable pool as aToken minter", kind: "CALL" },
  { sequence: 13, actionId: "ENABLE_DEBT_TOKEN_MINTER", label: "Enable pool as debt-token minter", kind: "CALL" },
  { sequence: 14, actionId: "SET_XBETH_ORACLE_PRICE", label: "Set xBETH oracle price", kind: "CALL" },
  { sequence: 15, actionId: "SET_XETH_ORACLE_PRICE", label: "Set xETH oracle price", kind: "CALL" },
  { sequence: 16, actionId: "DEPLOY_SWAP_FACTORY", label: "Deploy swap factory", kind: "DEPLOYMENT" },
  { sequence: 17, actionId: "DEPLOY_SWAP_ROUTER", label: "Deploy swap router", kind: "DEPLOYMENT" },
  { sequence: 18, actionId: "DEPLOY_QUOTER", label: "Deploy quoter", kind: "DEPLOYMENT" },
  { sequence: 19, actionId: "DEPLOY_SWAP_POOL", label: "Deploy swap pool", kind: "DEPLOYMENT" },
  { sequence: 20, actionId: "CONFIGURE_SWAP_FACTORY", label: "Configure swap factory", kind: "CALL" },
  { sequence: 21, actionId: "MINT_XBETH_SWAP_LIQUIDITY", label: "Mint xBETH swap liquidity", kind: "CALL" },
  { sequence: 22, actionId: "MINT_XETH_SWAP_LIQUIDITY", label: "Mint xETH swap liquidity", kind: "CALL" },
  { sequence: 23, actionId: "SEED_BORROWER_POSITION", label: "Seed borrower position", kind: "CALL" },
  { sequence: 24, actionId: "SEED_FLASH_LIQUIDITY", label: "Seed flash-loan liquidity", kind: "CALL" },
  { sequence: 25, actionId: "DEPLOY_EGRESS_EXECUTOR", label: "Deploy EgressExecutor", kind: "DEPLOYMENT" },
  { sequence: 26, actionId: "REGISTER_PROTECTION_POLICY", label: "Register protection policy", kind: "CALL" },
] as const;

export type Phase11DeploymentSequenceEntry = typeof PHASE11_DEPLOYMENT_SEQUENCE[number];
export type Phase11DeploymentActionId = Phase11DeploymentSequenceEntry["actionId"];
export type Phase11DeploymentStepKind = Phase11DeploymentSequenceEntry["kind"];

const inclusionStageSchema = z.enum(["INITIAL_UNSAFE", "SAFE_CANONICAL", "FINALIZED_CANONICAL"]);
const receiptStatusSchema = z.enum(["SUCCESS", "REVERTED"]);

const initialInclusionSchema = z.object({
  stage: z.literal("INITIAL_UNSAFE"),
  receiptStatus: receiptStatusSchema,
  blockNumber: uintStringSchema,
  blockHash: hex32Schema,
  transactionIndex: uintStringSchema,
  contractAddress: addressSchema.nullable(),
  observedAt: z.string().datetime(),
});

const canonicalInclusionSchema = z.object({
  stage: inclusionStageSchema.extract(["SAFE_CANONICAL", "FINALIZED_CANONICAL"]),
  receiptStatus: z.literal("SUCCESS"),
  blockNumber: uintStringSchema,
  blockHash: hex32Schema,
  transactionIndex: uintStringSchema,
  contractAddress: addressSchema.nullable(),
  finalityHeadBlockNumber: uintStringSchema,
  finalityHeadBlockHash: hex32Schema,
  observedAt: z.string().datetime(),
});

const safeCanonicalInclusionSchema = canonicalInclusionSchema.extend({
  stage: z.literal("SAFE_CANONICAL"),
});

const finalizedCanonicalInclusionSchema = canonicalInclusionSchema.extend({
  stage: z.literal("FINALIZED_CANONICAL"),
});

export type Phase11InitialInclusion = z.infer<typeof initialInclusionSchema> & {
  blockHash: Hex;
  contractAddress: Address | null;
};

export type Phase11CanonicalInclusion = z.infer<typeof canonicalInclusionSchema> & {
  blockHash: Hex;
  contractAddress: Address | null;
  finalityHeadBlockHash: Hex;
};

export type Phase11SafeInclusion = Phase11CanonicalInclusion & { stage: "SAFE_CANONICAL" };
export type Phase11FinalizedInclusion = Phase11CanonicalInclusion & { stage: "FINALIZED_CANONICAL" };

const PHASE11_CALL_TARGET_DEPLOYMENT: Readonly<Partial<Record<
  Phase11DeploymentActionId,
  Phase11DeploymentActionId
>>> = {
  CONFIGURE_PROVIDER: "DEPLOY_ADDRESSES_PROVIDER",
  CONFIGURE_POOL_RESERVES: "DEPLOY_AAVE_POOL",
  ENABLE_XBETH_MINTER: "DEPLOY_XBETH",
  ENABLE_XETH_MINTER: "DEPLOY_XETH",
  ENABLE_ATOKEN_MINTER: "DEPLOY_ATOKEN",
  ENABLE_DEBT_TOKEN_MINTER: "DEPLOY_VARIABLE_DEBT_TOKEN",
  SET_XBETH_ORACLE_PRICE: "DEPLOY_ORACLE",
  SET_XETH_ORACLE_PRICE: "DEPLOY_ORACLE",
  CONFIGURE_SWAP_FACTORY: "DEPLOY_SWAP_FACTORY",
  MINT_XBETH_SWAP_LIQUIDITY: "DEPLOY_XBETH",
  MINT_XETH_SWAP_LIQUIDITY: "DEPLOY_XETH",
  SEED_BORROWER_POSITION: "DEPLOY_AAVE_POOL",
  SEED_FLASH_LIQUIDITY: "DEPLOY_AAVE_POOL",
  REGISTER_PROTECTION_POLICY: "DEPLOY_EGRESS_EXECUTOR",
};

const ACTION_IDS = PHASE11_DEPLOYMENT_SEQUENCE.map((step) => step.actionId) as [
  Phase11DeploymentActionId,
  ...Phase11DeploymentActionId[],
];
const actionIdSchema = z.enum(ACTION_IDS);
const stepKindSchema = z.enum(["DEPLOYMENT", "CALL"]);

export interface Phase11DeploymentConfigurationIdentity {
  chainId: number;
  environmentId: string;
  deployer: Address;
  keeper: Address;
  borrower: Address;
  riskAttestor: Address;
  compatibilityLabel: string;
  executionBounds: unknown;
  startingNonce: string;
}

export function phase11DeploymentConfigurationHash(
  input: Phase11DeploymentConfigurationIdentity,
): Hex {
  return objectHash({
    schemaVersion: 1,
    chainId: input.chainId,
    environmentId: input.environmentId,
    deployer: getAddress(input.deployer),
    keeper: getAddress(input.keeper),
    borrower: getAddress(input.borrower),
    riskAttestor: getAddress(input.riskAttestor),
    compatibilityLabel: input.compatibilityLabel,
    executionBounds: input.executionBounds,
    startingNonce: input.startingNonce,
    expectedTransactionCount: PHASE11_EXPECTED_TRANSACTION_COUNT,
    expectedDeploymentSequence: PHASE11_DEPLOYMENT_SEQUENCE,
  });
}

export function phase11DeploymentId(input: {
  chainId: number;
  environmentId: string;
  deployer: Address;
  startingNonce: string;
  configurationHash: Hex;
}): Hex {
  return objectHash({
    deploymentType: "EGRESS_PHASE11_XLAYER_TESTNET",
    chainId: input.chainId,
    environmentId: input.environmentId,
    deployer: getAddress(input.deployer),
    startingNonce: input.startingNonce,
    configurationHash: input.configurationHash,
  });
}

export function phase11ExpectedTransactionTarget(input: {
  deployer: Address;
  startingNonce: string;
  actionId: Phase11DeploymentActionId;
}): Address | null {
  const action = PHASE11_DEPLOYMENT_SEQUENCE.find((step) => step.actionId === input.actionId);
  if (!action) throw new Phase11DeploymentJournalError(`Unknown Phase 11 deployment action ${input.actionId}.`);
  if (action.kind === "DEPLOYMENT") return null;
  const targetActionId = PHASE11_CALL_TARGET_DEPLOYMENT[input.actionId];
  const targetAction = PHASE11_DEPLOYMENT_SEQUENCE.find((step) => step.actionId === targetActionId);
  if (!targetAction || targetAction.kind !== "DEPLOYMENT") {
    throw new Phase11DeploymentJournalError(`No deployment target is defined for Phase 11 action ${input.actionId}.`);
  }
  return getContractAddress({
    from: getAddress(input.deployer),
    nonce: BigInt(input.startingNonce) + BigInt(targetAction.sequence - 1),
  });
}

export const phase11TransactionProvenanceSchema = z.object({
  deploymentId: hex32Schema,
  chainId: z.number().int().positive(),
  environmentId: z.string().min(1).max(96),
  sequence: z.number().int().min(1).max(PHASE11_EXPECTED_TRANSACTION_COUNT),
  actionId: actionIdSchema,
  from: addressSchema,
  nonce: uintStringSchema,
  to: addressSchema.nullable(),
  value: uintStringSchema,
  calldataHash: hex32Schema,
  transactionHash: hex32Schema,
  initialInclusion: initialInclusionSchema,
  safeInclusion: safeCanonicalInclusionSchema,
  finalizedInclusion: finalizedCanonicalInclusionSchema,
  canonicalInclusionClass: z.enum(["INITIAL_UNSAFE_CANONICAL", "REINCLUDED_AFTER_UNSAFE_REORG"]),
  contractAddress: addressSchema.nullable(),
});

export type Phase11TransactionProvenance = z.infer<typeof phase11TransactionProvenanceSchema> & {
  deploymentId: Hex;
  from: Address;
  to: Address | null;
  calldataHash: Hex;
  transactionHash: Hex;
  initialInclusion: Phase11InitialInclusion;
  safeInclusion: Phase11SafeInclusion;
  finalizedInclusion: Phase11FinalizedInclusion;
  canonicalInclusionClass: "INITIAL_UNSAFE_CANONICAL" | "REINCLUDED_AFTER_UNSAFE_REORG";
  contractAddress: Address | null;
};

export type Phase11SafeTransactionProvenance = Omit<
  Phase11TransactionProvenance,
  "finalizedInclusion"
>;

const journalStepStatusSchema = z.enum([
  "PLANNED",
  "INTENDED",
  "BROADCAST_UNKNOWN",
  "UNKNOWN",
  "INITIAL_INCLUDED",
  "SAFE_INCLUDED",
  "FINALIZED",
  "FINALITY_UNKNOWN",
  "FAILED",
]);

const journalStatusSchema = z.enum([
  "PENDING",
  "RECONCILIATION_REQUIRED",
  "SAFE_COMPLETE",
  "COMPLETE",
  "FINALIZED",
]);

const journalSequenceEntrySchema = z.object({
  sequence: z.number().int().min(1).max(PHASE11_EXPECTED_TRANSACTION_COUNT),
  actionId: actionIdSchema,
  label: z.string().min(1),
  kind: stepKindSchema,
});

const legacyJournalStepStatusSchema = z.enum([
  "PLANNED",
  "INTENDED",
  "BROADCAST_UNKNOWN",
  "UNKNOWN",
  "CONFIRMED",
  "FAILED",
]);

const legacyJournalStepSchema = journalSequenceEntrySchema.extend({
  status: legacyJournalStepStatusSchema,
  from: addressSchema.nullable(),
  nonce: uintStringSchema.nullable(),
  to: addressSchema.nullable(),
  value: uintStringSchema.nullable(),
  calldataHash: hex32Schema.nullable(),
  transactionHash: hex32Schema.nullable(),
  receiptStatus: z.enum(["SUCCESS", "REVERTED"]).nullable(),
  blockNumber: uintStringSchema.nullable(),
  blockHash: hex32Schema.nullable(),
  contractAddress: addressSchema.nullable(),
});

const journalStepSchema = journalSequenceEntrySchema.extend({
  status: journalStepStatusSchema,
  from: addressSchema.nullable(),
  nonce: uintStringSchema.nullable(),
  to: addressSchema.nullable(),
  value: uintStringSchema.nullable(),
  calldataHash: hex32Schema.nullable(),
  transactionHash: hex32Schema.nullable(),
  initialInclusion: initialInclusionSchema.nullable(),
  safeInclusion: safeCanonicalInclusionSchema.nullable(),
  finalizedInclusion: finalizedCanonicalInclusionSchema.nullable(),
  contractAddress: addressSchema.nullable(),
});

const journalIdentitySchema = z.object({
  deploymentId: hex32Schema,
  chainId: z.number().int().positive(),
  environmentId: z.string().min(1).max(96),
  deployer: addressSchema,
  startingNonce: uintStringSchema,
  configurationHash: hex32Schema,
  expectedTransactionCount: z.literal(PHASE11_EXPECTED_TRANSACTION_COUNT),
  expectedDeploymentSequence: z.array(journalSequenceEntrySchema).length(PHASE11_EXPECTED_TRANSACTION_COUNT),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
  status: journalStatusSchema,
  finalManifestHash: hex32Schema.nullable(),
});

export const phase11DeploymentJournalSchema = journalIdentitySchema.extend({
  schemaVersion: z.literal(PHASE11_DEPLOYMENT_JOURNAL_SCHEMA_VERSION),
  steps: z.array(journalStepSchema).length(PHASE11_EXPECTED_TRANSACTION_COUNT),
});

export const legacyPhase11DeploymentJournalSchema = journalIdentitySchema.extend({
  schemaVersion: z.literal(PHASE11_LEGACY_DEPLOYMENT_JOURNAL_SCHEMA_VERSION),
  steps: z.array(legacyJournalStepSchema).length(PHASE11_EXPECTED_TRANSACTION_COUNT),
});

export type Phase11DeploymentJournal = z.infer<typeof phase11DeploymentJournalSchema> & {
  deploymentId: Hex;
  deployer: Address;
  configurationHash: Hex;
  finalManifestHash: Hex | null;
  steps: Array<z.infer<typeof journalStepSchema> & {
    from: Address | null;
    to: Address | null;
    calldataHash: Hex | null;
    transactionHash: Hex | null;
    initialInclusion: Phase11InitialInclusion | null;
    safeInclusion: Phase11SafeInclusion | null;
    finalizedInclusion: Phase11FinalizedInclusion | null;
    contractAddress: Address | null;
  }>;
};

export type LegacyPhase11DeploymentJournal = z.infer<typeof legacyPhase11DeploymentJournalSchema> & {
  deploymentId: Hex;
  deployer: Address;
  configurationHash: Hex;
  finalManifestHash: Hex | null;
  steps: Array<z.infer<typeof legacyJournalStepSchema> & {
    from: Address | null;
    to: Address | null;
    calldataHash: Hex | null;
    transactionHash: Hex | null;
    blockHash: Hex | null;
    contractAddress: Address | null;
  }>;
};

export interface Phase11TransactionIntent {
  deploymentId: Hex;
  chainId: number;
  environmentId: string;
  sequence: number;
  actionId: Phase11DeploymentActionId;
  from: Address;
  nonce: number;
  to: Address | null;
  value: bigint;
  data: Hex;
}

export interface Phase11TransactionReceiptEvidence {
  transactionHash: Hex;
  status: "success" | "reverted";
  blockNumber: bigint;
  blockHash: Hex;
  transactionIndex: number;
  contractAddress: Address | null | undefined;
  from?: Address;
  to?: Address | null;
}

export class Phase11DeploymentJournalError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "Phase11DeploymentJournalError";
  }
}

export class Phase11DeploymentReconciliationError extends Phase11DeploymentJournalError {
  constructor(message: string) {
    super(message);
    this.name = "Phase11DeploymentReconciliationError";
  }
}

export function createPhase11DeploymentJournal(input: {
  deploymentId: Hex;
  chainId: number;
  environmentId: string;
  deployer: Address;
  startingNonce: string;
  configurationHash: Hex;
  createdAt: string;
}): Phase11DeploymentJournal {
  return validatePhase11DeploymentJournal({
    schemaVersion: PHASE11_DEPLOYMENT_JOURNAL_SCHEMA_VERSION,
    deploymentId: input.deploymentId,
    chainId: input.chainId,
    environmentId: input.environmentId,
    deployer: getAddress(input.deployer),
    startingNonce: input.startingNonce,
    configurationHash: input.configurationHash,
    expectedTransactionCount: PHASE11_EXPECTED_TRANSACTION_COUNT,
    expectedDeploymentSequence: PHASE11_DEPLOYMENT_SEQUENCE,
    createdAt: input.createdAt,
    updatedAt: input.createdAt,
    status: "PENDING",
    finalManifestHash: null,
    steps: PHASE11_DEPLOYMENT_SEQUENCE.map((step) => ({
      ...step,
      status: "PLANNED",
      from: null,
      nonce: null,
      to: null,
      value: null,
      calldataHash: null,
      transactionHash: null,
      initialInclusion: null,
      safeInclusion: null,
      finalizedInclusion: null,
      contractAddress: null,
    })),
  });
}

export function validatePhase11DeploymentJournal(value: unknown): Phase11DeploymentJournal {
  const journal = phase11DeploymentJournalSchema.parse(value) as Phase11DeploymentJournal;
  assertExactSequence(journal.expectedDeploymentSequence, "journal expected sequence");
  assertExactSequence(journal.steps, "journal steps");
  const expectedDeploymentId = phase11DeploymentId({
    chainId: journal.chainId,
    environmentId: journal.environmentId,
    deployer: journal.deployer,
    startingNonce: journal.startingNonce,
    configurationHash: journal.configurationHash,
  });
  if (expectedDeploymentId.toLowerCase() !== journal.deploymentId.toLowerCase()) {
    throw new Phase11DeploymentJournalError("Phase 11 journal deployment ID is inconsistent with its configuration identity.");
  }
  assertJournalState(journal);
  return journal;
}

export function validateLegacyPhase11DeploymentJournal(value: unknown): LegacyPhase11DeploymentJournal {
  const journal = legacyPhase11DeploymentJournalSchema.parse(value) as LegacyPhase11DeploymentJournal;
  assertExactSequence(journal.expectedDeploymentSequence, "legacy journal expected sequence");
  assertExactSequence(journal.steps, "legacy journal steps");
  const expectedDeploymentId = phase11DeploymentId({
    chainId: journal.chainId,
    environmentId: journal.environmentId,
    deployer: journal.deployer,
    startingNonce: journal.startingNonce,
    configurationHash: journal.configurationHash,
  });
  if (expectedDeploymentId.toLowerCase() !== journal.deploymentId.toLowerCase()) {
    throw new Phase11DeploymentJournalError("Legacy Phase 11 journal deployment ID is inconsistent with its configuration identity.");
  }
  assertLegacyJournalState(journal);
  return journal;
}

export function phase11DeploymentJournalPath(manifestPath: string, configuredPath?: string | null): string {
  const explicit = configuredPath?.trim();
  return explicit || `${manifestPath}.journal.json`;
}

export async function assertPhase11DeploymentStartupSafe(input: {
  manifestPath: string;
  journalPath: string;
  deploymentId: Hex;
  chainId: number;
  environmentId: string;
  deployer: Address;
  startingNonce: string;
  configurationHash: Hex;
  observedPendingNonce?: number;
}): Promise<void> {
  if (resolve(input.manifestPath) === resolve(input.journalPath)) {
    throw new Phase11DeploymentJournalError(
      "Phase 11 journal path must be distinct from the final manifest path.",
    );
  }
  if (await fileExists(input.manifestPath)) {
    throw new Phase11DeploymentJournalError(
      `Phase 11 final manifest already exists at ${input.manifestPath}; overwrite is forbidden. Use a new deployment location and identity.`,
    );
  }
  if (await fileExists(input.journalPath)) {
    let journal: Phase11DeploymentJournal;
    try {
      journal = await loadPhase11DeploymentJournal(input.journalPath);
    } catch {
      throw new Phase11DeploymentReconciliationError(
        `Phase 11 deployment journal at ${input.journalPath} is unreadable or invalid. Deployment is incomplete and must be reconciled; automatic rerun is forbidden.`,
      );
    }
    const mismatches = [
      journal.deploymentId.toLowerCase() !== input.deploymentId.toLowerCase() ? "deployment ID" : null,
      journal.chainId !== input.chainId ? "chain ID" : null,
      journal.environmentId !== input.environmentId ? "environment ID" : null,
      journal.deployer.toLowerCase() !== input.deployer.toLowerCase() ? "deployer" : null,
      journal.startingNonce !== input.startingNonce ? "starting nonce" : null,
      journal.configurationHash.toLowerCase() !== input.configurationHash.toLowerCase() ? "configuration hash" : null,
    ].filter((value): value is string => value !== null);
    if (mismatches.length > 0) {
      throw new Phase11DeploymentReconciliationError(
        `Existing Phase 11 journal configuration differs from this deployment (${mismatches.join(", ")}). Reconciliation is required; automatic rerun is forbidden.`,
      );
    }
    throw new Phase11DeploymentReconciliationError(
      `Phase 11 deployment journal already exists with status ${journal.status}. Deployment is incomplete or already finalized; reconcile the journal before any new deployment. Automatic rerun is forbidden.`,
    );
  }
  if (input.observedPendingNonce !== undefined && String(input.observedPendingNonce) !== input.startingNonce) {
    throw new Phase11DeploymentJournalError(
      `Phase 11 deployer pending nonce ${input.observedPendingNonce} does not match configured starting nonce ${input.startingNonce}; deployment refused.`,
    );
  }
}

export async function persistNewPhase11DeploymentJournal(
  path: string,
  journal: Phase11DeploymentJournal,
): Promise<void> {
  await atomicWriteJson(path, validatePhase11DeploymentJournal(journal), true);
}

export async function persistPhase11DeploymentJournal(
  path: string,
  journal: Phase11DeploymentJournal,
): Promise<void> {
  await atomicWriteJson(path, validatePhase11DeploymentJournal(journal), false);
}

export async function loadPhase11DeploymentJournal(path: string): Promise<Phase11DeploymentJournal> {
  return validatePhase11DeploymentJournal(JSON.parse(await readFile(path, "utf8")));
}

export async function loadLegacyPhase11DeploymentJournal(path: string): Promise<LegacyPhase11DeploymentJournal> {
  return validateLegacyPhase11DeploymentJournal(JSON.parse(await readFile(path, "utf8")));
}

export async function persistFinalPhase11Manifest(path: string, manifest: unknown): Promise<void> {
  await atomicWriteJson(path, manifest, true);
}

export async function executePhase11DeploymentTransaction(input: {
  journalPath: string;
  intent: Phase11TransactionIntent;
  broadcast: () => Promise<Hex>;
  waitForReceipt: (hash: Hex) => Promise<Phase11TransactionReceiptEvidence>;
  waitForSafeInclusion: (
    hash: Hex,
    intent: Phase11TransactionIntent,
    initialInclusion: Phase11InitialInclusion,
  ) => Promise<Phase11SafeInclusion>;
  now?: () => Date;
}): Promise<Phase11SafeTransactionProvenance> {
  const now = input.now ?? (() => new Date());
  let journal = await loadPhase11DeploymentJournal(input.journalPath);
  journal = recordTransactionIntent(journal, input.intent, now().toISOString());
  await persistPhase11DeploymentJournal(input.journalPath, journal);

  let transactionHash: Hex;
  try {
    transactionHash = await input.broadcast();
  } catch {
    journal = markUnknownBroadcast(journal, input.intent.sequence, now().toISOString());
    await persistPhase11DeploymentJournal(input.journalPath, journal);
    throw new Phase11DeploymentReconciliationError(
      `Phase 11 ${input.intent.actionId} broadcast returned no transaction hash. Reconcile sender ${input.intent.from} nonce ${input.intent.nonce}; automatic rebroadcast is forbidden.`,
    );
  }

  journal = markBroadcastUnknown(journal, input.intent.sequence, transactionHash, now().toISOString());
  try {
    await persistPhase11DeploymentJournal(input.journalPath, journal);
  } catch {
    throw new Phase11DeploymentReconciliationError(
      `Phase 11 ${input.intent.actionId} returned transaction ${transactionHash}, but its journal update failed. Reconcile sender ${input.intent.from} nonce ${input.intent.nonce}; automatic continuation is forbidden.`,
    );
  }
  if (hasDuplicateTransactionHash(journal, input.intent.sequence, transactionHash)) {
    throw new Phase11DeploymentReconciliationError(
      `Phase 11 ${input.intent.actionId} returned a transaction hash already used by this deployment. Reconcile sender ${input.intent.from} nonce ${input.intent.nonce} transaction ${transactionHash}; automatic continuation is forbidden.`,
    );
  }

  let receipt: Phase11TransactionReceiptEvidence;
  try {
    receipt = await input.waitForReceipt(transactionHash);
  } catch {
    throw new Phase11DeploymentReconciliationError(
      `Phase 11 ${input.intent.actionId} receipt confirmation was interrupted. Reconcile sender ${input.intent.from} nonce ${input.intent.nonce} transaction ${transactionHash}; automatic continuation is forbidden.`,
    );
  }

  journal = recordInitialReceipt(journal, input.intent, transactionHash, receipt, now().toISOString());
  await persistPhase11DeploymentJournal(input.journalPath, journal);
  if (receipt.status !== "success") {
    throw new Phase11DeploymentReconciliationError(
      `Phase 11 ${input.intent.actionId} reverted in transaction ${transactionHash}. Reconciliation is required; automatic continuation is forbidden.`,
    );
  }

  const initialInclusion = journal.steps[input.intent.sequence - 1]?.initialInclusion;
  if (!initialInclusion) {
    throw new Phase11DeploymentJournalError(
      `Phase 11 ${input.intent.actionId} has no persisted initial inclusion evidence.`,
    );
  }
  let safeInclusion: Phase11SafeInclusion;
  try {
    safeInclusion = await input.waitForSafeInclusion(transactionHash, input.intent, initialInclusion);
  } catch {
    journal = markFinalityUnknown(journal, input.intent.sequence, now().toISOString());
    await persistPhase11DeploymentJournal(input.journalPath, journal);
    throw new Phase11DeploymentReconciliationError(
      `Phase 11 ${input.intent.actionId} safe inclusion confirmation was interrupted. Reconcile sender ${input.intent.from} nonce ${input.intent.nonce} transaction ${transactionHash}; automatic continuation is forbidden.`,
    );
  }
  journal = recordSafeInclusion(journal, input.intent, transactionHash, safeInclusion, now().toISOString());
  await persistPhase11DeploymentJournal(input.journalPath, journal);
  return safeStepToProvenance(journal.steps[input.intent.sequence - 1]!, journal);
}

export async function finalizePhase11DeploymentTransaction(input: {
  journalPath: string;
  sequence: number;
  waitForFinalizedInclusion: (
    transaction: Phase11SafeTransactionProvenance,
  ) => Promise<Phase11FinalizedInclusion>;
  now?: () => Date;
}): Promise<Phase11TransactionProvenance> {
  const now = input.now ?? (() => new Date());
  let journal = await loadPhase11DeploymentJournal(input.journalPath);
  const step = journal.steps[input.sequence - 1];
  const safeTransaction = step ? safeStepToProvenance(step, journal) : null;
  if (!safeTransaction) {
    throw new Phase11DeploymentJournalError(`Phase 11 transaction ${input.sequence} has no safe provenance.`);
  }
  let finalizedInclusion: Phase11FinalizedInclusion;
  try {
    finalizedInclusion = await input.waitForFinalizedInclusion(safeTransaction);
  } catch {
    journal = markFinalityUnknown(journal, input.sequence, now().toISOString());
    await persistPhase11DeploymentJournal(input.journalPath, journal);
    throw new Phase11DeploymentReconciliationError(
      `Phase 11 ${safeTransaction.actionId} finalized inclusion confirmation was interrupted. Reconcile sender ${safeTransaction.from} nonce ${safeTransaction.nonce} transaction ${safeTransaction.transactionHash}; automatic continuation is forbidden.`,
    );
  }
  journal = recordFinalizedInclusion(
    journal,
    safeTransaction,
    safeTransaction.transactionHash,
    finalizedInclusion,
    now().toISOString(),
  );
  await persistPhase11DeploymentJournal(input.journalPath, journal);
  return confirmedStepToProvenance(journal.steps[input.sequence - 1]!, journal);
}

export function confirmedPhase11DeploymentTransactions(
  journal: Phase11DeploymentJournal,
): Phase11TransactionProvenance[] {
  const validated = validatePhase11DeploymentJournal(journal);
  if (validated.status !== "COMPLETE" && validated.status !== "FINALIZED") {
    throw new Phase11DeploymentJournalError("Phase 11 final provenance requires a complete finalized deployment journal.");
  }
  return validated.steps.map((step) =>
    confirmedStepToProvenance(step as Phase11DeploymentJournal["steps"][number], validated)
  );
}

export function finalizePhase11DeploymentJournal(
  journal: Phase11DeploymentJournal,
  manifestHash: Hex,
  updatedAt: string,
): Phase11DeploymentJournal {
  const validated = validatePhase11DeploymentJournal(journal);
  if (validated.status !== "COMPLETE") {
    throw new Phase11DeploymentJournalError("Only a finalized-evidence-complete Phase 11 deployment journal can be finalized.");
  }
  return validatePhase11DeploymentJournal({
    ...validated,
    status: "FINALIZED",
    finalManifestHash: manifestHash,
    updatedAt,
  });
}

function recordTransactionIntent(
  journal: Phase11DeploymentJournal,
  intent: Phase11TransactionIntent,
  updatedAt: string,
): Phase11DeploymentJournal {
  assertIntentMatchesJournal(journal, intent);
  const steps = journal.steps.map((step) => step.sequence === intent.sequence
    ? {
      ...step,
      status: "INTENDED" as const,
      from: getAddress(intent.from),
      nonce: String(intent.nonce),
      to: intent.to ? getAddress(intent.to) : null,
      value: intent.value.toString(),
      calldataHash: objectHashHex(intent.data),
    }
    : step);
  return validatePhase11DeploymentJournal({ ...journal, status: "PENDING", updatedAt, steps });
}

function markUnknownBroadcast(
  journal: Phase11DeploymentJournal,
  sequence: number,
  updatedAt: string,
): Phase11DeploymentJournal {
  return updateJournalStep(journal, sequence, { status: "UNKNOWN" }, "RECONCILIATION_REQUIRED", updatedAt);
}

function markBroadcastUnknown(
  journal: Phase11DeploymentJournal,
  sequence: number,
  transactionHash: Hex,
  updatedAt: string,
): Phase11DeploymentJournal {
  return updateJournalStep(
    journal,
    sequence,
    { status: "BROADCAST_UNKNOWN", transactionHash },
    "RECONCILIATION_REQUIRED",
    updatedAt,
  );
}

function recordInitialReceipt(
  journal: Phase11DeploymentJournal,
  intent: Phase11TransactionIntent,
  transactionHash: Hex,
  receipt: Phase11TransactionReceiptEvidence,
  updatedAt: string,
): Phase11DeploymentJournal {
  if (receipt.transactionHash.toLowerCase() !== transactionHash.toLowerCase()) {
    throw new Phase11DeploymentJournalError("Phase 11 receipt transaction hash does not match the broadcast hash.");
  }
  if (receipt.from && receipt.from.toLowerCase() !== intent.from.toLowerCase()) {
    throw new Phase11DeploymentJournalError("Phase 11 receipt sender does not match the journaled deployer.");
  }
  if (receipt.to !== undefined && !sameNullableAddress(receipt.to, intent.to)) {
    throw new Phase11DeploymentJournalError("Phase 11 receipt target does not match the journaled transaction intent.");
  }
  const parsedBlockHash = hex32Schema.safeParse(receipt.blockHash);
  if (!parsedBlockHash.success || !Number.isSafeInteger(receipt.transactionIndex) || receipt.transactionIndex < 0) {
    throw new Phase11DeploymentReconciliationError(
      `Phase 11 ${intent.actionId} initial receipt block hash or transaction index is missing or malformed. Reconcile sender ${intent.from} nonce ${intent.nonce} transaction ${transactionHash}; automatic continuation is forbidden.`,
    );
  }
  const blockHash = parsedBlockHash.data as Hex;
  const expected = expectedStep(intent.sequence);
  const contractAddress = receipt.contractAddress ? getAddress(receipt.contractAddress) : null;
  if (receipt.status === "success" && expected.kind === "DEPLOYMENT") {
    const expectedContractAddress = getContractAddress({ from: intent.from, nonce: BigInt(intent.nonce) });
    if (!contractAddress || contractAddress.toLowerCase() !== expectedContractAddress.toLowerCase()) {
      throw new Phase11DeploymentJournalError(
        `Phase 11 ${intent.actionId} receipt contract address does not match the deployer nonce.`,
      );
    }
  } else if (contractAddress !== null) {
    throw new Phase11DeploymentJournalError(`Phase 11 ${intent.actionId} unexpectedly created a contract.`);
  }
  const confirmed = receipt.status === "success";
  const initialInclusion = initialInclusionSchema.parse({
    stage: "INITIAL_UNSAFE",
    receiptStatus: confirmed ? "SUCCESS" : "REVERTED",
    blockNumber: receipt.blockNumber.toString(),
    blockHash,
    transactionIndex: String(receipt.transactionIndex),
    contractAddress,
    observedAt: updatedAt,
  }) as Phase11InitialInclusion;
  const steps = journal.steps.map((step) => step.sequence === intent.sequence
    ? {
      ...step,
      status: confirmed ? "INITIAL_INCLUDED" as const : "FAILED" as const,
      transactionHash,
      initialInclusion,
      contractAddress,
    }
    : step);
  return validatePhase11DeploymentJournal({
    ...journal,
    status: confirmed ? "PENDING" : "RECONCILIATION_REQUIRED",
    updatedAt,
    steps,
  });
}

function recordSafeInclusion(
  journal: Phase11DeploymentJournal,
  intent: Phase11TransactionIntent,
  transactionHash: Hex,
  inclusion: Phase11SafeInclusion,
  updatedAt: string,
): Phase11DeploymentJournal {
  const parsed = safeCanonicalInclusionSchema.parse(inclusion) as Phase11SafeInclusion;
  assertCanonicalInclusionMatchesStep(journal, intent, transactionHash, parsed, "INITIAL_INCLUDED");
  const steps = journal.steps.map((candidate) => candidate.sequence === intent.sequence
    ? { ...candidate, status: "SAFE_INCLUDED" as const, safeInclusion: parsed }
    : candidate);
  const allSafe = steps.every((candidate) => candidate.status === "SAFE_INCLUDED" || candidate.status === "FINALIZED");
  return validatePhase11DeploymentJournal({
    ...journal,
    status: allSafe ? "SAFE_COMPLETE" : "PENDING",
    updatedAt,
    steps,
  });
}

function recordFinalizedInclusion(
  journal: Phase11DeploymentJournal,
  transaction: Phase11SafeTransactionProvenance,
  transactionHash: Hex,
  inclusion: Phase11FinalizedInclusion,
  updatedAt: string,
): Phase11DeploymentJournal {
  const parsed = finalizedCanonicalInclusionSchema.parse(inclusion) as Phase11FinalizedInclusion;
  assertCanonicalInclusionMatchesStep(journal, transaction, transactionHash, parsed, "SAFE_INCLUDED");
  const step = journal.steps[transaction.sequence - 1]!;
  if (!step.safeInclusion) {
    throw new Phase11DeploymentReconciliationError(
      `Phase 11 ${transaction.actionId} finalized inclusion has no preceding safe canonical evidence.`,
    );
  }
  const steps = journal.steps.map((candidate) => candidate.sequence === transaction.sequence
    ? { ...candidate, status: "FINALIZED" as const, finalizedInclusion: parsed }
    : candidate);
  const allFinalized = steps.every((candidate) => candidate.status === "FINALIZED");
  return validatePhase11DeploymentJournal({
    ...journal,
    status: allFinalized ? "COMPLETE" : "SAFE_COMPLETE",
    updatedAt,
    steps,
  });
}

function markFinalityUnknown(
  journal: Phase11DeploymentJournal,
  sequence: number,
  updatedAt: string,
): Phase11DeploymentJournal {
  return updateJournalStep(
    journal,
    sequence,
    { status: "FINALITY_UNKNOWN" },
    "RECONCILIATION_REQUIRED",
    updatedAt,
  );
}

function assertCanonicalInclusionMatchesStep(
  journal: Phase11DeploymentJournal,
  transaction: {
    sequence: number;
    actionId: Phase11DeploymentActionId;
    from: Address;
    nonce: string | number;
  },
  transactionHash: Hex,
  inclusion: Phase11SafeInclusion | Phase11FinalizedInclusion,
  requiredStatus: "INITIAL_INCLUDED" | "SAFE_INCLUDED",
): void {
  const step = journal.steps[transaction.sequence - 1];
  if (!step || step.status !== requiredStatus || !step.initialInclusion) {
    throw new Phase11DeploymentReconciliationError(
      `Phase 11 ${transaction.actionId} cannot record ${inclusion.stage} from journal status ${step?.status ?? "MISSING"}.`,
    );
  }
  if (!step.transactionHash || step.transactionHash.toLowerCase() !== transactionHash.toLowerCase()) {
    throw new Phase11DeploymentJournalError(`Phase 11 ${transaction.actionId} finality evidence transaction hash is inconsistent.`);
  }
  if (BigInt(inclusion.finalityHeadBlockNumber) < BigInt(inclusion.blockNumber)) {
    throw new Phase11DeploymentReconciliationError(
      `Phase 11 ${transaction.actionId} ${inclusion.stage} head does not cover the transaction block.`,
    );
  }
  const expected = expectedStep(transaction.sequence);
  const expectedContractAddress = expected.kind === "DEPLOYMENT"
    ? getContractAddress({ from: transaction.from, nonce: BigInt(transaction.nonce) })
    : null;
  if (!sameNullableAddress(inclusion.contractAddress, expectedContractAddress)) {
    throw new Phase11DeploymentJournalError(
      `Phase 11 ${transaction.actionId} ${inclusion.stage} contract address does not match the deployer nonce.`,
    );
  }
}

function sameCanonicalInclusion(
  left: Phase11CanonicalInclusion,
  right: Phase11CanonicalInclusion,
): boolean {
  return left.blockNumber === right.blockNumber &&
    left.blockHash.toLowerCase() === right.blockHash.toLowerCase() &&
    left.transactionIndex === right.transactionIndex &&
    sameNullableAddress(left.contractAddress, right.contractAddress);
}

function updateJournalStep(
  journal: Phase11DeploymentJournal,
  sequence: number,
  patch: Partial<Phase11DeploymentJournal["steps"][number]>,
  status: Phase11DeploymentJournal["status"],
  updatedAt: string,
): Phase11DeploymentJournal {
  const steps = journal.steps.map((step) => step.sequence === sequence ? { ...step, ...patch } : step);
  return validatePhase11DeploymentJournal({ ...journal, status, updatedAt, steps });
}

function assertIntentMatchesJournal(
  journal: Phase11DeploymentJournal,
  intent: Phase11TransactionIntent,
): void {
  if (journal.status !== "PENDING") {
    throw new Phase11DeploymentReconciliationError(
      `Phase 11 journal status ${journal.status} forbids further deployment transactions.`,
    );
  }
  if (
    intent.deploymentId.toLowerCase() !== journal.deploymentId.toLowerCase() ||
    intent.chainId !== journal.chainId ||
    intent.environmentId !== journal.environmentId ||
    intent.from.toLowerCase() !== journal.deployer.toLowerCase()
  ) {
    throw new Phase11DeploymentJournalError("Phase 11 transaction intent does not match the deployment journal identity.");
  }
  const expected = expectedStep(intent.sequence);
  if (expected.actionId !== intent.actionId) {
    throw new Phase11DeploymentJournalError(
      `Phase 11 transaction ${intent.sequence} must be ${expected.actionId}, received ${intent.actionId}.`,
    );
  }
  const expectedNonce = BigInt(journal.startingNonce) + BigInt(intent.sequence - 1);
  if (BigInt(intent.nonce) !== expectedNonce) {
    throw new Phase11DeploymentJournalError(
      `Phase 11 transaction ${intent.sequence} nonce ${intent.nonce} does not match expected nonce ${expectedNonce}.`,
    );
  }
  const step = journal.steps[intent.sequence - 1];
  if (!step || step.status !== "PLANNED") {
    throw new Phase11DeploymentReconciliationError(
      `Phase 11 transaction ${intent.sequence} is already journaled with status ${step?.status ?? "MISSING"}; replay is forbidden.`,
    );
  }
  if (journal.steps.slice(0, intent.sequence - 1).some((previous) =>
    previous.status !== "SAFE_INCLUDED" && previous.status !== "FINALIZED"
  )) {
    throw new Phase11DeploymentReconciliationError(
      `Phase 11 transaction ${intent.sequence} cannot run before every preceding transaction is safely included.`,
    );
  }
  const expectedTarget = phase11ExpectedTransactionTarget({
    deployer: journal.deployer,
    startingNonce: journal.startingNonce,
    actionId: intent.actionId,
  });
  if (!sameNullableAddress(intent.to, expectedTarget)) {
    throw new Phase11DeploymentJournalError(
      `Phase 11 ${intent.actionId} target does not match the contract derived from the configured deployer and nonce sequence.`,
    );
  }
}

function confirmedStepToProvenance(
  step: Phase11DeploymentJournal["steps"][number],
  journal: Phase11DeploymentJournal,
): Phase11TransactionProvenance {
  if (
    step.status !== "FINALIZED" ||
    !step.from ||
    step.nonce === null ||
    step.value === null ||
    !step.calldataHash ||
    !step.transactionHash ||
    !step.initialInclusion ||
    !step.safeInclusion ||
    !step.finalizedInclusion
  ) {
    throw new Phase11DeploymentJournalError(
      `Phase 11 transaction ${step.sequence} is not complete enough for finalized provenance.`,
    );
  }
  const expected = expectedStep(step.sequence);
  if (expected.kind === "DEPLOYMENT" && !step.contractAddress) {
    throw new Phase11DeploymentJournalError(
      `Phase 11 deployment transaction ${step.sequence} has no contract address.`,
    );
  }
  if (expected.kind === "CALL" && !step.to) {
    throw new Phase11DeploymentJournalError(
      `Phase 11 call transaction ${step.sequence} has no target address.`,
    );
  }
  return phase11TransactionProvenanceSchema.parse({
    deploymentId: journal.deploymentId,
    chainId: journal.chainId,
    environmentId: journal.environmentId,
    sequence: step.sequence,
    actionId: step.actionId,
    from: step.from,
    nonce: step.nonce,
    to: step.to,
    value: step.value,
    calldataHash: step.calldataHash,
    transactionHash: step.transactionHash,
    initialInclusion: step.initialInclusion,
    safeInclusion: step.safeInclusion,
    finalizedInclusion: step.finalizedInclusion,
    canonicalInclusionClass: step.initialInclusion.blockNumber === step.safeInclusion.blockNumber &&
      step.initialInclusion.blockHash.toLowerCase() === step.safeInclusion.blockHash.toLowerCase()
      ? "INITIAL_UNSAFE_CANONICAL"
      : "REINCLUDED_AFTER_UNSAFE_REORG",
    contractAddress: step.contractAddress,
  }) as Phase11TransactionProvenance;
}

function safeStepToProvenance(
  step: Phase11DeploymentJournal["steps"][number],
  journal: Phase11DeploymentJournal,
): Phase11SafeTransactionProvenance {
  if (
    (step.status !== "SAFE_INCLUDED" && step.status !== "FINALIZED") ||
    !step.from ||
    step.nonce === null ||
    step.value === null ||
    !step.calldataHash ||
    !step.transactionHash ||
    !step.initialInclusion ||
    !step.safeInclusion
  ) {
    throw new Phase11DeploymentJournalError(
      `Phase 11 transaction ${step.sequence} is not complete enough for safe provenance.`,
    );
  }
  const expected = expectedStep(step.sequence);
  if (expected.kind === "DEPLOYMENT" && !step.contractAddress) {
    throw new Phase11DeploymentJournalError(
      `Phase 11 deployment transaction ${step.sequence} has no contract address.`,
    );
  }
  if (expected.kind === "CALL" && !step.to) {
    throw new Phase11DeploymentJournalError(
      `Phase 11 call transaction ${step.sequence} has no target address.`,
    );
  }
  return {
    deploymentId: journal.deploymentId,
    chainId: journal.chainId,
    environmentId: journal.environmentId,
    sequence: step.sequence,
    actionId: step.actionId,
    from: step.from,
    nonce: step.nonce,
    to: step.to,
    value: step.value,
    calldataHash: step.calldataHash,
    transactionHash: step.transactionHash,
    initialInclusion: step.initialInclusion,
    safeInclusion: step.safeInclusion,
    canonicalInclusionClass: step.initialInclusion.blockNumber === step.safeInclusion.blockNumber &&
      step.initialInclusion.blockHash.toLowerCase() === step.safeInclusion.blockHash.toLowerCase()
      ? "INITIAL_UNSAFE_CANONICAL"
      : "REINCLUDED_AFTER_UNSAFE_REORG",
    contractAddress: step.contractAddress,
  };
}

function expectedStep(sequence: number): Phase11DeploymentSequenceEntry {
  const step = PHASE11_DEPLOYMENT_SEQUENCE[sequence - 1];
  if (!step) throw new Phase11DeploymentJournalError(`Unknown Phase 11 deployment sequence number ${sequence}.`);
  return step;
}

function assertExactSequence(
  sequence: ReadonlyArray<{ sequence: number; actionId: string; label?: string; kind?: string }>,
  label: string,
): void {
  if (sequence.length !== PHASE11_EXPECTED_TRANSACTION_COUNT) {
    throw new Phase11DeploymentJournalError(
      `Phase 11 ${label} must contain exactly ${PHASE11_EXPECTED_TRANSACTION_COUNT} records.`,
    );
  }
  for (let index = 0; index < PHASE11_DEPLOYMENT_SEQUENCE.length; index += 1) {
    const actual = sequence[index];
    const expected = PHASE11_DEPLOYMENT_SEQUENCE[index]!;
    if (
      !actual ||
      actual.sequence !== expected.sequence ||
      actual.actionId !== expected.actionId ||
      (actual.label !== undefined && actual.label !== expected.label) ||
      (actual.kind !== undefined && actual.kind !== expected.kind)
    ) {
      throw new Phase11DeploymentJournalError(
        `Phase 11 ${label} record ${index + 1} does not match ${expected.actionId}.`,
      );
    }
  }
}

function assertJournalState(journal: Phase11DeploymentJournal): void {
  let foundIncomplete = false;
  let hasReconciliationStep = false;
  const transactionHashes = new Set<string>();

  for (const step of journal.steps) {
    const expected = expectedStep(step.sequence);
    const expectedNonce = BigInt(journal.startingNonce) + BigInt(step.sequence - 1);
    const expectedTarget = phase11ExpectedTransactionTarget({
      deployer: journal.deployer,
      startingNonce: journal.startingNonce,
      actionId: step.actionId,
    });
    const intended = step.status !== "PLANNED";
    if (intended) {
      if (
        !step.from ||
        step.from.toLowerCase() !== journal.deployer.toLowerCase() ||
        step.nonce === null ||
        BigInt(step.nonce) !== expectedNonce ||
        !sameNullableAddress(step.to, expectedTarget) ||
        step.value !== "0" ||
        !step.calldataHash
      ) {
        throw new Phase11DeploymentJournalError(
          `Phase 11 journal intent metadata is inconsistent at step ${step.sequence}.`,
        );
      }
    } else if (
      step.from !== null ||
      step.nonce !== null ||
      step.to !== null ||
      step.value !== null ||
      step.calldataHash !== null ||
      step.transactionHash !== null ||
      step.initialInclusion !== null ||
      step.safeInclusion !== null ||
      step.finalizedInclusion !== null ||
      step.contractAddress !== null
    ) {
      throw new Phase11DeploymentJournalError(
        `Phase 11 planned step ${step.sequence} unexpectedly contains transaction evidence.`,
      );
    }

    if (step.status === "INTENDED" || step.status === "UNKNOWN") {
      if (
        step.transactionHash !== null ||
        step.initialInclusion !== null ||
        step.safeInclusion !== null ||
        step.finalizedInclusion !== null ||
        step.contractAddress !== null
      ) {
        throw new Phase11DeploymentJournalError(
          `Phase 11 journal step ${step.sequence} contains evidence that is invalid for status ${step.status}.`,
        );
      }
    }
    if (step.status === "BROADCAST_UNKNOWN") {
      if (
        !step.transactionHash ||
        step.initialInclusion !== null ||
        step.safeInclusion !== null ||
        step.finalizedInclusion !== null ||
        step.contractAddress !== null
      ) {
        throw new Phase11DeploymentJournalError(
          `Phase 11 broadcast-unknown step ${step.sequence} has inconsistent evidence.`,
        );
      }
    }
    const hasInitialEvidence = step.initialInclusion !== null;
    if (["INITIAL_INCLUDED", "SAFE_INCLUDED", "FINALIZED", "FINALITY_UNKNOWN", "FAILED"].includes(step.status)) {
      if (!step.transactionHash || !step.initialInclusion) {
        throw new Phase11DeploymentJournalError(`Phase 11 journal initial inclusion is incomplete at step ${step.sequence}.`);
      }
      const normalizedHash = step.transactionHash.toLowerCase();
      if (transactionHashes.has(normalizedHash) && journal.status !== "RECONCILIATION_REQUIRED") {
        throw new Phase11DeploymentJournalError("Phase 11 journal contains duplicate transaction hashes.");
      }
      transactionHashes.add(normalizedHash);
      const expectedContractAddress = expected.kind === "DEPLOYMENT"
        ? getContractAddress({ from: journal.deployer, nonce: expectedNonce })
        : null;
      if (step.status === "FAILED") {
        if (step.initialInclusion.receiptStatus !== "REVERTED" ||
            step.safeInclusion !== null || step.finalizedInclusion !== null || step.contractAddress !== null) {
          throw new Phase11DeploymentJournalError(
            `Phase 11 reverted step ${step.sequence} contains inconsistent finality evidence.`,
          );
        }
      } else if (step.initialInclusion.receiptStatus !== "SUCCESS" ||
          !sameNullableAddress(step.initialInclusion.contractAddress, expectedContractAddress) ||
          !sameNullableAddress(step.contractAddress, expectedContractAddress)) {
        throw new Phase11DeploymentJournalError(
          `Phase 11 journal contract address is inconsistent at step ${step.sequence}.`,
        );
      }
    } else if (hasInitialEvidence) {
      throw new Phase11DeploymentJournalError(
        `Phase 11 journal step ${step.sequence} contains initial inclusion evidence invalid for status ${step.status}.`,
      );
    }

    if (step.status === "INITIAL_INCLUDED" && (step.safeInclusion !== null || step.finalizedInclusion !== null)) {
      throw new Phase11DeploymentJournalError(`Phase 11 initial-only step ${step.sequence} contains canonical finality evidence.`);
    }
    if (step.status === "SAFE_INCLUDED") {
      if (!step.safeInclusion || step.finalizedInclusion !== null) {
        throw new Phase11DeploymentJournalError(`Phase 11 safe step ${step.sequence} contains incomplete finality evidence.`);
      }
    }
    if (step.status === "FINALIZED") {
      if (!step.safeInclusion || !step.finalizedInclusion) {
        throw new Phase11DeploymentJournalError(
          `Phase 11 finalized step ${step.sequence} does not contain safe and finalized evidence.`,
        );
      }
    }
    if (step.status === "FINALITY_UNKNOWN" && step.finalizedInclusion !== null) {
      throw new Phase11DeploymentJournalError(`Phase 11 finality-unknown step ${step.sequence} unexpectedly contains finalized evidence.`);
    }

    if (foundIncomplete && step.status === "FINALIZED") {
      throw new Phase11DeploymentJournalError("Phase 11 journal contains a finalized transaction after an incomplete step.");
    }
    if (step.status !== "FINALIZED") foundIncomplete = true;
    if (["UNKNOWN", "BROADCAST_UNKNOWN", "FINALITY_UNKNOWN", "FAILED"].includes(step.status)) {
      hasReconciliationStep = true;
    }
  }

  const allFinalized = journal.steps.every((step) => step.status === "FINALIZED");
  if ((journal.status === "COMPLETE" || journal.status === "FINALIZED") !== allFinalized) {
    throw new Phase11DeploymentJournalError("Phase 11 journal completion status is inconsistent with its steps.");
  }
  if (journal.status === "PENDING" && (allFinalized || hasReconciliationStep)) {
    throw new Phase11DeploymentJournalError("Phase 11 pending journal contains a terminal or ambiguous deployment step.");
  }
  if (journal.status === "SAFE_COMPLETE" && !journal.steps.every((step) => step.status === "SAFE_INCLUDED" || step.status === "FINALIZED")) {
    throw new Phase11DeploymentJournalError("Phase 11 safe-complete journal does not contain safe evidence for every step.");
  }
  if (journal.status === "SAFE_COMPLETE" && journal.finalManifestHash !== null) {
    throw new Phase11DeploymentJournalError("Phase 11 safe-complete journal unexpectedly contains a final manifest hash.");
  }
  if (journal.status === "RECONCILIATION_REQUIRED" && !hasReconciliationStep) {
    throw new Phase11DeploymentJournalError("Phase 11 reconciliation status has no ambiguous or failed deployment step.");
  }
  if (journal.status === "FINALIZED") {
    if (!journal.finalManifestHash) {
      throw new Phase11DeploymentJournalError("Phase 11 finalized journal has no final manifest hash.");
    }
  } else if (journal.finalManifestHash !== null) {
    throw new Phase11DeploymentJournalError("Phase 11 non-finalized journal unexpectedly contains a final manifest hash.");
  }
}

function assertLegacyJournalState(journal: LegacyPhase11DeploymentJournal): void {
  let foundIncomplete = false;
  let hasReconciliationStep = false;
  const transactionHashes = new Set<string>();

  for (const step of journal.steps) {
    const expected = expectedStep(step.sequence);
    const expectedNonce = BigInt(journal.startingNonce) + BigInt(step.sequence - 1);
    const expectedTarget = phase11ExpectedTransactionTarget({
      deployer: journal.deployer,
      startingNonce: journal.startingNonce,
      actionId: step.actionId,
    });
    const intended = step.status !== "PLANNED";
    if (intended) {
      if (!step.from || step.from.toLowerCase() !== journal.deployer.toLowerCase() ||
          step.nonce === null || BigInt(step.nonce) !== expectedNonce ||
          !sameNullableAddress(step.to, expectedTarget) || step.value !== "0" || !step.calldataHash) {
        throw new Phase11DeploymentJournalError(
          `Legacy Phase 11 journal intent metadata is inconsistent at step ${step.sequence}.`,
        );
      }
    } else if (step.from !== null || step.nonce !== null || step.to !== null || step.value !== null ||
        step.calldataHash !== null || step.transactionHash !== null || step.receiptStatus !== null ||
        step.blockNumber !== null || step.blockHash !== null || step.contractAddress !== null) {
      throw new Phase11DeploymentJournalError(
        `Legacy Phase 11 planned step ${step.sequence} unexpectedly contains transaction evidence.`,
      );
    }

    if (step.status === "INTENDED" || step.status === "UNKNOWN") {
      if (step.transactionHash !== null || step.receiptStatus !== null || step.blockNumber !== null ||
          step.blockHash !== null || step.contractAddress !== null) {
        throw new Phase11DeploymentJournalError(
          `Legacy Phase 11 journal step ${step.sequence} contains invalid evidence for status ${step.status}.`,
        );
      }
    }
    if (step.status === "BROADCAST_UNKNOWN" && (!step.transactionHash || step.receiptStatus !== null ||
        step.blockNumber !== null || step.blockHash !== null || step.contractAddress !== null)) {
      throw new Phase11DeploymentJournalError(
        `Legacy Phase 11 broadcast-unknown step ${step.sequence} has inconsistent evidence.`,
      );
    }
    if (step.status === "CONFIRMED" || step.status === "FAILED") {
      const expectedReceiptStatus = step.status === "CONFIRMED" ? "SUCCESS" : "REVERTED";
      if (!step.transactionHash || step.receiptStatus !== expectedReceiptStatus ||
          step.blockNumber === null || !step.blockHash) {
        throw new Phase11DeploymentJournalError(
          `Legacy Phase 11 journal receipt evidence is incomplete at step ${step.sequence}.`,
        );
      }
      const normalizedHash = step.transactionHash.toLowerCase();
      if (transactionHashes.has(normalizedHash) && journal.status !== "RECONCILIATION_REQUIRED") {
        throw new Phase11DeploymentJournalError("Legacy Phase 11 journal contains duplicate confirmed transaction hashes.");
      }
      transactionHashes.add(normalizedHash);
      const expectedContractAddress = expected.kind === "DEPLOYMENT"
        ? getContractAddress({ from: journal.deployer, nonce: expectedNonce })
        : null;
      if (step.status === "CONFIRMED" && !sameNullableAddress(step.contractAddress, expectedContractAddress)) {
        throw new Phase11DeploymentJournalError(
          `Legacy Phase 11 journal contract address is inconsistent at step ${step.sequence}.`,
        );
      }
      if (step.status === "FAILED" && step.contractAddress !== null) {
        throw new Phase11DeploymentJournalError(
          `Legacy Phase 11 reverted step ${step.sequence} unexpectedly contains a contract address.`,
        );
      }
    }

    if (foundIncomplete && step.status === "CONFIRMED") {
      throw new Phase11DeploymentJournalError("Legacy Phase 11 journal contains a confirmed transaction after an incomplete step.");
    }
    if (step.status !== "CONFIRMED") foundIncomplete = true;
    if (["UNKNOWN", "BROADCAST_UNKNOWN", "FAILED"].includes(step.status)) hasReconciliationStep = true;
  }

  const allConfirmed = journal.steps.every((step) => step.status === "CONFIRMED");
  if ((journal.status === "COMPLETE" || journal.status === "FINALIZED") !== allConfirmed) {
    throw new Phase11DeploymentJournalError("Legacy Phase 11 journal completion status is inconsistent with its steps.");
  }
  if (journal.status === "PENDING" && (allConfirmed || hasReconciliationStep)) {
    throw new Phase11DeploymentJournalError("Legacy Phase 11 pending journal contains a terminal or ambiguous deployment step.");
  }
  if (journal.status === "RECONCILIATION_REQUIRED" && !hasReconciliationStep) {
    throw new Phase11DeploymentJournalError("Legacy Phase 11 reconciliation status has no ambiguous or failed deployment step.");
  }
  if (journal.status === "FINALIZED") {
    if (!journal.finalManifestHash) {
      throw new Phase11DeploymentJournalError("Legacy Phase 11 finalized journal has no final manifest hash.");
    }
  } else if (journal.finalManifestHash !== null) {
    throw new Phase11DeploymentJournalError("Legacy Phase 11 non-finalized journal unexpectedly contains a final manifest hash.");
  }
}

function hasDuplicateTransactionHash(
  journal: Phase11DeploymentJournal,
  sequence: number,
  transactionHash: Hex,
): boolean {
  return journal.steps.some((step) =>
    step.sequence !== sequence && step.transactionHash?.toLowerCase() === transactionHash.toLowerCase()
  );
}

function objectHashHex(data: Hex): Hex {
  return keccak256(data);
}

function sameNullableAddress(left: Address | null, right: Address | null): boolean {
  if (left === null || right === null) return left === right;
  return left.toLowerCase() === right.toLowerCase();
}

async function atomicWriteJson(path: string, value: unknown, exclusive: boolean): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const temporaryPath = `${path}.${process.pid}.${randomUUID()}.tmp`;
  let handle: Awaited<ReturnType<typeof open>> | null = null;
  try {
    handle = await open(temporaryPath, "wx", 0o600);
    await handle.writeFile(`${JSON.stringify(value, null, 2)}\n`, "utf8");
    await handle.sync();
    await handle.close();
    handle = null;
    if (exclusive) {
      await link(temporaryPath, path);
      await unlink(temporaryPath);
    } else {
      await rename(temporaryPath, path);
    }
    await syncParentDirectory(path);
  } catch (error) {
    if (handle) await handle.close().catch(() => undefined);
    await unlink(temporaryPath).catch(() => undefined);
    if (exclusive && isFileExistsError(error)) {
      throw new Phase11DeploymentJournalError(`Refusing to overwrite existing Phase 11 file ${path}.`);
    }
    throw error;
  }
}

async function syncParentDirectory(path: string): Promise<void> {
  let directoryHandle: Awaited<ReturnType<typeof open>> | null = null;
  try {
    directoryHandle = await open(dirname(path), "r");
    await directoryHandle.sync();
  } catch (error) {
    if (!isUnsupportedDirectorySync(error)) throw error;
  } finally {
    await directoryHandle?.close().catch(() => undefined);
  }
}

async function fileExists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch (error) {
    if (isMissingFileError(error)) return false;
    throw error;
  }
}

function errorCode(error: unknown): string | null {
  return typeof error === "object" && error !== null && "code" in error
    ? String((error as { code?: unknown }).code ?? "")
    : null;
}

function isFileExistsError(error: unknown): boolean {
  return errorCode(error) === "EEXIST";
}

function isMissingFileError(error: unknown): boolean {
  return errorCode(error) === "ENOENT";
}

function isUnsupportedDirectorySync(error: unknown): boolean {
  return ["EINVAL", "ENOTSUP", "EBADF", "EISDIR", "EPERM"].includes(errorCode(error) ?? "");
}
