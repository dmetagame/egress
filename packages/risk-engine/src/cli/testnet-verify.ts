import { createPublicClient, defineChain, http } from "viem";
import {
  attachTestnetDeploymentManifest,
  identifyExecutionEnvironment,
  loadTestnetDeploymentManifest,
  readExecutionStagingConfig,
} from "../index.js";

async function main(): Promise<void> {
  const {
    EGRESS_EXECUTION_PRIVATE_KEY: _privateKey,
    EGRESS_PHASE11_DEPLOYER_PRIVATE_KEY: _deployerPrivateKey,
    EGRESS_PHASE11_BORROWER_PRIVATE_KEY: _borrowerPrivateKey,
    EGRESS_PHASE11_RISK_ATTESTOR_PRIVATE_KEY: _riskAttestorPrivateKey,
    ...nonSecretEnvironment
  } = process.env;
  let config = readExecutionStagingConfig(nonSecretEnvironment);
  if (config.issues.length > 0) throw new Error(config.issues.join(" "));
  if (
    config.environment !== "TESTNET_WRITE" ||
    !config.rpcUrl ||
    config.chainId === null ||
    !config.testnetManifestPath ||
    !config.testnetManifestHash
  ) {
    throw new Error("Phase 11 verification requires a complete TESTNET_WRITE configuration.");
  }
  config = attachTestnetDeploymentManifest(
    config,
    await loadTestnetDeploymentManifest(config.testnetManifestPath, config.testnetManifestHash),
  );
  const resolvedConfig = config;
  if (!resolvedConfig.rpcUrl || resolvedConfig.chainId === null) {
    throw new Error("Resolved TESTNET_WRITE RPC configuration is incomplete.");
  }
  const chain = defineChain({
    id: resolvedConfig.chainId,
    name: "Egress X Layer testnet verification",
    nativeCurrency: { name: "OKB", symbol: "OKB", decimals: 18 },
    rpcUrls: { default: { http: [resolvedConfig.rpcUrl] } },
  });
  const client = createPublicClient({ chain, transport: http(resolvedConfig.rpcUrl) });
  const identity = await identifyExecutionEnvironment(client, resolvedConfig);
  const manifest = resolvedConfig.testnetDeployment!;
  process.stdout.write(`${JSON.stringify({
    status: "VERIFIED",
    environment: identity.environment,
    environmentId: manifest.environmentId,
    chainId: identity.chainId,
    deploymentBlockNumber: manifest.deploymentBlockNumber,
    deploymentBlockHash: manifest.deploymentBlockHash,
    manifestHash: manifest.manifestHash,
    egressContract: manifest.egressContract,
    keeper: manifest.keeper,
    policyId: manifest.scenario.policyId,
    policyRegistrationTransactionHash: manifest.scenario.policyRegistrationTransactionHash,
    liveMainnetExecution: "DISABLED",
  })}\n`);
}

await main();
