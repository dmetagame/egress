import { describe, expect, it } from "vitest";
import type { PublicClient } from "viem";
import { XLayerExecutorStateProvider } from "../src/authorization/executor-state.js";
import { testPolicy, TEST_USER_ACCOUNT } from "./helpers.js";

describe("executor runtime state", () => {
  it("reads revocation, nonce usage, pause, and allowance from the executor block state", async () => {
    const calls: Array<{ functionName: string; blockNumber?: bigint }> = [];
    const client = {
      async getBlockNumber() {
        return 67_881_241n;
      },
      async readContract(input: { functionName: string; blockNumber?: bigint }) {
        calls.push(input);
        if (input.functionName === "revocationNonces") return 3n;
        if (input.functionName === "authorizationUsed") return true;
        if (input.functionName === "paused") return false;
        if (input.functionName === "allowance") return 9n;
        throw new Error(`Unexpected call ${input.functionName}`);
      },
    } as unknown as PublicClient;
    const policy = testPolicy();
    const provider = new XLayerExecutorStateProvider({ client });

    const runtime = await provider.getRuntimeState({
      user: TEST_USER_ACCOUNT.address,
      egressContract: policy.egressContract as `0x${string}`,
      collateralAToken: "0xe9e78053f1Ef084f8cD01dBE8ccE95c6b0944d32",
      authorizationNonce: 12n,
      requiredCollateralWei: 10n,
      collateralPermitAvailable: false,
      lastExecutionAt: null,
      userAuthorizationSignature: null,
      evaluatedAt: new Date("2026-08-14T10:00:00.000Z"),
    });

    expect(runtime.revocationNonce).toBe("3");
    expect(runtime.nonceAlreadyUsed).toBe(true);
    expect(runtime.executorPaused).toBe(false);
    expect(runtime.collateralAuthorizationAvailable).toBe(false);
    expect(calls.every((call) => call.blockNumber === 67_881_241n)).toBe(true);
  });

  it("accepts an exact permit even when the current allowance is insufficient", async () => {
    const client = {
      async getBlockNumber() {
        return 1n;
      },
      async readContract(input: { functionName: string }) {
        if (input.functionName === "revocationNonces") return 0n;
        if (input.functionName === "authorizationUsed") return false;
        if (input.functionName === "paused") return false;
        if (input.functionName === "allowance") return 0n;
        throw new Error(`Unexpected call ${input.functionName}`);
      },
    } as unknown as PublicClient;
    const policy = testPolicy();
    const runtime = await new XLayerExecutorStateProvider({ client }).getRuntimeState({
      user: TEST_USER_ACCOUNT.address,
      egressContract: policy.egressContract as `0x${string}`,
      collateralAToken: "0xe9e78053f1Ef084f8cD01dBE8ccE95c6b0944d32",
      authorizationNonce: 1n,
      requiredCollateralWei: 10n,
      collateralPermitAvailable: true,
      lastExecutionAt: null,
      userAuthorizationSignature: null,
    });

    expect(runtime.collateralAuthorizationAvailable).toBe(true);
  });
});
