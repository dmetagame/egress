import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import {
  assertPhase11TestnetHarnessConfig,
  readPhase11TestnetHarnessConfig,
} from "../src/index.js";
import { createTestnetManifestFixture } from "./testnet-deployment-fixture.js";

describe("Phase 11 X Layer testnet harness configuration", () => {
  it("accepts distinct database roles and keeps secret material out of the returned config", () => {
    const manifest = createTestnetManifestFixture();
    const config = readPhase11TestnetHarnessConfig({
      EGRESS_EXECUTION_ENVIRONMENT: "TESTNET_WRITE",
      EGRESS_EXECUTION_SUBMISSION_ENABLED: "true",
      EGRESS_EXECUTION_RPC_URL: "https://testrpc.xlayer.tech/terigon",
      EGRESS_EXECUTION_CHAIN_ID: "1952",
      EGRESS_EXECUTION_ENVIRONMENT_ID: "xlayer-testnet-1952",
      EGRESS_EXECUTION_CREDENTIAL_REFERENCE: "secret://egress/xlayer-testnet-keeper-v1",
      EGRESS_EXECUTION_TESTNET_MANIFEST_PATH: "/srv/egress/xlayer-testnet.json",
      EGRESS_EXECUTION_TESTNET_MANIFEST_HASH: manifest.manifestHash,
      EGRESS_PHASE11_ARCHIVE_DATABASE_URL: "postgresql://archive:secret@example.invalid/egress_phase11",
      EGRESS_DATABASE_URL: "postgresql://worker:secret@example.invalid/egress_phase11",
      EGRESS_EXECUTION_PRIVATE_KEY: `0x${"11".repeat(32)}`,
      LIVE_MAINNET_BROADCAST: "false",
    });
    expect(config.issues).toEqual([]);
    expect(config.privateKeyConfigured).toBe(true);
    expect(config).not.toHaveProperty("privateKey");
    expect(() => assertPhase11TestnetHarnessConfig(config)).not.toThrow();
  });

  it("allows a simulation-only run without a keeper private key", () => {
    const manifest = createTestnetManifestFixture();
    const config = readPhase11TestnetHarnessConfig({
      EGRESS_EXECUTION_ENVIRONMENT: "TESTNET_WRITE",
      EGRESS_EXECUTION_SUBMISSION_ENABLED: "false",
      EGRESS_EXECUTION_RPC_URL: "https://testrpc.xlayer.tech/terigon",
      EGRESS_EXECUTION_CHAIN_ID: "1952",
      EGRESS_EXECUTION_ENVIRONMENT_ID: "xlayer-testnet-1952",
      EGRESS_EXECUTION_CREDENTIAL_REFERENCE: "secret://egress/xlayer-testnet-keeper-v1",
      EGRESS_EXECUTION_TESTNET_MANIFEST_PATH: "/srv/egress/xlayer-testnet.json",
      EGRESS_EXECUTION_TESTNET_MANIFEST_HASH: manifest.manifestHash,
      EGRESS_PHASE11_ARCHIVE_DATABASE_URL: "postgresql://archive:secret@example.invalid/egress_phase11",
      EGRESS_DATABASE_URL: "postgresql://worker:secret@example.invalid/egress_phase11",
      LIVE_MAINNET_BROADCAST: "false",
    });
    expect(config.issues).toEqual([]);
    expect(config.privateKeyConfigured).toBe(false);
    expect(() => assertPhase11TestnetHarnessConfig(config)).not.toThrow();
  });

  it("rejects mainnet, local or HTTP RPCs, missing signer, shared database roles, and public credentials", () => {
    const config = readPhase11TestnetHarnessConfig({
      EGRESS_EXECUTION_ENVIRONMENT: "TESTNET_WRITE",
      EGRESS_EXECUTION_SUBMISSION_ENABLED: "true",
      EGRESS_EXECUTION_RPC_URL: "http://127.0.0.1:8545",
      EGRESS_EXECUTION_CHAIN_ID: "196",
      EGRESS_EXECUTION_ENVIRONMENT_ID: "xlayer-mainnet-196",
      EGRESS_EXECUTION_CREDENTIAL_REFERENCE: "secret://egress/testnet",
      EGRESS_EXECUTION_TESTNET_MANIFEST_PATH: "/tmp/manifest.json",
      EGRESS_EXECUTION_TESTNET_MANIFEST_HASH: `0x${"22".repeat(32)}`,
      EGRESS_PHASE11_ARCHIVE_DATABASE_URL: "postgresql://shared:secret@example.invalid/egress",
      EGRESS_DATABASE_URL: "postgresql://shared:other@example.invalid/egress",
      EGRESS_PHASE11_DEPLOYER_PRIVATE_KEY: `0x${"33".repeat(32)}`,
      NEXT_PUBLIC_EXECUTION_PRIVATE_KEY: "forbidden",
      LIVE_MAINNET_BROADCAST: "true",
    });
    expect(config.issues.join(" ")).toMatch(/disabled|chain 1952|non-local HTTPS|deployer|private key|distinct|NEXT_PUBLIC/i);
    expect(() => assertPhase11TestnetHarnessConfig(config)).toThrow();
  });

  it("keeps policy registration in deployment and out of the simulation/submission runner", () => {
    const deployment = readFileSync(resolve(process.cwd(), "../../scripts/phase11-deploy.ts"), "utf8");
    const runner = readFileSync(resolve(process.cwd(), "../../scripts/phase11-testnet.ts"), "utf8");
    expect(deployment).toMatch(/registerProtectionPolicy/);
    expect(deployment).toMatch(/persistNewPhase11DeploymentJournal/);
    expect(deployment).toMatch(/verifyTestnetDeploymentRuntime/);
    expect(deployment).not.toMatch(/deploymentTransactionHashes/);
    expect(runner).not.toMatch(/registerProtectionPolicy/);
    expect(runner).not.toMatch(/\.writeContract\(/);
  });
});
