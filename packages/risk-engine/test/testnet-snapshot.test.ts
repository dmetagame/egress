import { describe, expect, it } from "vitest";
import {
  buildArchivedLiveSnapshot,
  buildTestnetExecutionSnapshotEnvelope,
  verifyArchivedLiveSnapshot,
} from "../src/index.js";
import { createStagingFixture } from "./staging-fixture.js";
import {
  TESTNET_BLOCK_HASH,
  createTestnetManifestFixture,
} from "./testnet-deployment-fixture.js";

describe("Phase 11 canonical testnet snapshot", () => {
  it("builds reproducible chain-1952 evidence with no write capability", async () => {
    const fixture = await createStagingFixture();
    const manifest = createTestnetManifestFixture();
    const now = new Date("2026-08-17T10:00:00.000Z");
    const event = {
      ...fixture.event,
      mode: "TEST" as const,
      policy: {
        ...fixture.event.policy,
        chainId: 1952,
        egressContract: manifest.egressContract,
        user: manifest.scenario.borrower,
        executor: manifest.keeper,
        approvedRiskAttestor: manifest.scenario.riskAttestor,
      },
    };
    const market = {
      ...fixture.event.marketContext!,
      position: {
        ...fixture.event.marketContext!.position,
        chainId: 1952,
        blockNumber: "123460",
        user: manifest.scenario.borrower,
        collateralToken: manifest.protocol.xbEth,
        debtToken: manifest.protocol.xeth,
        aToken: manifest.protocol.aXbEth,
        variableDebtToken: manifest.protocol.variableDebtXeth,
      },
      liquidity: {
        ...fixture.event.marketContext!.liquidity,
        chainId: 1952,
        blockNumber: "123460",
        pool: manifest.protocol.swapPool,
        tokenIn: manifest.protocol.xbEth,
        tokenOut: manifest.protocol.xeth,
        feeTier: manifest.protocol.poolFee,
      },
    };
    const envelope = await buildTestnetExecutionSnapshotEnvelope({
      event,
      store: fixture.sourceStore,
      market,
      protocol: manifest.protocol,
      oracleSources: manifest.oracleSources,
      chainId: 1952,
      publicRpcUrl: "https://testrpc.xlayer.tech/terigon",
      blockHash: TESTNET_BLOCK_HASH,
      blockTimestamp: now,
      now,
      flashLoanPremiumBps: 5,
      collateralReserve: reserve(manifest.protocol.xbEth, true),
      debtReserve: reserve(manifest.protocol.xeth, true),
      tokens: {
        xbEth: {
          ...manifest.tokens.xbEth,
          walletBalanceWei: "0",
          aTokenAllowanceWei: "12500000000000000000",
        },
        xeth: { ...manifest.tokens.xeth, walletBalanceWei: "0" },
      },
    });
    const first = buildArchivedLiveSnapshot(envelope, now.toISOString());
    const second = buildArchivedLiveSnapshot(envelope, now.toISOString());
    expect(first.snapshotHash).toBe(second.snapshotHash);
    expect(first.chainId).toBe(1952);
    expect(first.broadcastPermitted).toBe(false);
    expect(first.transactionSubmitted).toBe(false);
    expect(verifyArchivedLiveSnapshot(first)).toBe(true);
  });

  it("rejects a mainnet context from the testnet snapshot builder", async () => {
    const fixture = await createStagingFixture();
    const manifest = createTestnetManifestFixture();
    await expect(buildTestnetExecutionSnapshotEnvelope({
      event: fixture.event,
      store: fixture.sourceStore,
      market: fixture.event.marketContext!,
      protocol: manifest.protocol,
      oracleSources: manifest.oracleSources,
      chainId: 196,
      publicRpcUrl: "https://rpc.xlayer.tech",
      blockHash: TESTNET_BLOCK_HASH,
      blockTimestamp: new Date(),
      now: new Date(),
      flashLoanPremiumBps: 5,
      collateralReserve: reserve(manifest.protocol.xbEth, true),
      debtReserve: reserve(manifest.protocol.xeth, true),
      tokens: {
        xbEth: { ...manifest.tokens.xbEth, walletBalanceWei: "0", aTokenAllowanceWei: "0" },
        xeth: { ...manifest.tokens.xeth, walletBalanceWei: "0" },
      },
    })).rejects.toThrow(/chain-bound/i);
  });
});

function reserve(asset: string, borrowingEnabled: boolean) {
  return {
    asset,
    rawData: "0",
    ltvBps: 8_500,
    liquidationThresholdBps: 9_110,
    liquidationBonusBps: 10_500,
    decimals: 18,
    active: true,
    frozen: false,
    borrowingEnabled,
    paused: false,
  };
}
