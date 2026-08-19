import {
  getAddress,
  getContractAddress,
  keccak256,
  type Address,
  type Hex,
  type PublicClient,
} from "viem";
import {
  type Phase11CanonicalInclusion,
  type Phase11FinalizedInclusion,
  type Phase11InitialInclusion,
  type Phase11SafeInclusion,
  type Phase11TransactionIntent,
} from "./testnet-deployment-journal.js";
import { hex32Schema } from "../domain/schemas.js";

export type Phase11FinalityStage = "SAFE_CANONICAL" | "FINALIZED_CANONICAL";

export interface Phase11FinalityExpectation {
  transactionHash: Hex;
  chainId: number;
  from: Address;
  nonce: string;
  to: Address | null;
  value: string;
  calldataHash: Hex;
  sequence: number;
  deploymentKind: "DEPLOYMENT" | "CALL";
  expectedContractAddress: Address | null;
}

export type Phase11CanonicalInclusionForStage<T extends Phase11FinalityStage> =
  T extends "SAFE_CANONICAL" ? Phase11SafeInclusion : Phase11FinalizedInclusion;

export class Phase11DeploymentFinalityError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "Phase11DeploymentFinalityError";
  }
}

export async function readPhase11CanonicalInclusion(
  client: PublicClient,
  input: {
    expectation: Phase11FinalityExpectation;
    stage: "SAFE_CANONICAL";
    observedAt?: string;
  },
): Promise<Phase11SafeInclusion>;
export async function readPhase11CanonicalInclusion(
  client: PublicClient,
  input: {
    expectation: Phase11FinalityExpectation;
    stage: "FINALIZED_CANONICAL";
    observedAt?: string;
  },
): Promise<Phase11FinalizedInclusion>;
export async function readPhase11CanonicalInclusion(
  client: PublicClient,
  input: {
    expectation: Phase11FinalityExpectation;
    stage: Phase11FinalityStage;
    observedAt?: string;
  },
): Promise<Phase11SafeInclusion | Phase11FinalizedInclusion> {
  const finalityHead = await client.getBlock({
    blockTag: input.stage === "SAFE_CANONICAL" ? "safe" : "finalized",
  });
  if (
    finalityHead.number === null ||
    !finalityHead.hash ||
    !hex32Schema.safeParse(finalityHead.hash).success
  ) {
    throw new Phase11DeploymentFinalityError(`${input.stage} head is missing a block number or hash.`);
  }
  const receipt = await client.getTransactionReceipt({ hash: input.expectation.transactionHash });
  const transaction = await client.getTransaction({ hash: input.expectation.transactionHash });
  if (receipt.blockNumber > finalityHead.number) {
    throw new Phase11DeploymentFinalityError(
      `${input.stage} head ${finalityHead.number} does not cover transaction block ${receipt.blockNumber}.`,
    );
  }
  if (
    receipt.blockNumber < 0n ||
    !receipt.blockHash ||
    !hex32Schema.safeParse(receipt.blockHash).success
  ) {
    throw new Phase11DeploymentFinalityError(`Receipt block evidence is missing at ${input.stage}.`);
  }
  const block = await client.getBlock({
    blockNumber: receipt.blockNumber,
    includeTransactions: true,
  });
  const blockByHash = await client.getBlock({
    blockHash: receipt.blockHash,
    includeTransactions: true,
  });
  if (
    !receipt.blockHash ||
    !block.hash ||
    !hex32Schema.safeParse(block.hash).success ||
    receipt.blockHash.toLowerCase() !== block.hash.toLowerCase()
  ) {
    throw new Phase11DeploymentFinalityError(
      `Receipt/block hash mismatch at ${input.stage} for ${input.expectation.transactionHash}.`,
    );
  }
  if (
    !blockByHash.hash ||
    !hex32Schema.safeParse(blockByHash.hash).success ||
    blockByHash.number === null ||
    blockByHash.number !== receipt.blockNumber ||
    blockByHash.hash.toLowerCase() !== receipt.blockHash.toLowerCase()
  ) {
    throw new Phase11DeploymentFinalityError(
      `Receipt/block-hash lookup mismatch at ${input.stage} for ${input.expectation.transactionHash}.`,
    );
  }
  if (receipt.transactionHash.toLowerCase() !== input.expectation.transactionHash.toLowerCase()) {
    throw new Phase11DeploymentFinalityError(`Receipt transaction hash mismatch at ${input.stage}.`);
  }
  if (transaction.hash.toLowerCase() !== input.expectation.transactionHash.toLowerCase()) {
    throw new Phase11DeploymentFinalityError(`Transaction hash mismatch at ${input.stage}.`);
  }
  if (receipt.status !== "success") {
    throw new Phase11DeploymentFinalityError(`Transaction ${input.expectation.transactionHash} is not successful at ${input.stage}.`);
  }
  if (!sameAddress(receipt.from, input.expectation.from) || !sameAddress(transaction.from, input.expectation.from)) {
    throw new Phase11DeploymentFinalityError(`Sender mismatch at ${input.stage} for step ${input.expectation.sequence}.`);
  }
  if (BigInt(transaction.nonce) !== BigInt(input.expectation.nonce)) {
    throw new Phase11DeploymentFinalityError(`Nonce mismatch at ${input.stage} for step ${input.expectation.sequence}.`);
  }
  if (
    transaction.blockNumber !== undefined &&
    (transaction.blockNumber !== receipt.blockNumber ||
      !transaction.blockHash ||
      transaction.blockHash.toLowerCase() !== receipt.blockHash.toLowerCase())
  ) {
    throw new Phase11DeploymentFinalityError(`Transaction block provenance mismatch at ${input.stage}.`);
  }
  if (
    transaction.transactionIndex !== undefined &&
    transaction.transactionIndex !== receipt.transactionIndex
  ) {
    throw new Phase11DeploymentFinalityError(`Transaction index mismatch at ${input.stage}.`);
  }
  if (!sameNullableAddress(receipt.to, input.expectation.to) || !sameNullableAddress(transaction.to, input.expectation.to)) {
    throw new Phase11DeploymentFinalityError(`Target mismatch at ${input.stage} for step ${input.expectation.sequence}.`);
  }
  if (transaction.value !== BigInt(input.expectation.value)) {
    throw new Phase11DeploymentFinalityError(`Transaction value mismatch at ${input.stage} for step ${input.expectation.sequence}.`);
  }
  if (keccak256(transaction.input).toLowerCase() !== input.expectation.calldataHash.toLowerCase()) {
    throw new Phase11DeploymentFinalityError(`Calldata hash mismatch at ${input.stage} for step ${input.expectation.sequence}.`);
  }
  if (transaction.chainId !== undefined && Number(transaction.chainId) !== input.expectation.chainId) {
    throw new Phase11DeploymentFinalityError(`Chain ID mismatch at ${input.stage} for step ${input.expectation.sequence}.`);
  }
  const transactionIndex = receipt.transactionIndex;
  if (!Number.isSafeInteger(transactionIndex) || transactionIndex < 0) {
    throw new Phase11DeploymentFinalityError(`Transaction index is missing or malformed at ${input.stage}.`);
  }
  const blockTransactions = block.transactions as readonly unknown[];
  const blockTransaction = blockTransactions[transactionIndex];
  const blockTransactionHash = typeof blockTransaction === "string"
    ? blockTransaction
    : typeof blockTransaction === "object" && blockTransaction !== null && "hash" in blockTransaction
      ? String((blockTransaction as { hash: unknown }).hash)
      : null;
  if (!blockTransactionHash || blockTransactionHash.toLowerCase() !== input.expectation.transactionHash.toLowerCase()) {
    throw new Phase11DeploymentFinalityError(
      `Transaction is not present at its receipt index in the ${input.stage} canonical block.`,
    );
  }
  const contractAddress = receipt.contractAddress ? getAddress(receipt.contractAddress) : null;
  if (input.expectation.deploymentKind === "DEPLOYMENT") {
    const expected = input.expectation.expectedContractAddress ?? getContractAddress({
      from: input.expectation.from,
      nonce: BigInt(input.expectation.nonce),
    });
    if (!contractAddress || !sameAddress(contractAddress, expected)) {
      throw new Phase11DeploymentFinalityError(`CREATE address mismatch at ${input.stage} for step ${input.expectation.sequence}.`);
    }
  } else if (contractAddress !== null) {
    throw new Phase11DeploymentFinalityError(`Call step ${input.expectation.sequence} unexpectedly created a contract.`);
  }
  const observedAt = input.observedAt ?? new Date().toISOString();
  const evidence: Phase11CanonicalInclusion = {
    stage: input.stage,
    receiptStatus: "SUCCESS",
    blockNumber: receipt.blockNumber.toString(),
    blockHash: receipt.blockHash as Hex,
    transactionIndex: String(transactionIndex),
    contractAddress,
    finalityHeadBlockNumber: finalityHead.number.toString(),
    finalityHeadBlockHash: finalityHead.hash as Hex,
    observedAt,
  };
  if (input.stage === "SAFE_CANONICAL") return evidence as Phase11SafeInclusion;
  return evidence as Phase11FinalizedInclusion;
}

export async function waitForPhase11CanonicalInclusion(
  client: PublicClient,
  input: {
    expectation: Phase11FinalityExpectation;
    stage: "SAFE_CANONICAL";
    timeoutMs?: number;
    pollIntervalMs?: number;
    now?: () => number;
    sleep?: (milliseconds: number) => Promise<void>;
  },
): Promise<Phase11SafeInclusion>;
export async function waitForPhase11CanonicalInclusion(
  client: PublicClient,
  input: {
    expectation: Phase11FinalityExpectation;
    stage: "FINALIZED_CANONICAL";
    timeoutMs?: number;
    pollIntervalMs?: number;
    now?: () => number;
    sleep?: (milliseconds: number) => Promise<void>;
  },
): Promise<Phase11FinalizedInclusion>;
export async function waitForPhase11CanonicalInclusion(
  client: PublicClient,
  input: {
    expectation: Phase11FinalityExpectation;
    stage: Phase11FinalityStage;
    timeoutMs?: number;
    pollIntervalMs?: number;
    now?: () => number;
    sleep?: (milliseconds: number) => Promise<void>;
  },
): Promise<Phase11SafeInclusion | Phase11FinalizedInclusion> {
  const timeoutMs = input.timeoutMs ?? 120_000;
  const pollIntervalMs = input.pollIntervalMs ?? 1_000;
  const now = input.now ?? Date.now;
  const sleep = input.sleep ?? ((milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds)));
  const startedAt = now();
  let lastError: unknown = null;
  while (now() - startedAt <= timeoutMs) {
    try {
      if (input.stage === "SAFE_CANONICAL") {
        return await readPhase11CanonicalInclusion(client, {
          expectation: input.expectation,
          stage: "SAFE_CANONICAL",
        });
      }
      return await readPhase11CanonicalInclusion(client, {
        expectation: input.expectation,
        stage: "FINALIZED_CANONICAL",
      });
    } catch (error) {
      lastError = error;
      if (now() - startedAt >= timeoutMs) break;
      await sleep(pollIntervalMs);
    }
  }
  throw new Phase11DeploymentFinalityError(
    `${input.stage} inclusion was not established before timeout: ${errorMessage(lastError)}`,
  );
}

export function phase11FinalityExpectationFromIntent(
  intent: Phase11TransactionIntent,
  transactionHash: Hex,
): Phase11FinalityExpectation {
  const deploymentKind = intent.to === null ? "DEPLOYMENT" : "CALL";
  return {
    transactionHash,
    chainId: intent.chainId,
    from: intent.from,
    nonce: String(intent.nonce),
    to: intent.to,
    value: intent.value.toString(),
    calldataHash: keccak256(intent.data),
    sequence: intent.sequence,
    deploymentKind,
    expectedContractAddress: deploymentKind === "DEPLOYMENT"
      ? getContractAddress({ from: intent.from, nonce: BigInt(intent.nonce) })
      : null,
  };
}

export function phase11FinalityExpectationFromProvenance(input: {
  transactionHash: Hex;
  chainId: number;
  sequence: number;
  from: Address;
  nonce: string;
  to: Address | null;
  value: string;
  calldataHash: Hex;
  contractAddress: Address | null;
}): Phase11FinalityExpectation {
  const deploymentKind = input.to === null ? "DEPLOYMENT" : "CALL";
  return {
    transactionHash: input.transactionHash,
    chainId: input.chainId,
    sequence: input.sequence,
    from: input.from,
    nonce: input.nonce,
    to: input.to,
    value: input.value,
    calldataHash: input.calldataHash,
    deploymentKind,
    expectedContractAddress: deploymentKind === "DEPLOYMENT"
      ? getContractAddress({ from: input.from, nonce: BigInt(input.nonce) })
      : null,
  };
}

function sameAddress(left: string | null | undefined, right: string): boolean {
  return Boolean(left) && left!.toLowerCase() === right.toLowerCase();
}

function sameNullableAddress(left: string | null | undefined, right: string | null): boolean {
  if (left === null || left === undefined || right === null) return (left === null || left === undefined) && right === null;
  return left.toLowerCase() === right.toLowerCase();
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message.split("\n")[0] ?? error.name : String(error);
}
