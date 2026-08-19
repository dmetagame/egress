import { resolve } from "node:path";
import { createPublicClient, defineChain, http } from "viem";
import {
  PHASE11_DEFAULT_EXECUTION_BOUNDS,
  PHASE11_EXISTING_RECONCILIATION_ARTIFACT_INTERNAL_HASH,
  PHASE11_EXISTING_RECONCILIATION_ARTIFACT_SHA256,
  PHASE11_MANIFEST_COMPATIBILITY_LABEL,
  publishPhase11Manifest,
} from "../staging/testnet-deployment-publication.js";
import { phase11DeploymentJournalPath } from "../staging/testnet-deployment-journal.js";
import { PHASE11_EXISTING_DEPLOYMENT_JOURNAL_SHA256 } from "../staging/testnet-deployment-reconciliation.js";
import {
  testnetExecutionBoundsSchema,
  XLAYER_TESTNET_CHAIN_ID,
  XLAYER_TESTNET_PUBLIC_RPC,
} from "../staging/testnet-deployment.js";

async function main(): Promise<void> {
  assertNoPrivateKeys(process.env);
  const rpcUrl = requiredReadOnlyRpc("EGRESS_EXECUTION_RPC_URL");
  const manifestPath = resolve(
    process.env.EGRESS_PHASE11_MANIFEST_PATH?.trim() || "deployments/phase11/xlayer-testnet.json",
  );
  const journalPath = resolve(
    phase11DeploymentJournalPath(manifestPath, process.env.EGRESS_PHASE11_JOURNAL_PATH),
  );
  const artifactPath = resolve(
    process.env.EGRESS_PHASE11_RECONCILIATION_PATH?.trim() || `${journalPath}.reconciliation.json`,
  );
  const compatibilityLabel = process.env.EGRESS_PHASE11_COMPATIBILITY_LABEL?.trim() ||
    PHASE11_MANIFEST_COMPATIBILITY_LABEL;
  const executionBounds = process.env.EGRESS_PHASE11_EXECUTION_BOUNDS_JSON?.trim()
    ? testnetExecutionBoundsSchema.parse(JSON.parse(process.env.EGRESS_PHASE11_EXECUTION_BOUNDS_JSON))
    : PHASE11_DEFAULT_EXECUTION_BOUNDS;
  const chain = defineChain({
    id: XLAYER_TESTNET_CHAIN_ID,
    name: "Egress X Layer testnet manifest publication",
    nativeCurrency: { name: "OKB", symbol: "OKB", decimals: 18 },
    rpcUrls: { default: { http: [rpcUrl] } },
  });
  const client = createPublicClient({ chain, transport: http(rpcUrl) });
  const result = await publishPhase11Manifest({
    manifestPath,
    journalPath,
    artifactPath,
    client,
    configuration: { compatibilityLabel, executionBounds },
    expectedJournalSha256: PHASE11_EXISTING_DEPLOYMENT_JOURNAL_SHA256,
    expectedArtifactSha256: PHASE11_EXISTING_RECONCILIATION_ARTIFACT_SHA256,
    expectedArtifactInternalHash: PHASE11_EXISTING_RECONCILIATION_ARTIFACT_INTERNAL_HASH,
  });
  process.stdout.write(`${JSON.stringify({
    status: "PASS",
    manifestPath,
    schemaVersion: result.manifest.schemaVersion,
    manifestHash: result.manifest.manifestHash,
    manifestSha256: result.manifestSha256,
    journalSha256: result.journalSha256,
    reconciliationArtifactSha256: result.artifactSha256,
    reconciliationArtifactInternalHash: result.artifactInternalHash,
    transactionCount: result.manifest.deploymentTransactions.length,
    safeCanonicalCount: result.manifest.deploymentTransactions.filter((record) => record.safeInclusion.stage === "SAFE_CANONICAL").length,
    finalizedCanonicalCount: result.manifest.deploymentTransactions.filter((record) => record.finalizedInclusion.stage === "FINALIZED_CANONICAL").length,
    reIncludedTransactions: result.manifest.deploymentTransactions
      .filter((record) => record.canonicalInclusionClass === "REINCLUDED_AFTER_UNSAFE_REORG")
      .map((record) => record.sequence),
    deploymentAnchor: result.manifest.deploymentBlockHash,
    policyRegistrationTransactionHash: result.manifest.scenario.policyRegistrationTransactionHash,
    runtimeVerification: result.runtimeVerification,
    blockchainWrites: "NONE",
  })}\n`);
}

function requiredReadOnlyRpc(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name} is required.`);
  const url = new URL(value);
  if (url.protocol !== "https:" || url.username || url.password || ["localhost", "127.0.0.1", "::1"].includes(url.hostname)) {
    throw new Error(`${name} must be a credential-free, non-local HTTPS X Layer testnet endpoint.`);
  }
  const normalized = `${url.protocol}//${url.host}${url.pathname}`.replace(/\/$/, "");
  const approved = `${new URL(XLAYER_TESTNET_PUBLIC_RPC).protocol}//${new URL(XLAYER_TESTNET_PUBLIC_RPC).host}${new URL(XLAYER_TESTNET_PUBLIC_RPC).pathname}`.replace(/\/$/, "");
  if (normalized !== approved) throw new Error(`${name} is not the repository-approved X Layer testnet RPC endpoint.`);
  return value;
}

function assertNoPrivateKeys(environment: Readonly<Partial<NodeJS.ProcessEnv>>): void {
  const keyNames = Object.keys(environment).filter((name) => /PRIVATE_KEY|SEED|MNEMONIC/i.test(name));
  if (keyNames.length > 0) {
    throw new Error("Manifest publication requires an environment with no private-key, seed, or mnemonic variables.");
  }
}

main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  process.stderr.write(`${JSON.stringify({ status: "BLOCKED", error: redact(message) })}\n`);
  process.exitCode = 1;
});

function redact(value: string): string {
  return value
    .replace(/https?:\/\/[^\s"']+/g, "[redacted-rpc]")
    .replace(/postgres(?:ql)?:\/\/[^\s"']+/gi, "[redacted-database]")
    .replace(/0x[0-9a-fA-F]{64}/g, "[redacted-hex32]");
}
