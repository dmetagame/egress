import { describe, expect, it } from "vitest";
import {
  assertBroadcastAllowed,
  ExecutionModeError,
  isWriteMode,
} from "../src/live/modes.js";

describe("Phase 7 execution mode security", () => {
  it.each(["LIVE_READ_ONLY", "REPLAY"] as const)("prevents %s from broadcasting", (mode) => {
    expect(() => assertBroadcastAllowed({ mode, observedChainId: 196, expectedChainId: 196 }))
      .toThrowError(ExecutionModeError);
  });

  it("keeps live mainnet disabled even when a caller asks to enable it", () => {
    expect(() => assertBroadcastAllowed({
      mode: "LIVE_MAINNET",
      observedChainId: 196,
      expectedChainId: 196,
      liveMainnetBroadcastEnabled: true,
    })).toThrow(/permanently disabled/i);
  });

  it("rejects wrong-chain and unverified fork writes", () => {
    expect(() => assertBroadcastAllowed({
      mode: "FORK_WRITE",
      observedChainId: 195,
      expectedChainId: 196,
      forkDetected: true,
    })).toThrow(/does not match configured chain/i);
    expect(() => assertBroadcastAllowed({
      mode: "FORK_WRITE",
      observedChainId: 196,
      expectedChainId: 196,
      forkDetected: false,
    })).toThrow(/explicitly detected local fork/i);
  });

  it("allows only explicitly verified fork or testnet write modes", () => {
    expect(() => assertBroadcastAllowed({
      mode: "FORK_WRITE",
      observedChainId: 196,
      expectedChainId: 196,
      forkDetected: true,
    })).not.toThrow();
    expect(() => assertBroadcastAllowed({
      mode: "TESTNET_WRITE",
      observedChainId: 1952,
      expectedChainId: 1952,
      testnetConfigured: true,
    })).not.toThrow();
    expect(isWriteMode("LIVE_READ_ONLY")).toBe(false);
    expect(isWriteMode("FORK_WRITE")).toBe(true);
  });
});
