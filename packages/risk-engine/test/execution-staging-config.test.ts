import { readFileSync, readdirSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import {
  assertExecutionEnvironment,
  executionProtocolFromConfig,
  readLiveRuntimeConfig,
  readExecutionStagingConfig,
  XLAYER_MAINNET,
  XLAYER_TESTNET_CHAIN_ID,
  XLAYER_TESTNET_ENVIRONMENT_ID,
} from "../src/index.js";
import { createTestnetManifestFixture } from "./testnet-deployment-fixture.js";

const EGRESS = "0x3333333333333333333333333333333333333333";
const KEEPER = "0x2222222222222222222222222222222222222222";
const HASH = `0x${"77".repeat(32)}` as const;

function forkEnvironment(): Record<string, string> {
  return {
    EGRESS_EXECUTION_ENVIRONMENT: "FORK_WRITE",
    EGRESS_EXECUTION_RPC_URL: "http://127.0.0.1:8545",
    EGRESS_EXECUTION_CHAIN_ID: "196",
    EGRESS_EXECUTION_EGRESS_CONTRACT: EGRESS,
    EGRESS_EXECUTION_KEEPER_ADDRESS: KEEPER,
    EGRESS_EXECUTION_ANCHOR_BLOCK: XLAYER_MAINNET.forkBlock.toString(),
    EGRESS_EXECUTION_ANCHOR_BLOCK_HASH: HASH,
    EGRESS_EXECUTION_FORK_RUNTIME: "ANVIL",
    EGRESS_DATABASE_URL: "postgresql://egress:secret@example.invalid/egress",
  };
}

describe("Phase 9 execution configuration", () => {
  it("defaults to a disabled worker with no write capability", () => {
    const config = readExecutionStagingConfig({});
    expect(config.environment).toBe("DISABLED");
    expect(config.submissionEnabled).toBe(false);
    expect(config.protocol).toBeNull();
    expect(config.issues).toEqual([]);
  });

  it("accepts only an explicitly identified X Layer fork and keeps submission opt-in", () => {
    const config = readExecutionStagingConfig(forkEnvironment());
    expect(config.issues).toEqual([]);
    expect(config.environment).toBe("FORK_WRITE");
    expect(config.submissionEnabled).toBe(false);
    expect(config.protocol).toEqual(executionProtocolFromConfig(XLAYER_MAINNET));
    expect(() => assertExecutionEnvironment({
      config,
      observedChainId: 196,
      observedAnchorBlockHash: HASH,
      forkDetected: true,
    })).not.toThrow();
  });

  it("rejects LIVE_MAINNET_WRITE, ambiguous forks, and chain mismatches", () => {
    const live = readExecutionStagingConfig({ EGRESS_EXECUTION_ENVIRONMENT: "LIVE_MAINNET_WRITE" });
    expect(live.issues.join(" ")).toMatch(/unsupported.*disabled/i);

    const config = readExecutionStagingConfig(forkEnvironment());
    expect(() => assertExecutionEnvironment({
      config,
      observedChainId: 196,
      observedAnchorBlockHash: HASH,
      forkDetected: false,
    })).toThrow(/positively identified local Anvil fork/i);
    expect(() => assertExecutionEnvironment({
      config,
      observedChainId: 195,
      observedAnchorBlockHash: HASH,
      forkDetected: true,
    })).toThrow(/does not match|configured execution environment/i);
  });

  it("requires PostgreSQL and a complete explicit address book for testnet", () => {
    const missing = readExecutionStagingConfig({
      EGRESS_EXECUTION_ENVIRONMENT: "TESTNET_WRITE",
      EGRESS_EXECUTION_RPC_URL: "https://rpc.testnet.example",
      EGRESS_EXECUTION_CHAIN_ID: String(XLAYER_TESTNET_CHAIN_ID),
      EGRESS_EXECUTION_EGRESS_CONTRACT: EGRESS,
      EGRESS_EXECUTION_KEEPER_ADDRESS: KEEPER,
      EGRESS_EXECUTION_ANCHOR_BLOCK: "1",
      EGRESS_EXECUTION_ANCHOR_BLOCK_HASH: HASH,
    });
    expect(missing.issues).toEqual(expect.arrayContaining([
      expect.stringMatching(/EGRESS_DATABASE_URL/i),
      expect.stringMatching(/EGRESS_EXECUTION_AAVE_POOL/i),
      expect.stringMatching(/EGRESS_EXECUTION_SWAP_POOL/i),
    ]));
  });

  it("positively identifies only the explicitly configured non-mainnet testnet", () => {
    const manifest = createTestnetManifestFixture();
    const protocol = manifest.protocol;
    const environment = {
      EGRESS_EXECUTION_ENVIRONMENT: "TESTNET_WRITE",
      EGRESS_EXECUTION_RPC_URL: "https://rpc.testnet.example",
      EGRESS_EXECUTION_CHAIN_ID: String(XLAYER_TESTNET_CHAIN_ID),
      EGRESS_EXECUTION_EGRESS_CONTRACT: manifest.egressContract,
      EGRESS_EXECUTION_KEEPER_ADDRESS: manifest.keeper,
      EGRESS_EXECUTION_ANCHOR_BLOCK: manifest.deploymentBlockNumber,
      EGRESS_EXECUTION_ANCHOR_BLOCK_HASH: manifest.deploymentBlockHash,
      EGRESS_EXECUTION_ENVIRONMENT_ID: XLAYER_TESTNET_ENVIRONMENT_ID,
      EGRESS_EXECUTION_CREDENTIAL_REFERENCE: "secret://egress/testnet-worker",
      EGRESS_EXECUTION_TESTNET_MANIFEST_PATH: "./deployments/xlayer-testnet.json",
      EGRESS_EXECUTION_TESTNET_MANIFEST_HASH: manifest.manifestHash,
      EGRESS_DATABASE_URL: "postgresql://egress:secret@example.invalid/egress",
      EGRESS_EXECUTION_ADDRESSES_PROVIDER: protocol.addressesProvider,
      EGRESS_EXECUTION_AAVE_POOL: protocol.aavePool,
      EGRESS_EXECUTION_AAVE_ORACLE: protocol.aaveOracle,
      EGRESS_EXECUTION_XBETH: protocol.xbEth,
      EGRESS_EXECUTION_XETH: protocol.xeth,
      EGRESS_EXECUTION_A_XBETH: protocol.aXbEth,
      EGRESS_EXECUTION_VARIABLE_DEBT_XETH: protocol.variableDebtXeth,
      EGRESS_EXECUTION_UNISWAP_FACTORY: protocol.uniswapFactory,
      EGRESS_EXECUTION_SWAP_ROUTER: protocol.swapRouter,
      EGRESS_EXECUTION_QUOTER_V2: protocol.quoterV2,
      EGRESS_EXECUTION_SWAP_POOL: protocol.swapPool,
      EGRESS_EXECUTION_POOL_FEE: String(protocol.poolFee),
    };
    const config = readExecutionStagingConfig(environment);
    expect(config.issues).toEqual([]);
    expect(() => assertExecutionEnvironment({
      config: { ...config, testnetDeployment: manifest },
      observedChainId: XLAYER_TESTNET_CHAIN_ID,
      observedAnchorBlockHash: manifest.deploymentBlockHash,
      testnetConfigured: true,
    })).not.toThrow();
    expect(() => assertExecutionEnvironment({
      config,
      observedChainId: 1953,
      observedAnchorBlockHash: manifest.deploymentBlockHash,
      testnetConfigured: true,
    })).toThrow(/does not match/i);

    const mainnet = readExecutionStagingConfig({
      ...environment,
      EGRESS_EXECUTION_CHAIN_ID: "196",
    });
    expect(mainnet.issues).toContain(`TESTNET_WRITE must use X Layer testnet chain ${XLAYER_TESTNET_CHAIN_ID}.`);

    const otherChain = readExecutionStagingConfig({
      ...environment,
      EGRESS_EXECUTION_CHAIN_ID: "1",
    });
    expect(otherChain.issues).toContain(`TESTNET_WRITE must use X Layer testnet chain ${XLAYER_TESTNET_CHAIN_ID}.`);

    const localRpc = readExecutionStagingConfig({
      ...environment,
      EGRESS_EXECUTION_RPC_URL: "http://127.0.0.1:8545",
    });
    expect(localRpc.issues).toContain("TESTNET_WRITE requires a non-local HTTPS RPC endpoint.");
  });

  it("requires an explicit manifest identity and non-secret credential reference for TESTNET_WRITE", () => {
    const manifest = createTestnetManifestFixture();
    const base = {
      EGRESS_EXECUTION_ENVIRONMENT: "TESTNET_WRITE",
      EGRESS_EXECUTION_RPC_URL: "https://rpc.testnet.example",
      EGRESS_EXECUTION_CHAIN_ID: String(XLAYER_TESTNET_CHAIN_ID),
      EGRESS_EXECUTION_EGRESS_CONTRACT: manifest.egressContract,
      EGRESS_EXECUTION_KEEPER_ADDRESS: manifest.keeper,
      EGRESS_EXECUTION_ANCHOR_BLOCK: manifest.deploymentBlockNumber,
      EGRESS_EXECUTION_ANCHOR_BLOCK_HASH: manifest.deploymentBlockHash,
      EGRESS_DATABASE_URL: "postgresql://egress:secret@example.invalid/egress",
      EGRESS_EXECUTION_ADDRESSES_PROVIDER: manifest.protocol.addressesProvider,
      EGRESS_EXECUTION_AAVE_POOL: manifest.protocol.aavePool,
      EGRESS_EXECUTION_AAVE_ORACLE: manifest.protocol.aaveOracle,
      EGRESS_EXECUTION_XBETH: manifest.protocol.xbEth,
      EGRESS_EXECUTION_XETH: manifest.protocol.xeth,
      EGRESS_EXECUTION_A_XBETH: manifest.protocol.aXbEth,
      EGRESS_EXECUTION_VARIABLE_DEBT_XETH: manifest.protocol.variableDebtXeth,
      EGRESS_EXECUTION_UNISWAP_FACTORY: manifest.protocol.uniswapFactory,
      EGRESS_EXECUTION_SWAP_ROUTER: manifest.protocol.swapRouter,
      EGRESS_EXECUTION_QUOTER_V2: manifest.protocol.quoterV2,
      EGRESS_EXECUTION_SWAP_POOL: manifest.protocol.swapPool,
      EGRESS_EXECUTION_POOL_FEE: String(manifest.protocol.poolFee),
    };
    const missing = readExecutionStagingConfig(base);
    expect(missing.issues.join(" ")).toMatch(/environment_id|credential_reference|manifest_path|manifest_hash/i);

    const wrongIdentity = readExecutionStagingConfig({
      ...base,
      EGRESS_EXECUTION_ENVIRONMENT_ID: "xlayer-mainnet-196",
      EGRESS_EXECUTION_CREDENTIAL_REFERENCE: "secret://egress/testnet-worker",
      EGRESS_EXECUTION_TESTNET_MANIFEST_PATH: "./deployments/xlayer-testnet.json",
      EGRESS_EXECUTION_TESTNET_MANIFEST_HASH: manifest.manifestHash,
    });
    expect(wrongIdentity.issues).toContain(
      `TESTNET_WRITE requires EGRESS_EXECUTION_ENVIRONMENT_ID=${XLAYER_TESTNET_ENVIRONMENT_ID}.`,
    );
  });

  it("validates managed PostgreSQL configuration without opening a database connection", () => {
    const valid = readExecutionStagingConfig(forkEnvironment());
    expect(valid.databaseUrl).toBe("postgresql://egress:secret@example.invalid/egress");
    expect(valid.issues).toEqual([]);

    const invalid = readExecutionStagingConfig({
      ...forkEnvironment(),
      EGRESS_DATABASE_URL: "file:///tmp/egress.db",
    });
    expect(invalid.issues).toContain("EGRESS_DATABASE_URL must use the PostgreSQL URL scheme.");
  });

  it("rejects staging credentials in the observation runtime", () => {
    const config = readLiveRuntimeConfig({
      EGRESS_EXECUTION_PRIVATE_KEY: `0x${"11".repeat(32)}`,
      EGRESS_PHASE11_DEPLOYER_PRIVATE_KEY: `0x${"12".repeat(32)}`,
      EGRESS_PHASE11_BORROWER_PRIVATE_KEY: `0x${"13".repeat(32)}`,
      EGRESS_PHASE11_RISK_ATTESTOR_PRIVATE_KEY: `0x${"14".repeat(32)}`,
      UNEXPECTED_TESTNET_SIGNER_MNEMONIC: "do not inherit this value",
    });
    expect(config.issues).toContain(
      "EGRESS_EXECUTION_PRIVATE_KEY must not be present in the observation or web runtime.",
    );
    expect(config.issues).toEqual(expect.arrayContaining([
      expect.stringMatching(/PHASE11_DEPLOYER_PRIVATE_KEY/),
      expect.stringMatching(/PHASE11_BORROWER_PRIVATE_KEY/),
      expect.stringMatching(/PHASE11_RISK_ATTESTOR_PRIVATE_KEY/),
      expect.stringMatching(/UNEXPECTED_TESTNET_SIGNER_MNEMONIC/),
    ]));
  });

  it("keeps worker credentials out of observation code and public configuration", () => {
    const workerExample = readFileSync(resolve(process.cwd(), ".env.execution.example"), "utf8");
    expect(workerExample).toMatch(/^EGRESS_EXECUTION_PRIVATE_KEY=$/m);
    expect(workerExample).not.toMatch(/^NEXT_PUBLIC_.*(?:PRIVATE_KEY|SIGNER|MNEMONIC)=/m);

    const observationSources = [
      ...typescriptFiles(resolve(process.cwd(), "src/live")),
      resolve(process.cwd(), "src/cli/live-poll.ts"),
      resolve(process.cwd(), "../../apps/web/src/lib/server/live.ts"),
    ].map((path) => readFileSync(path, "utf8")).join("\n");
    expect(observationSources).not.toMatch(/privateKeyToAccount|createWalletClient|sendTransaction|writeContract/);
  });
});

function typescriptFiles(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = resolve(directory, entry.name);
    return entry.isDirectory()
      ? typescriptFiles(path)
      : /\.tsx?$/.test(entry.name) ? [path] : [];
  });
}
