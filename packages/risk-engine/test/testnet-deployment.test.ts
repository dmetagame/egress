import { getAddress, type Address, type Hex, type PublicClient } from "viem";
import { describe, expect, it } from "vitest";
import {
  createTestnetDeploymentManifest,
  assertTestnetManifestMatchesConfiguration,
  testnetPolicyBoundViolations,
  verifyTestnetDeploymentManifest,
  verifyTestnetDeploymentRuntime,
  type TestnetDeploymentManifest,
  type TestnetDeploymentManifestPayload,
} from "../src/index.js";
import {
  TESTNET_ADDRESSES,
  TESTNET_BLOCK_HASH,
  TESTNET_BLOCK_NUMBER,
  TESTNET_BYTECODE,
  createLegacyTwoTransactionManifestFixture,
  createTestnetManifestFixture,
  testnetTransactionInput,
} from "./testnet-deployment-fixture.js";

describe("Phase 11 testnet deployment identity", () => {
  it("content-addresses the complete deployment manifest and rejects tampering", () => {
    const manifest = createTestnetManifestFixture();
    const payload = manifestPayload(manifest);
    expect(() => createTestnetDeploymentManifest({
      ...payload,
      keeper: payload.guardian,
    })).toThrow(/deployer and keeper identities must be distinct/i);
    expect(verifyTestnetDeploymentManifest(manifest, manifest.manifestHash)).toEqual(manifest);
    expect(() => verifyTestnetDeploymentManifest({
      ...manifest,
      keeper: manifest.guardian,
    }, manifest.manifestHash)).toThrow(/deployer and keeper identities must be distinct/i);
    expect(() => verifyTestnetDeploymentManifest({
      ...manifest,
      keeper: TESTNET_ADDRESSES.egressContract,
    }, manifest.manifestHash)).toThrow(/configuration hash|integrity/i);
    expect(() => verifyTestnetDeploymentManifest(manifest, `0x${"99".repeat(32)}`)).toThrow(/manifest_hash/i);
  });

  it("requires the exact 26-step action, sender, nonce, target, address, block, and hash provenance", () => {
    const manifest = createTestnetManifestFixture();
    expect(manifest.deploymentTransactions).toHaveLength(26);
    expect(manifest.deploymentTransactions.map((record) => record.sequence)).toEqual(
      Array.from({ length: 26 }, (_, index) => index + 1),
    );
    expect(manifest.deploymentTransactions[25]).toMatchObject({
      actionId: "REGISTER_PROTECTION_POLICY",
      transactionHash: manifest.scenario.policyRegistrationTransactionHash,
      finalizedInclusion: {
        blockNumber: manifest.deploymentBlockNumber,
        blockHash: manifest.deploymentBlockHash,
      },
    });

    expectInvalidProvenance(manifest, (payload) => {
      payload.deploymentTransactions[1]!.transactionHash = payload.deploymentTransactions[0]!.transactionHash;
    }, /duplicate transaction hashes/i);
    expectInvalidProvenance(manifest, (payload) => {
      delete (payload.deploymentTransactions[4] as { transactionHash?: Hex }).transactionHash;
    }, /transactionHash|invalid_type/i);
    expectInvalidProvenance(manifest, (payload) => {
      delete (payload.deploymentTransactions[4]!.finalizedInclusion as { blockHash?: Hex }).blockHash;
    }, /blockHash|invalid_type/i);
    expectInvalidProvenance(manifest, (payload) => {
      payload.deploymentTransactions[4]!.finalizedInclusion.blockHash = "0x1234" as Hex;
    }, /blockHash|invalid_string|invalid_format/i);
    expectInvalidProvenance(manifest, (payload) => {
      payload.deploymentTransactions = payload.deploymentTransactions.slice(0, 25);
    }, /26|too_small/i);
    expectInvalidProvenance(manifest, (payload) => {
      [payload.deploymentTransactions[0], payload.deploymentTransactions[1]] = [
        payload.deploymentTransactions[1]!,
        payload.deploymentTransactions[0]!,
      ];
    }, /step 1|DEPLOY_XBETH/i);
    expectInvalidProvenance(manifest, (payload) => {
      payload.deploymentTransactions[7]!.actionId = "CONFIGURE_POOL_RESERVES";
    }, /step 8|CONFIGURE_PROVIDER/i);
    expectInvalidProvenance(manifest, (payload) => {
      payload.deploymentTransactions[8]!.from = TESTNET_ADDRESSES.keeper;
    }, /identity is inconsistent at step 9/i);
    expectInvalidProvenance(manifest, (payload) => {
      payload.deploymentTransactions[8]!.chainId = 196;
    }, /identity is inconsistent at step 9/i);
    expectInvalidProvenance(manifest, (payload) => {
      payload.deploymentTransactions[9]!.nonce = "999";
    }, /nonce is inconsistent at step 10/i);
    expectInvalidProvenance(manifest, (payload) => {
      payload.deploymentTransactions[7]!.to = TESTNET_ADDRESSES.keeper;
    }, /call target is inconsistent at step 8/i);
    expectInvalidProvenance(manifest, (payload) => {
      payload.deploymentTransactions[0]!.contractAddress = null;
    }, /contract address is inconsistent at step 1/i);
    expectInvalidProvenance(manifest, (payload) => {
      payload.deploymentTransactions[10]!.safeInclusion.blockNumber = "1";
      payload.deploymentTransactions[10]!.finalizedInclusion.blockNumber = "1";
      payload.deploymentTransactions[10]!.canonicalInclusionClass = "REINCLUDED_AFTER_UNSAFE_REORG";
    }, /blocks are out of order at step 11/i);
    expectInvalidProvenance(manifest, (payload) => {
      payload.deploymentTransactions[1]!.safeInclusion.blockNumber = payload.deploymentTransactions[0]!.finalizedInclusion.blockNumber;
      payload.deploymentTransactions[1]!.finalizedInclusion.blockNumber = payload.deploymentTransactions[0]!.finalizedInclusion.blockNumber;
      payload.deploymentTransactions[1]!.canonicalInclusionClass = "REINCLUDED_AFTER_UNSAFE_REORG";
    }, /block hash is inconsistent at step 2/i);
    expectInvalidProvenance(manifest, (payload) => {
      payload.deploymentTransactions[25]!.safeInclusion.blockHash = `0x${"98".repeat(32)}`;
      payload.deploymentTransactions[25]!.finalizedInclusion.blockHash = `0x${"98".repeat(32)}`;
      payload.deploymentTransactions[25]!.canonicalInclusionClass = "REINCLUDED_AFTER_UNSAFE_REORG";
    }, /policy registration must be the final/i);
    expectInvalidProvenance(manifest, (payload) => {
      payload.scenario.policyRegistrationTransactionHash = payload.deploymentTransactions[24]!.transactionHash;
    }, /policy registration must be the final/i);
  });

  it("rejects inconsistent deployment, network, environment, and configuration identities", () => {
    const manifest = createTestnetManifestFixture();
    expectInvalidProvenance(manifest, (payload) => {
      payload.deploymentId = `0x${"81".repeat(32)}`;
    }, /deployment ID is inconsistent/i);
    expectInvalidProvenance(manifest, (payload) => {
      payload.deploymentTransactions[5]!.deploymentId = `0x${"82".repeat(32)}`;
    }, /identity is inconsistent at step 6/i);
    expectInvalidProvenance(manifest, (payload) => {
      payload.configurationHash = `0x${"83".repeat(32)}`;
    }, /configuration hash is inconsistent/i);
    expectInvalidProvenance(manifest, (payload) => {
      (payload as { chainId: number }).chainId = 196;
    }, /1952|invalid input/i);
    expectInvalidProvenance(manifest, (payload) => {
      (payload as { environmentId: string }).environmentId = "xlayer-mainnet-196";
    }, /xlayer-testnet-1952|invalid input/i);
  });

  it("rejects the legacy two-transaction fixture as a production manifest", () => {
    expect(() => verifyTestnetDeploymentManifest(createLegacyTwoTransactionManifestFixture())).toThrow();
  });

  it("rejects the previous complete manifest schema without block-hash provenance", () => {
    const legacy = structuredClone(createTestnetManifestFixture()) as unknown as {
      schemaVersion: number;
      deploymentTransactions: Array<{ finalizedInclusion?: { blockHash?: Hex } }>;
    };
    legacy.schemaVersion = 3;
    for (const record of legacy.deploymentTransactions) delete record.finalizedInclusion;
    expect(() => verifyTestnetDeploymentManifest(legacy)).toThrow(/finalizedInclusion|schemaVersion|invalid/i);
  });

  it("requires configuration to match the environment, anchor, addresses, keeper, and manifest hash", () => {
    const manifest = createTestnetManifestFixture();
    expect(() => assertTestnetManifestMatchesConfiguration({
      manifest,
      config: configurationIdentity(manifest),
    })).not.toThrow();
    expect(() => assertTestnetManifestMatchesConfiguration({
      manifest,
      config: { ...configurationIdentity(manifest), chainId: 196 },
    })).toThrow(/chain ID/i);
    expect(() => assertTestnetManifestMatchesConfiguration({
      manifest,
      config: { ...configurationIdentity(manifest), keeperAddress: TESTNET_ADDRESSES.guardian },
    })).toThrow(/keeper/i);
  });

  it("positively verifies transaction provenance, bytecode, Egress immutables, protocol links, oracle prices, and token identity", async () => {
    const manifest = createTestnetManifestFixture();
    const result = await verifyTestnetDeploymentRuntime(runtimeClient(manifest), {
      manifest,
      config: configurationIdentity(manifest),
    });
    expect(result).toMatchObject({
      chainId: 1952,
      environmentId: "xlayer-testnet-1952",
      manifestHash: manifest.manifestHash,
      egressContract: manifest.egressContract,
      keeper: getAddress(manifest.keeper),
      policyId: manifest.scenario.policyId,
      verifiedTransactionCount: manifest.deploymentTransactions.length,
    });
    expect(Object.keys(result.verifiedCodeHashes)).toHaveLength(14);
  });

  it("fails closed on wrong transaction evidence, chain, code, contract links, metadata, policy, or receipts", async () => {
    const manifest = createTestnetManifestFixture();
    await expectRuntimeFailure(manifest, { chainId: 196 }, /expected 1952/i);
    await expectRuntimeFailure(manifest, { changedTransactionInputAt: 12 }, /transaction does not match provenance at step 12/i);
    await expectRuntimeFailure(manifest, { changedTransactionNonceAt: 13 }, /transaction does not match provenance at step 13/i);
    await expectRuntimeFailure(manifest, { changedReceiptBlockHashAt: 14 }, /receipt does not match provenance at step 14/i);
    await expectRuntimeFailure(manifest, { missingCodeAddress: manifest.protocol.swapPool }, /missing runtime bytecode/i);
    await expectRuntimeFailure(manifest, { changedCodeAddress: manifest.protocol.swapRouter }, /bytecode hash mismatch/i);
    await expectRuntimeFailure(manifest, { wrongRouterFactory: TESTNET_ADDRESSES.guardian }, /relationships/i);
    await expectRuntimeFailure(manifest, { wrongTokenSymbol: "WRONG" }, /token identity/i);
    await expectRuntimeFailure(manifest, { inactivePolicy: true }, /policy/i);
    await expectRuntimeFailure(manifest, { failedReceipt: true }, /deployment receipt|deployment transactions/i);
  });

  it("rejects signed policies broader than independently pinned testnet bounds", () => {
    const manifest = createTestnetManifestFixture();
    const policy = {
      minimumRiskLevel: 3,
      maxRepaymentPerExecution: manifest.executionBounds.maxRepaymentPerExecution,
      maxCollateralPerExecution: manifest.executionBounds.maxCollateralPerExecution,
      maxCumulativeRepayment: manifest.executionBounds.maxCumulativeRepayment,
      maxCumulativeCollateral: manifest.executionBounds.maxCumulativeCollateral,
      maxCollateralPercentageBps: manifest.executionBounds.maxCollateralPercentageBps,
      maxPositionDebt: manifest.executionBounds.maxPositionDebt,
      maxSlippageBps: manifest.executionBounds.maxSlippageBps,
      maxOracleDeviationBps: manifest.executionBounds.maxOracleDeviationBps,
      maxFlashLoanPremiumBps: manifest.executionBounds.maxFlashLoanPremiumBps,
      maxPreHealthFactor: manifest.executionBounds.maxPreHealthFactor,
      minPostHealthFactor: manifest.executionBounds.minPostHealthFactor,
      cooldownSeconds: manifest.executionBounds.minCooldownSeconds,
      maxExecutions: manifest.executionBounds.maxExecutions,
      maxRiskAgeSeconds: manifest.executionBounds.maxRiskAgeSeconds,
      maxClockSkewSeconds: manifest.executionBounds.maxClockSkewSeconds,
    };
    expect(testnetPolicyBoundViolations(policy, manifest.executionBounds)).toEqual([]);
    expect(testnetPolicyBoundViolations({
      ...policy,
      maxRepaymentPerExecution: (BigInt(policy.maxRepaymentPerExecution) + 1n).toString(),
      minPostHealthFactor: (BigInt(policy.minPostHealthFactor) - 1n).toString(),
    }, manifest.executionBounds)).toEqual(expect.arrayContaining([
      "maxRepaymentPerExecution",
      "minPostHealthFactor",
    ]));
  });
});

function manifestPayload(manifest: TestnetDeploymentManifest): TestnetDeploymentManifestPayload {
  const { manifestHash: _manifestHash, ...payload } = structuredClone(manifest);
  return payload;
}

function expectInvalidProvenance(
  manifest: TestnetDeploymentManifest,
  mutate: (payload: TestnetDeploymentManifestPayload) => void,
  message: RegExp,
): void {
  const payload = manifestPayload(manifest);
  mutate(payload);
  expect(() => createTestnetDeploymentManifest(payload)).toThrow(message);
}

function configurationIdentity(manifest: TestnetDeploymentManifest) {
  return {
    environmentId: manifest.environmentId,
    manifestHash: manifest.manifestHash,
    chainId: manifest.chainId,
    anchorBlockNumber: BigInt(manifest.deploymentBlockNumber),
    anchorBlockHash: manifest.deploymentBlockHash,
    egressContract: manifest.egressContract,
    keeperAddress: manifest.keeper,
    protocol: manifest.protocol,
  };
}

type RuntimeOverrides = {
  chainId?: number;
  changedTransactionInputAt?: number;
  changedTransactionNonceAt?: number;
  changedReceiptBlockHashAt?: number;
  missingCodeAddress?: Address;
  changedCodeAddress?: Address;
  wrongRouterFactory?: Address;
  wrongTokenSymbol?: string;
  inactivePolicy?: boolean;
  failedReceipt?: boolean;
};

async function expectRuntimeFailure(
  manifest: TestnetDeploymentManifest,
  overrides: RuntimeOverrides,
  message: RegExp,
): Promise<void> {
  await expect(verifyTestnetDeploymentRuntime(runtimeClient(manifest, overrides), {
    manifest,
    config: configurationIdentity(manifest),
  })).rejects.toThrow(message);
}

function runtimeClient(
  manifest: TestnetDeploymentManifest,
  overrides: RuntimeOverrides = {},
): PublicClient {
  const protocol = manifest.protocol;
  const transactionByHash = new Map(
    manifest.deploymentTransactions.map((record) => [record.transactionHash.toLowerCase(), record]),
  );
  const tokenMetadata = new Map<string, { name: string; symbol: string; decimals: number }>(
    Object.values(manifest.tokens).map((token) => [token.address.toLowerCase(), token]),
  );
  const recordFor = (hash: Hex) => {
    const record = transactionByHash.get(hash.toLowerCase());
    if (!record) throw new Error(`Unexpected transaction ${hash}.`);
    return record;
  };
  return {
    getChainId: async () => overrides.chainId ?? 1952,
    getBlock: async (request: { blockNumber?: bigint; blockHash?: Hex; blockTag?: string }) => {
      if (request.blockTag === "finalized") {
        return {
          number: BigInt(TESTNET_BLOCK_NUMBER),
          hash: TESTNET_BLOCK_HASH,
          transactions: [],
        };
      }
      const record = request.blockNumber !== undefined
        ? manifest.deploymentTransactions.find((candidate) =>
          BigInt(candidate.finalizedInclusion.blockNumber) === request.blockNumber)
        : request.blockHash !== undefined
          ? manifest.deploymentTransactions.find((candidate) =>
            candidate.finalizedInclusion.blockHash.toLowerCase() === request.blockHash!.toLowerCase())
          : null;
      if (!record) return { number: null, hash: TESTNET_BLOCK_HASH, transactions: [] };
      return {
        number: BigInt(record.finalizedInclusion.blockNumber),
        hash: record.finalizedInclusion.blockHash,
        transactions: [record.transactionHash],
      };
    },
    getTransactionReceipt: async ({ hash }: { hash: Hex }) => {
      const record = recordFor(hash);
      return {
        transactionHash: record.transactionHash,
        status: overrides.failedReceipt ? "reverted" : "success",
        blockNumber: BigInt(record.finalizedInclusion.blockNumber),
        blockHash: overrides.changedReceiptBlockHashAt === record.sequence
          ? `0x${"99".repeat(32)}`
          : record.finalizedInclusion.blockHash,
        transactionIndex: Number(record.finalizedInclusion.transactionIndex),
        from: record.from,
        to: record.to,
        contractAddress: record.contractAddress,
      };
    },
    getTransaction: async ({ hash }: { hash: Hex }) => {
      const record = recordFor(hash);
      return {
        hash: record.transactionHash,
        from: record.from,
        nonce: overrides.changedTransactionNonceAt === record.sequence
          ? Number(record.nonce) + 1
          : Number(record.nonce),
        to: record.to,
        value: BigInt(record.value),
        input: overrides.changedTransactionInputAt === record.sequence
          ? "0xdeadbeef"
          : testnetTransactionInput(record.sequence),
        chainId: record.chainId,
        blockNumber: BigInt(record.finalizedInclusion.blockNumber),
        blockHash: record.finalizedInclusion.blockHash,
        transactionIndex: Number(record.finalizedInclusion.transactionIndex),
      };
    },
    getBytecode: async ({ address }: { address: Address }) => {
      if (address.toLowerCase() === overrides.missingCodeAddress?.toLowerCase()) return undefined;
      if (address.toLowerCase() === overrides.changedCodeAddress?.toLowerCase()) return "0x6001";
      return TESTNET_BYTECODE;
    },
    readContract: async (request: { address: Address; functionName: string; args?: readonly unknown[] }) => {
      const requestAddress = request.address.toLowerCase();
      const functionName = request.functionName;
      if (requestAddress === manifest.egressContract.toLowerCase()) {
        const values: Record<string, unknown> = {
          AAVE_POOL: protocol.aavePool,
          A_XBETH: protocol.aXbEth,
          SWAP_ROUTER: protocol.swapRouter,
          POOL_ADDRESSES_PROVIDER: protocol.addressesProvider,
          AAVE_ORACLE: protocol.aaveOracle,
          XETH: protocol.xeth,
          XBETH: protocol.xbEth,
          VARIABLE_DEBT_XETH: protocol.variableDebtXeth,
          UNISWAP_FACTORY: protocol.uniswapFactory,
          SWAP_POOL: protocol.swapPool,
          GUARDIAN: manifest.guardian,
          POOL_FEE: BigInt(protocol.poolFee),
          PROTOCOL_CONFIG_HASH: manifest.protocolConfigHash,
          paused: false,
          policyStates: [
            manifest.scenario.borrower,
            !overrides.inactivePolicy,
            0n,
            0n,
            0n,
            0n,
            BigInt(manifest.scenario.initialCollateralWei),
            BigInt(manifest.scenario.initialDebtWei),
          ],
        };
        return values[functionName];
      }
      if (requestAddress === protocol.aavePool.toLowerCase()) {
        if (functionName === "ADDRESSES_PROVIDER") return protocol.addressesProvider;
        if (functionName === "FLASHLOAN_PREMIUM_TOTAL") return 5n;
      }
      if (requestAddress === protocol.addressesProvider.toLowerCase()) {
        if (functionName === "getPool") return protocol.aavePool;
        if (functionName === "getPriceOracle") return protocol.aaveOracle;
      }
      if (requestAddress === protocol.aXbEth.toLowerCase()) {
        if (functionName === "POOL") return protocol.aavePool;
        if (functionName === "UNDERLYING_ASSET_ADDRESS") return protocol.xbEth;
      }
      if (requestAddress === protocol.variableDebtXeth.toLowerCase()) {
        if (functionName === "POOL") return protocol.aavePool;
        if (functionName === "UNDERLYING_ASSET_ADDRESS") return protocol.xeth;
      }
      if (requestAddress === protocol.swapRouter.toLowerCase() && functionName === "factory") {
        return overrides.wrongRouterFactory ?? protocol.uniswapFactory;
      }
      if (requestAddress === protocol.quoterV2.toLowerCase() && functionName === "factory") return protocol.uniswapFactory;
      if (requestAddress === protocol.swapPool.toLowerCase()) {
        if (functionName === "factory") return protocol.uniswapFactory;
        if (functionName === "token0") return protocol.xbEth;
        if (functionName === "token1") return protocol.xeth;
        if (functionName === "fee") return BigInt(protocol.poolFee);
      }
      if (requestAddress === protocol.uniswapFactory.toLowerCase() && functionName === "getPool") return protocol.swapPool;
      if (requestAddress === protocol.aaveOracle.toLowerCase()) {
        if (functionName === "getAssetPrice") return 100_000_000n;
        if (functionName === "getSourceOfAsset") return protocol.aaveOracle;
      }
      const metadata = tokenMetadata.get(requestAddress);
      if (metadata) {
        if (functionName === "name") return metadata.name;
        if (functionName === "symbol") return overrides.wrongTokenSymbol ?? metadata.symbol;
        if (functionName === "decimals") return metadata.decimals;
      }
      throw new Error(`Unexpected read ${request.address}.${functionName}`);
    },
  } as unknown as PublicClient;
}
