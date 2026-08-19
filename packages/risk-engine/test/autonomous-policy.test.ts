import { parseEther, type Hex, type PublicClient, type WalletClient } from "viem";
import { describe, expect, it } from "vitest";
import {
  buildOnchainProtectionPolicy,
  protectionPolicyId,
  signAutonomousRiskAttestation,
  signProtectionPolicy,
  verifyProtectionPolicySignature,
} from "../src/authorization/protection-policy.js";
import { EgressShadowKeeper } from "../src/keeper/shadow-keeper.js";
import { StaticMarketContextProvider } from "../src/market/provider.js";
import { REPLAY_REVISIONS } from "../src/replay/fixtures.js";
import { InMemoryStore } from "../src/sources/store.js";
import {
  runRevision,
  TEST_ATTESTOR_ACCOUNT,
  TEST_NOW,
  TEST_USER_ACCOUNT,
  testMarket,
} from "./helpers.js";

const PROTOCOL_CONFIG_HASH = `0x${"ab".repeat(32)}` as Hex;
const TRANSACTION_HASH = `0x${"cd".repeat(32)}` as Hex;

async function highRiskEvent() {
  const store = new InMemoryStore();
  await runRevision({ store, rawContent: REPLAY_REVISIONS.A });
  await runRevision({ store, rawContent: REPLAY_REVISIONS.B });
  const result = await runRevision({ store, rawContent: REPLAY_REVISIONS.C });
  if (!result.event || result.event.verdict.riskLevel !== "HIGH") {
    throw new Error("Expected a HIGH replay event");
  }
  return result.event;
}

async function fixture(overrides: {
  active?: boolean;
  paused?: boolean;
  used?: boolean;
  executionCount?: bigint;
  lastExecutionAt?: bigint;
  allowance?: bigint;
  market?: ReturnType<typeof testMarket>;
  simulationError?: Error;
} = {}) {
  const event = await highRiskEvent();
  const onchainPolicy = buildOnchainProtectionPolicy({
    policy: event.policy,
    protocolConfigHash: PROTOCOL_CONFIG_HASH,
    nonce: 41n,
    revocationNonce: 0n,
    maxExecutions: 2n,
    maxCumulativeRepaymentWei: parseEther("20"),
    maxCumulativeCollateralWei: parseEther("12"),
    maxPositionDebtWei: parseEther("46"),
    maxOracleDeviationBps: 200n,
  });
  const policyId = protectionPolicyId({
    chainId: event.policy.chainId,
    egressContract: event.policy.egressContract as `0x${string}`,
    policy: onchainPolicy,
  });
  const attestation = await signAutonomousRiskAttestation({
    account: TEST_ATTESTOR_ACCOUNT,
    verdict: event.verdict,
    policyId,
    chainId: event.policy.chainId,
    egressContract: event.policy.egressContract as `0x${string}`,
  });
  const simulated: unknown[] = [];
  const broadcasts: unknown[] = [];
  const publicClient = {
    async getChainId() {
      return event.policy.chainId;
    },
    async readContract(request: { functionName: string }) {
      if (request.functionName === "policyStates") {
        return [
          onchainPolicy.user,
          overrides.active ?? true,
          overrides.executionCount ?? 0n,
          overrides.lastExecutionAt ?? 0n,
          0n,
          0n,
          parseEther("50"),
          parseEther("44.05"),
        ] as const;
      }
      if (request.functionName === "revocationNonces") return 0n;
      if (request.functionName === "paused") return overrides.paused ?? false;
      if (request.functionName === "riskEventUsed") return overrides.used ?? false;
      if (request.functionName === "PROTOCOL_CONFIG_HASH") return PROTOCOL_CONFIG_HASH;
      if (request.functionName === "allowance") {
        return overrides.allowance ?? parseEther("12");
      }
      throw new Error(`Unexpected read ${request.functionName}`);
    },
    async simulateContract(request: unknown) {
      if (overrides.simulationError) throw overrides.simulationError;
      simulated.push(request);
      return { request: { ...(request as object), gas: 900_000n } };
    },
    async waitForTransactionReceipt() {
      return {
        status: "success",
        blockNumber: 67_881_250n,
        gasUsed: 925_000n,
      };
    },
  } as unknown as PublicClient;
  const walletClient = {
    async writeContract(request: unknown) {
      broadcasts.push(request);
      return TRANSACTION_HASH;
    },
  } as unknown as WalletClient;
  const keeper = new EgressShadowKeeper({
    publicClient,
    walletClient,
    marketProvider: new StaticMarketContextProvider(overrides.market ?? testMarket()),
    keeperAccount: event.policy.executor as `0x${string}`,
    now: () => TEST_NOW,
  });
  return { event, onchainPolicy, policyId, attestation, keeper, simulated, broadcasts };
}

describe("pre-authorized protection policy", () => {
  it("binds policy mutation to a fresh user signature", async () => {
    const event = await highRiskEvent();
    const policy = buildOnchainProtectionPolicy({
      policy: event.policy,
      protocolConfigHash: PROTOCOL_CONFIG_HASH,
      nonce: 7n,
      revocationNonce: 0n,
      maxExecutions: 2n,
      maxCumulativeRepaymentWei: parseEther("20"),
      maxCumulativeCollateralWei: parseEther("12"),
      maxPositionDebtWei: parseEther("46"),
      maxOracleDeviationBps: 200n,
    });
    const signature = await signProtectionPolicy({
      account: TEST_USER_ACCOUNT,
      chainId: event.policy.chainId,
      egressContract: event.policy.egressContract as `0x${string}`,
      policy,
    });
    expect(
      await verifyProtectionPolicySignature({
        chainId: event.policy.chainId,
        egressContract: event.policy.egressContract as `0x${string}`,
        policy,
        signature,
      }),
    ).toBe(true);
    expect(
      await verifyProtectionPolicySignature({
        chainId: event.policy.chainId,
        egressContract: event.policy.egressContract as `0x${string}`,
        policy: { ...policy, maxSlippageBps: "101" },
        signature,
      }),
    ).toBe(false);
  });

  it("produces WOULD_EXECUTE only after fresh state and contract simulation pass", async () => {
    const value = await fixture();
    const decision = await value.keeper.evaluate({
      event: value.event,
      policy: value.onchainPolicy,
      attestation: value.attestation,
    });
    expect(decision.status).toBe("WOULD_EXECUTE");
    expect(decision.simulation.success).toBe(true);
    expect(decision.execution?.executionNonce).toBe("0");
    expect(value.simulated).toHaveLength(1);
    expect(value.broadcasts).toHaveLength(0);
  });

  it("fails closed after revocation or when market state is stale", async () => {
    const revoked = await fixture({ active: false });
    const revokedDecision = await revoked.keeper.evaluate({
      event: revoked.event,
      policy: revoked.onchainPolicy,
      attestation: revoked.attestation,
    });
    expect(revokedDecision.status).toBe("WOULD_NOT_EXECUTE");
    expect(revokedDecision.checks.find((item) => item.check === "policy_registered")?.passed).toBe(false);

    const staleMarket = testMarket(TEST_NOW, {
      position: { observedAt: new Date(TEST_NOW.getTime() - 5 * 60_000).toISOString() },
      liquidity: { observedAt: new Date(TEST_NOW.getTime() - 5 * 60_000).toISOString() },
    });
    const stale = await fixture({ market: staleMarket });
    const staleDecision = await stale.keeper.evaluate({
      event: stale.event,
      policy: stale.onchainPolicy,
      attestation: stale.attestation,
    });
    expect(staleDecision.status).toBe("WOULD_NOT_EXECUTE");
    expect(staleDecision.simulation.attempted).toBe(false);
  });

  it("a compromised AI cannot trigger above the signed health-factor ceiling", async () => {
    const healthy = testMarket(TEST_NOW, {
      position: { healthFactorWad: parseEther("1.3").toString() },
    });
    const value = await fixture({ market: healthy });
    const decision = await value.keeper.evaluate({
      event: value.event,
      policy: value.onchainPolicy,
      attestation: value.attestation,
    });
    expect(decision.status).toBe("WOULD_NOT_EXECUTE");
    expect(decision.checks.find((item) => item.check === "health_factor_trigger")?.passed).toBe(false);
    expect(value.simulated).toHaveLength(0);
  });

  it("explicit TEST-mode execution broadcasts without any post-event user signature", async () => {
    const value = await fixture();
    const outcome = await value.keeper.executeFork({
      event: value.event,
      policy: value.onchainPolicy,
      attestation: value.attestation,
    });
    expect(outcome.decision.status).toBe("WOULD_EXECUTE");
    expect(outcome.transactionHash).toBe(TRANSACTION_HASH);
    expect(value.broadcasts).toHaveLength(1);
  });
});
