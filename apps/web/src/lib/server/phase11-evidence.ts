import "server-only";

import { cache } from "react";
import phase11ManifestJson from "../../../../../deployments/phase11/xlayer-testnet.json";

type ManifestTransaction = {
  sequence: number;
  actionId: string;
  transactionHash: string;
  nonce: string;
  from: string;
  to: string | null;
  calldataHash: string;
  initialInclusion: {
    blockNumber: string;
    blockHash: string;
    transactionIndex: string | null;
  };
  safeInclusion: {
    blockNumber: string;
    blockHash: string;
    transactionIndex: string | null;
  };
  finalizedInclusion: {
    blockNumber: string;
    blockHash: string;
    transactionIndex: string | null;
  };
  canonicalInclusionClass: string;
};

type Phase11Manifest = {
  schemaVersion: number;
  manifestType: string;
  environmentId: string;
  compatibilityLabel: string;
  chainId: number;
  deploymentId: string;
  finalityPolicy: {
    version: number;
    publication: string;
    safeTag: string;
    finalizedTag: string;
  };
  expectedTransactionCount: number;
  originalJournalSha256: string;
  reconciliationArtifactSha256: string;
  reconciliationArtifactInternalHash: string;
  manifestHash: string;
  deploymentBlockNumber: string;
  deploymentBlockHash: string;
  deploymentTransactions: ManifestTransaction[];
  egressContract: string;
  keeper: string;
  guardian: string;
  protocol: Record<string, string | number>;
  runtimeVerification: {
    status: string;
    verifiedTransactionCount: number;
    policyId: string;
    borrower: string;
    keeper: string;
    riskAttestor: string;
    policyActive: boolean;
    protocolRelationshipsVerified: boolean;
    tokenMetadataVerified: boolean;
    oracleStateVerified: boolean;
    verificationSource: string;
  };
  scenario: {
    policyRegistrationTransactionHash: string;
  };
};

export interface Phase11PublicEvidence {
  schemaVersion: number;
  manifestType: string;
  environmentId: string;
  compatibilityLabel: string;
  chainId: number;
  deploymentId: string;
  finalityPolicy: Phase11Manifest["finalityPolicy"];
  expectedTransactionCount: number;
  transactionCount: number;
  safeCanonicalCount: number;
  finalizedCanonicalCount: number;
  reIncludedSequences: number[];
  originalJournalSha256: string;
  reconciliationArtifactSha256: string;
  reconciliationArtifactInternalHash: string;
  manifestHash: string;
  deploymentAnchor: {
    transactionHash: string;
    blockNumber: string;
    blockHash: string;
  };
  egressContract: string;
  keeper: string;
  guardian: string;
  borrower: string;
  riskAttestor: string;
  policyId: string;
  policyRegistrationTransactionHash: string;
  protocol: Phase11Manifest["protocol"];
  runtimeVerification: Phase11Manifest["runtimeVerification"];
  transactions: Array<{
    sequence: number;
    actionId: string;
    transactionHash: string;
    nonce: string;
    initialUnsafeBlockNumber: string;
    initialUnsafeBlockHash: string;
    safeCanonicalBlockNumber: string;
    safeCanonicalBlockHash: string;
    finalizedCanonicalBlockNumber: string;
    finalizedCanonicalBlockHash: string;
    canonicalTransactionIndex: string | null;
    canonicalInclusionClass: string;
  }>;
}

const manifest = phase11ManifestJson as Phase11Manifest;

function buildEvidence(): Phase11PublicEvidence {
  if (
    manifest.schemaVersion !== 4 ||
    manifest.chainId !== 1952 ||
    manifest.expectedTransactionCount !== 26 ||
    manifest.finalityPolicy.publication !== "FINALIZED" ||
    manifest.runtimeVerification.status !== "PASS" ||
    manifest.runtimeVerification.verifiedTransactionCount !== 26 ||
    manifest.deploymentTransactions.length !== 26
  ) {
    throw new Error("Phase 11 manifest does not satisfy the public evidence contract.");
  }

  const ordered = [...manifest.deploymentTransactions].sort((left, right) => left.sequence - right.sequence);
  const anchor = ordered.at(-1)!;
  const transactions = ordered.map((transaction) => ({
    sequence: transaction.sequence,
    actionId: transaction.actionId,
    transactionHash: transaction.transactionHash,
    nonce: transaction.nonce,
    initialUnsafeBlockNumber: transaction.initialInclusion.blockNumber,
    initialUnsafeBlockHash: transaction.initialInclusion.blockHash,
    safeCanonicalBlockNumber: transaction.safeInclusion.blockNumber,
    safeCanonicalBlockHash: transaction.safeInclusion.blockHash,
    finalizedCanonicalBlockNumber: transaction.finalizedInclusion.blockNumber,
    finalizedCanonicalBlockHash: transaction.finalizedInclusion.blockHash,
    canonicalTransactionIndex: transaction.finalizedInclusion.transactionIndex,
    canonicalInclusionClass: transaction.canonicalInclusionClass,
  }));

  return {
    schemaVersion: manifest.schemaVersion,
    manifestType: manifest.manifestType,
    environmentId: manifest.environmentId,
    compatibilityLabel: manifest.compatibilityLabel,
    chainId: manifest.chainId,
    deploymentId: manifest.deploymentId,
    finalityPolicy: manifest.finalityPolicy,
    expectedTransactionCount: manifest.expectedTransactionCount,
    transactionCount: transactions.length,
    safeCanonicalCount: transactions.filter((transaction) => transaction.safeCanonicalBlockHash.length > 0).length,
    finalizedCanonicalCount: transactions.filter((transaction) => transaction.finalizedCanonicalBlockHash.length > 0).length,
    reIncludedSequences: transactions
      .filter((transaction) => transaction.canonicalInclusionClass.includes("REINCLUDED"))
      .map((transaction) => transaction.sequence),
    originalJournalSha256: manifest.originalJournalSha256,
    reconciliationArtifactSha256: manifest.reconciliationArtifactSha256,
    reconciliationArtifactInternalHash: manifest.reconciliationArtifactInternalHash,
    manifestHash: manifest.manifestHash,
    deploymentAnchor: {
      transactionHash: anchor.transactionHash,
      blockNumber: anchor.finalizedInclusion.blockNumber,
      blockHash: anchor.finalizedInclusion.blockHash,
    },
    egressContract: manifest.egressContract,
    keeper: manifest.keeper,
    guardian: manifest.guardian,
    borrower: manifest.runtimeVerification.borrower,
    riskAttestor: manifest.runtimeVerification.riskAttestor,
    policyId: manifest.runtimeVerification.policyId,
    policyRegistrationTransactionHash: manifest.scenario.policyRegistrationTransactionHash,
    protocol: manifest.protocol,
    runtimeVerification: manifest.runtimeVerification,
    transactions,
  };
}

export const getPhase11PublicEvidence = cache(async (): Promise<Phase11PublicEvidence> => buildEvidence());
