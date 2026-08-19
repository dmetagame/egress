import { describe, expect, it } from "vitest";
import {
  EGRESS_AUTHORIZATION_TYPES,
  egressAuthorizationDomain,
  executorAuthorizationMessage,
} from "../src/authorization/executor-typed-data.js";
import { DeterministicPolicyEngine } from "../src/policy/engine.js";
import { REPLAY_REVISIONS } from "../src/replay/fixtures.js";
import { InMemoryStore } from "../src/sources/store.js";
import {
  runRevision,
  TEST_NOW,
  TEST_USER_ACCOUNT,
  testMarket,
  testPolicy,
  testRuntime,
} from "./helpers.js";

describe("complete Egress decision loop", () => {
  it("turns a material source revision into a signed bounded contract intent without broadcasting", async () => {
    const store = new InMemoryStore();
    const normal = await runRevision({ store, rawContent: REPLAY_REVISIONS.A });
    const operational = await runRevision({ store, rawContent: REPLAY_REVISIONS.B });
    const material = await runRevision({ store, rawContent: REPLAY_REVISIONS.C });

    expect(normal.event?.verdict.riskLevel).toBe("NORMAL");
    expect(normal.event?.intent?.status).toBe("REJECTED");
    expect(operational.event?.verdict.riskLevel).toBe("MEDIUM");
    expect(operational.event?.intent?.status).toBe("REJECTED");
    expect(material.event?.verdict.riskLevel).toBe("HIGH");
    expect(material.event?.intent?.status).toBe("AWAITING_USER_SIGNATURE");
    expect(material.event?.intent?.authorization).not.toBeNull();

    const authorization = material.event!.intent!.authorization!;
    const policy = testPolicy();
    const signature = await TEST_USER_ACCOUNT.signTypedData({
      domain: egressAuthorizationDomain({
        chainId: policy.chainId,
        egressContract: policy.egressContract as `0x${string}`,
      }),
      types: EGRESS_AUTHORIZATION_TYPES,
      primaryType: "Authorization",
      message: executorAuthorizationMessage(authorization),
    });
    const ready = await new DeterministicPolicyEngine().evaluate({
      verdict: material.event!.verdict,
      attestation: material.event!.attestation,
      market: material.event!.marketContext ?? testMarket(),
      policy,
      runtime: testRuntime(TEST_NOW, {
        authorizationNonce: authorization.nonce,
        revocationNonce: authorization.revocationNonce,
        userAuthorizationSignature: signature,
        collateralAuthorizationAvailable: true,
      }),
    });

    expect(ready.status).toBe("READY_FOR_SUBMISSION");
    expect(ready.allowed).toBe(true);
    expect(ready.authorization).toEqual(authorization);
    expect(ready.egressContract).toBe(policy.egressContract);
    expect(material.event?.executionResult?.status).toBe("NOT_SUBMITTED");
    expect(material.event?.sourceRevisionIds).toContain(store.snapshots.at(-1)?.revisionId);
    expect(material.event?.diffIds).toContain(store.diffs.at(-1)?.diffId);
  });
});
