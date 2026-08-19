import { describe, expect, it } from "vitest";
import { DeterministicPolicyEngine } from "../src/policy/engine.js";
import {
  EGRESS_AUTHORIZATION_TYPES,
  egressAuthorizationDomain,
  executorAuthorizationMessage,
} from "../src/authorization/executor-typed-data.js";
import { verifyRiskAttestation } from "../src/authorization/risk-attestation.js";
import {
  buildHighRiskFixture,
  TEST_NOW,
  TEST_USER_ACCOUNT,
  testMarket,
  testRuntime,
} from "./helpers.js";

async function evaluateFixture(overrides: {
  market?: Parameters<typeof testMarket>[1];
  runtime?: Parameters<typeof testRuntime>[1];
  attestation?: Awaited<ReturnType<typeof buildHighRiskFixture>>["attestation"] | null;
} = {}) {
  const fixture = await buildHighRiskFixture();
  const policy = fixture.policy;
  const market = testMarket(TEST_NOW, overrides.market);
  const runtime = testRuntime(TEST_NOW, overrides.runtime);
  const intent = await new DeterministicPolicyEngine().evaluate({
    verdict: fixture.verdict,
    attestation: overrides.attestation === undefined ? fixture.attestation : overrides.attestation,
    market,
    policy,
    runtime,
  });
  return { fixture, policy, market, runtime, intent };
}

describe("deterministic policy engine", () => {
  it("rejects high risk when the position is healthy", async () => {
    const result = await evaluateFixture({
      market: { position: { healthFactorWad: "1300000000000000000" } },
    });

    expect(result.intent.allowed).toBe(false);
    expect(result.intent.status).toBe("REJECTED");
    expect(result.intent.checks.find((check) => check.check === "health_factor_trigger")?.passed).toBe(false);
  });

  it("rejects high risk when liquidity is not executable", async () => {
    const result = await evaluateFixture({
      market: {
        liquidity: { executable: false, failureReason: "insufficient pool depth" },
        plan: { executable: false, failureReason: "quote cannot cover flash loan" },
      },
    });

    expect(result.intent.allowed).toBe(false);
    expect(result.intent.reasons.join(" ")).toContain("liquidity_executable");
  });

  it("rejects oracle/pool divergence even when the swap quote is otherwise executable", async () => {
    const result = await evaluateFixture({
      market: { liquidity: { oraclePoolDeviationBps: 500 } },
    });

    expect(result.intent.allowed).toBe(false);
    expect(result.intent.checks.find((check) => check.check === "oracle_pool_deviation")?.passed).toBe(false);
  });

  it("permits only a bounded intent for high risk plus unhealthy position and executable liquidity", async () => {
    const result = await evaluateFixture();

    expect(result.intent.allowed).toBe(true);
    expect(result.intent.status).toBe("AWAITING_USER_SIGNATURE");
    expect(result.intent.authorization).not.toBeNull();
    expect(BigInt(result.intent.authorization!.repayAmount)).toBeLessThanOrEqual(
      BigInt(result.policy.maximumRepaymentWei),
    );
    expect(BigInt(result.intent.authorization!.collateralAmount)).toBeLessThanOrEqual(
      BigInt(result.policy.maximumCollateralWei),
    );
    expect(result.intent.authorization!.executor).toBe(result.policy.executor);
  });

  it("rejects an expired verdict", async () => {
    const fixture = await buildHighRiskFixture();
    const expiredVerdict = {
      ...fixture.verdict,
      expiresAt: new Date(TEST_NOW.getTime() - 1_000).toISOString(),
    };
    const intent = await new DeterministicPolicyEngine().evaluate({
      verdict: expiredVerdict,
      attestation: null,
      market: testMarket(),
      policy: fixture.policy,
      runtime: testRuntime(),
    });

    expect(intent.allowed).toBe(false);
    expect(intent.checks.find((check) => check.check === "verdict_expiry")?.passed).toBe(false);
  });

  it("rejects a used nonce and a paused executor", async () => {
    const used = await evaluateFixture({
      runtime: { nonceAlreadyUsed: true },
    });
    const paused = await evaluateFixture({
      runtime: { executorPaused: true },
    });

    expect(used.intent.allowed).toBe(false);
    expect(used.intent.checks.find((check) => check.check === "nonce_unused")?.passed).toBe(false);
    expect(paused.intent.allowed).toBe(false);
    expect(paused.intent.checks.find((check) => check.check === "executor_unpaused")?.passed).toBe(false);
  });

  it("rejects a previously signed authorization after the user advances the revocation epoch", async () => {
    const first = await evaluateFixture();
    const authorization = first.intent.authorization!;
    const signature = await TEST_USER_ACCOUNT.signTypedData({
      domain: egressAuthorizationDomain({
        chainId: first.policy.chainId,
        egressContract: first.policy.egressContract as `0x${string}`,
      }),
      types: EGRESS_AUTHORIZATION_TYPES,
      primaryType: "Authorization",
      message: executorAuthorizationMessage(authorization),
    });
    const revoked = await evaluateFixture({
      runtime: {
        revocationNonce: (BigInt(authorization.revocationNonce) + 1n).toString(),
        userAuthorizationSignature: signature,
        collateralAuthorizationAvailable: true,
      },
    });

    expect(revoked.intent.allowed).toBe(false);
    expect(revoked.intent.status).toBe("REJECTED");
  });

  it("rejects implausibly future-dated verdict and market data", async () => {
    const fixture = await buildHighRiskFixture();
    const future = new Date(TEST_NOW.getTime() + 120_000);
    const intent = await new DeterministicPolicyEngine().evaluate({
      verdict: {
        ...fixture.verdict,
        issuedAt: future.toISOString(),
        expiresAt: new Date(future.getTime() + 300_000).toISOString(),
      },
      attestation: null,
      market: testMarket(TEST_NOW, {
        position: { observedAt: future.toISOString() },
        liquidity: { observedAt: future.toISOString() },
      }),
      policy: fixture.policy,
      runtime: testRuntime(),
    });

    expect(intent.allowed).toBe(false);
    expect(intent.checks.find((check) => check.check === "verdict_freshness")?.passed).toBe(false);
    expect(intent.checks.find((check) => check.check === "market_freshness")?.passed).toBe(false);
  });

  it("rejects tampered risk attestations", async () => {
    const fixture = await buildHighRiskFixture();
    const tampered = {
      ...fixture.attestation,
      evidenceHash: `0x${"00".repeat(32)}` as `0x${string}`,
    };
    const verification = await verifyRiskAttestation({
      attestation: tampered,
      verdict: fixture.verdict,
      policy: fixture.policy,
    });

    expect(verification.valid).toBe(false);
    const result = await evaluateFixture({ attestation: tampered });
    expect(result.intent.allowed).toBe(false);
  });

  it("requires and verifies the user's exact EIP-712 authorization", async () => {
    const first = await evaluateFixture();
    const authorization = first.intent.authorization!;
    const signature = await TEST_USER_ACCOUNT.signTypedData({
      domain: egressAuthorizationDomain({
        chainId: first.policy.chainId,
        egressContract: first.policy.egressContract as `0x${string}`,
      }),
      types: EGRESS_AUTHORIZATION_TYPES,
      primaryType: "Authorization",
      message: executorAuthorizationMessage(authorization),
    });
    const second = await evaluateFixture({
      runtime: {
        userAuthorizationSignature: signature,
        collateralAuthorizationAvailable: true,
      },
    });

    expect(second.intent.allowed).toBe(true);
    expect(second.intent.status).toBe("READY_FOR_SUBMISSION");
    expect(second.intent.autoExecutionEligible).toBe(true);
  });

  it("rejects a signature when any bounded parameter changes", async () => {
    const first = await evaluateFixture();
    const authorization = first.intent.authorization!;
    const signature = await TEST_USER_ACCOUNT.signTypedData({
      domain: egressAuthorizationDomain({
        chainId: first.policy.chainId,
        egressContract: first.policy.egressContract as `0x${string}`,
      }),
      types: EGRESS_AUTHORIZATION_TYPES,
      primaryType: "Authorization",
      message: executorAuthorizationMessage({
        ...authorization,
        repayAmount: (BigInt(authorization.repayAmount) + 1n).toString(),
      }),
    });
    const second = await evaluateFixture({
      runtime: {
        userAuthorizationSignature: signature,
        collateralAuthorizationAvailable: true,
      },
    });

    expect(second.intent.allowed).toBe(false);
    expect(second.intent.status).toBe("REJECTED");
    expect(second.intent.reasons.join(" ")).toMatch(/signature/i);
  });
});
