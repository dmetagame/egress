import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import type { Address, Hex, PublicClient } from "viem";
import {
  PHASE11_DEFAULT_EXECUTION_BOUNDS,
  PHASE11_EXISTING_RECONCILIATION_ARTIFACT_INTERNAL_HASH,
  PHASE11_EXISTING_RECONCILIATION_ARTIFACT_SHA256,
  PHASE11_MANIFEST_COMPATIBILITY_LABEL,
  buildPhase11ManifestFromEvidence,
  publishPhase11Manifest,
  sha256Bytes,
  verifyPhase11ManifestPublicationSources,
  type Phase11ManifestChainEvidence,
} from "../src/staging/testnet-deployment-publication.js";
import {
  PHASE11_EXISTING_DEPLOYMENT_JOURNAL_SHA256,
  validateLegacyPhase11DeploymentJournal,
  verifyPhase11ReconciliationArtifact,
  type OnchainProtectionPolicy,
  type TestnetDeploymentManifest,
} from "../src/index.js";

const REPOSITORY_ROOT = resolve("../..");
const JOURNAL_PATH = resolve(REPOSITORY_ROOT, "deployments/phase11/xlayer-testnet.json.journal.json");
const ARTIFACT_PATH = resolve(REPOSITORY_ROOT, "deployments/phase11/xlayer-testnet.json.journal.json.reconciliation.json");

describe("Phase 11 manifest publication evidence", () => {
  it("projects all 26 records while preserving unsafe and re-inclusion evidence", async () => {
    const { journal, artifact, journalSha256, artifactSha256 } = await loadEvidence();
    const manifest = buildPhase11ManifestFromEvidence({
      journal,
      artifact,
      journalPath: JOURNAL_PATH,
      artifactPath: ARTIFACT_PATH,
      journalSha256,
      artifactSha256,
      configuration: {
        compatibilityLabel: PHASE11_MANIFEST_COMPATIBILITY_LABEL,
        executionBounds: PHASE11_DEFAULT_EXECUTION_BOUNDS,
      },
      chainEvidence: chainEvidence(artifact),
      createdAt: "2026-08-19T00:00:00.000Z",
    });

    expect(manifest.schemaVersion).toBe(4);
    expect(manifest.deploymentTransactions).toHaveLength(26);
    expect(manifest.deploymentTransactions.map((record) => record.nonce)).toEqual(
      Array.from({ length: 26 }, (_, index) => String(index)),
    );
    expect(manifest.deploymentTransactions
      .filter((record) => record.canonicalInclusionClass === "REINCLUDED_AFTER_UNSAFE_REORG")
      .map((record) => record.sequence)).toEqual([3, 5, 10, 17, 18]);
    expect(manifest.deploymentTransactions[2]!.initialInclusion.blockHash)
      .not.toBe(manifest.deploymentTransactions[2]!.safeInclusion.blockHash);
    expect(manifest.deploymentTransactions[25]!.actionId).toBe("REGISTER_PROTECTION_POLICY");
    expect(manifest.deploymentTransactions[25]!.finalizedInclusion.blockHash)
      .toBe(artifact.deploymentAnchor.finalizedBlockHash);

    verifyPhase11ManifestPublicationSources({
      manifest,
      journal,
      artifact,
      journalPath: JOURNAL_PATH,
      artifactPath: ARTIFACT_PATH,
      journalSha256,
      artifactSha256,
    });
  });

  it("rejects a source digest mismatch before trusting publication evidence", async () => {
    const { journal, artifact, journalSha256, artifactSha256 } = await loadEvidence();
    const manifest = buildManifest(journal, artifact, journalSha256, artifactSha256);
    expect(() => verifyPhase11ManifestPublicationSources({
      manifest,
      journal,
      artifact,
      journalPath: JOURNAL_PATH,
      artifactPath: ARTIFACT_PATH,
      journalSha256: `sha256:${"00".repeat(32)}`,
      artifactSha256,
    })).toThrow(/source digests/i);
  });

  it("matches immutable sources by repository identity across checkout paths", async () => {
    const { journal, artifact, journalSha256, artifactSha256 } = await loadEvidence();
    const relocatedJournalPath = "/home/runner/work/egress/egress/deployments/phase11/xlayer-testnet.json.journal.json";
    const relocatedArtifactPath = "/home/runner/work/egress/egress/deployments/phase11/xlayer-testnet.json.journal.json.reconciliation.json";
    const manifest = buildManifest(
      journal,
      artifact,
      journalSha256,
      artifactSha256,
      relocatedJournalPath,
      relocatedArtifactPath,
    );

    expect(() => verifyPhase11ManifestPublicationSources({
      manifest,
      journal,
      artifact,
      journalPath: relocatedJournalPath,
      artifactPath: relocatedArtifactPath,
      journalSha256,
      artifactSha256,
    })).not.toThrow();

    expect(() => verifyPhase11ManifestPublicationSources({
      manifest,
      journal,
      artifact,
      journalPath: "/home/runner/work/egress/egress/deployments/phase11/wrong.json",
      artifactPath: relocatedArtifactPath,
      journalSha256,
      artifactSha256,
    })).toThrow(/path/i);
  });

  it("verifies the serialized schema-v4 manifest independently", async () => {
    const { journal, artifact, journalSha256, artifactSha256 } = await loadEvidence();
    const manifest = buildManifest(journal, artifact, journalSha256, artifactSha256);
    const serialized = `${JSON.stringify(manifest, null, 2)}\n`;
    const parsed = JSON.parse(serialized) as TestnetDeploymentManifest;
    expect(sha256Bytes(Buffer.from(serialized, "utf8"))).toMatch(/^sha256:[0-9a-f]{64}$/);
    verifyPhase11ManifestPublicationSources({
      manifest: parsed,
      journal,
      artifact,
      journalPath: JOURNAL_PATH,
      artifactPath: ARTIFACT_PATH,
      journalSha256,
      artifactSha256,
    });
    expect((await readFile(JOURNAL_PATH)).toString()).toContain('"schemaVersion": 2');
  });

  it("refuses an existing target without invoking the public client", async () => {
    const directory = await mkdtemp(join("/tmp", "egress-phase11-publication-"));
    const target = join(directory, "xlayer-testnet.json");
    await writeFile(target, "existing\n", { mode: 0o600 });
    try {
      const client = new Proxy({}, {
        get() {
          throw new Error("public client must not be called when target exists");
        },
      }) as PublicClient;
      await expect(publishPhase11Manifest({
        manifestPath: target,
        journalPath: JOURNAL_PATH,
        artifactPath: ARTIFACT_PATH,
        client,
      })).rejects.toThrow(/overwrite existing/i);
      expect((await readFile(target)).toString()).toBe("existing\n");
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("pins the preserved source hashes used by the authorized publication", async () => {
    const journalBytes = await readFile(JOURNAL_PATH);
    const artifactBytes = await readFile(ARTIFACT_PATH);
    expect(sha256Bytes(journalBytes)).toBe(PHASE11_EXISTING_DEPLOYMENT_JOURNAL_SHA256);
    expect(sha256Bytes(artifactBytes)).toBe(PHASE11_EXISTING_RECONCILIATION_ARTIFACT_SHA256);
    const artifact = verifyPhase11ReconciliationArtifact(JSON.parse(artifactBytes.toString("utf8")));
    expect(artifact.artifactHash).toBe(PHASE11_EXISTING_RECONCILIATION_ARTIFACT_INTERNAL_HASH);
  });
});

async function loadEvidence() {
  const journalBytes = await readFile(JOURNAL_PATH);
  const artifactBytes = await readFile(ARTIFACT_PATH);
  return {
    journal: validateLegacyPhase11DeploymentJournal(JSON.parse(journalBytes.toString("utf8"))),
    artifact: verifyPhase11ReconciliationArtifact(JSON.parse(artifactBytes.toString("utf8"))),
    journalSha256: sha256Bytes(journalBytes),
    artifactSha256: sha256Bytes(artifactBytes),
  };
}

function buildManifest(
  journal: Awaited<ReturnType<typeof validateLegacyPhase11DeploymentJournal>>,
  artifact: ReturnType<typeof verifyPhase11ReconciliationArtifact>,
  journalSha256: `sha256:${string}`,
  artifactSha256: `sha256:${string}`,
  journalPath = JOURNAL_PATH,
  artifactPath = ARTIFACT_PATH,
): TestnetDeploymentManifest {
  return buildPhase11ManifestFromEvidence({
    journal,
    artifact,
    journalPath,
    artifactPath,
    journalSha256,
    artifactSha256,
    configuration: {
      compatibilityLabel: PHASE11_MANIFEST_COMPATIBILITY_LABEL,
      executionBounds: PHASE11_DEFAULT_EXECUTION_BOUNDS,
    },
    chainEvidence: chainEvidence(artifact),
    createdAt: "2026-08-19T00:00:00.000Z",
  });
}

function chainEvidence(
  artifact: ReturnType<typeof verifyPhase11ReconciliationArtifact>,
): Phase11ManifestChainEvidence {
  const addresses = artifact.runtimeVerification.contractAddresses;
  const protocol = {
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
  const codeHash = `0x${"11".repeat(32)}` as Hex;
  const policy: OnchainProtectionPolicy = {
    user: artifact.runtimeVerification.borrower,
    keeper: artifact.runtimeVerification.keeper,
    riskAttestor: artifact.runtimeVerification.riskAttestor,
    protocolConfigHash: artifact.runtimeVerification.protocolConfigHash,
    minimumRiskLevel: 3,
    maxRepaymentPerExecution: PHASE11_DEFAULT_EXECUTION_BOUNDS.maxRepaymentPerExecution,
    maxCollateralPerExecution: PHASE11_DEFAULT_EXECUTION_BOUNDS.maxCollateralPerExecution,
    maxCumulativeRepayment: PHASE11_DEFAULT_EXECUTION_BOUNDS.maxCumulativeRepayment,
    maxCumulativeCollateral: PHASE11_DEFAULT_EXECUTION_BOUNDS.maxCumulativeCollateral,
    maxCollateralPercentageBps: PHASE11_DEFAULT_EXECUTION_BOUNDS.maxCollateralPercentageBps,
    maxPositionDebt: PHASE11_DEFAULT_EXECUTION_BOUNDS.maxPositionDebt,
    maxSlippageBps: PHASE11_DEFAULT_EXECUTION_BOUNDS.maxSlippageBps,
    maxOracleDeviationBps: PHASE11_DEFAULT_EXECUTION_BOUNDS.maxOracleDeviationBps,
    maxFlashLoanPremiumBps: PHASE11_DEFAULT_EXECUTION_BOUNDS.maxFlashLoanPremiumBps,
    maxPreHealthFactor: PHASE11_DEFAULT_EXECUTION_BOUNDS.maxPreHealthFactor,
    minPostHealthFactor: PHASE11_DEFAULT_EXECUTION_BOUNDS.minPostHealthFactor,
    cooldownSeconds: PHASE11_DEFAULT_EXECUTION_BOUNDS.minCooldownSeconds,
    maxExecutions: PHASE11_DEFAULT_EXECUTION_BOUNDS.maxExecutions,
    maxRiskAgeSeconds: PHASE11_DEFAULT_EXECUTION_BOUNDS.maxRiskAgeSeconds,
    maxClockSkewSeconds: PHASE11_DEFAULT_EXECUTION_BOUNDS.maxClockSkewSeconds,
    expiresAt: "1789603092",
    nonce: "11001",
    revocationNonce: "0",
  };
  return {
    protocol,
    protocolConfigHash: artifact.runtimeVerification.protocolConfigHash as Hex,
    oracleSources: { xbEth: protocol.aaveOracle, xeth: protocol.aaveOracle },
    runtimeCodeHashes: {
      egressContract: codeHash,
      addressesProvider: codeHash,
      aavePool: codeHash,
      aaveOracle: codeHash,
      xbEthOracleSource: codeHash,
      xethOracleSource: codeHash,
      xbEth: codeHash,
      xeth: codeHash,
      aXbEth: codeHash,
      variableDebtXeth: codeHash,
      uniswapFactory: codeHash,
      swapRouter: codeHash,
      quoterV2: codeHash,
      swapPool: codeHash,
    },
    tokens: {
      xbEth: { address: protocol.xbEth, name: "Egress Testnet xBETH", symbol: "txBETH", decimals: 18 },
      xeth: { address: protocol.xeth, name: "Egress Testnet xETH", symbol: "txETH", decimals: 18 },
      aXbEth: { address: protocol.aXbEth, name: "Egress Testnet Aave xBETH", symbol: "atxBETH", decimals: 18 },
      variableDebtXeth: { address: protocol.variableDebtXeth, name: "Egress Testnet Variable Debt xETH", symbol: "variableDebtTxETH", decimals: 18 },
    },
    policy,
    initialCollateralWei: "50000000000000000000",
    initialDebtWei: "44000000000000000000",
  };
}
