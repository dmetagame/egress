import { createPublicClient, defineChain, http } from "viem";
import {
  persistPhase11ReconciliationArtifact,
  PHASE11_EXISTING_DEPLOYMENT_JOURNAL_SHA256,
  phase11DeploymentJournalPath,
  reconcilePhase11Deployment,
  XLAYER_TESTNET_CHAIN_ID,
} from "../index.js";
import { resolve } from "node:path";

async function main(): Promise<void> {
  const rpcUrl = requiredEnvironment("EGRESS_EXECUTION_RPC_URL");
  const manifestPath = resolve(
    process.env.EGRESS_PHASE11_MANIFEST_PATH?.trim() || "deployments/phase11/xlayer-testnet.json",
  );
  const journalPath = resolve(
    phase11DeploymentJournalPath(manifestPath, process.env.EGRESS_PHASE11_JOURNAL_PATH),
  );
  const artifactPath = resolve(
    process.env.EGRESS_PHASE11_RECONCILIATION_PATH?.trim() || `${journalPath}.reconciliation.json`,
  );
  const chain = defineChain({
    id: XLAYER_TESTNET_CHAIN_ID,
    name: "Egress X Layer testnet",
    nativeCurrency: { name: "OKB", symbol: "OKB", decimals: 18 },
    rpcUrls: { default: { http: [rpcUrl] } },
  });
  const client = createPublicClient({ chain, transport: http(rpcUrl) });
  const artifact = await reconcilePhase11Deployment({
    journalPath,
    rpcEndpoint: rpcUrl,
    client,
    expectedJournalSha256: PHASE11_EXISTING_DEPLOYMENT_JOURNAL_SHA256,
  });
  await persistPhase11ReconciliationArtifact(artifactPath, artifact);
  process.stdout.write(`${JSON.stringify({
    status: artifact.overallStatus,
    chainId: artifact.chainId,
    transactionCount: artifact.transactions.length,
    originalJournalPath: artifact.originalJournalPath,
    originalJournalSha256: artifact.originalJournalSha256,
    artifactPath,
    artifactHash: artifact.artifactHash,
    finalizedAnchorBlock: artifact.deploymentAnchor.finalizedBlockNumber,
    finalizedAnchorHash: artifact.deploymentAnchor.finalizedBlockHash,
  })}\n`);
}

function requiredEnvironment(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name} is required.`);
  return value;
}

main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  process.stderr.write(`${JSON.stringify({ status: "BLOCKED", error: message.replace(/https?:\/\/[^\s]+/g, "[redacted-rpc]") })}\n`);
  process.exitCode = 1;
});
