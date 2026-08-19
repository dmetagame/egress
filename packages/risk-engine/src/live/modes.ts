import { z } from "zod";

export const runtimeModeSchema = z.enum([
  "REPLAY",
  "LIVE_READ_ONLY",
  "FORK_WRITE",
  "TESTNET_WRITE",
  "LIVE_MAINNET",
]);

export type RuntimeMode = z.infer<typeof runtimeModeSchema>;

export class ExecutionModeError extends Error {
  constructor(
    public readonly code:
      | "READ_ONLY_MODE"
      | "EXECUTION_ENVIRONMENT_MISMATCH"
      | "LIVE_MAINNET_DISABLED",
    message: string,
  ) {
    super(message);
    this.name = "ExecutionModeError";
  }
}

export function assertBroadcastAllowed(input: {
  mode: RuntimeMode;
  observedChainId: number;
  expectedChainId: number;
  forkDetected?: boolean;
  testnetConfigured?: boolean;
  liveMainnetBroadcastEnabled?: boolean;
}): void {
  if (input.mode === "LIVE_MAINNET") {
    throw new ExecutionModeError(
      "LIVE_MAINNET_DISABLED",
      "Live-mainnet broadcasting is permanently disabled in Phase 7.",
    );
  }

  if (input.mode === "REPLAY" || input.mode === "LIVE_READ_ONLY") {
    throw new ExecutionModeError(
      "READ_ONLY_MODE",
      `${input.mode} is read-only; no transaction may be broadcast.`,
    );
  }

  if (input.observedChainId !== input.expectedChainId) {
    throw new ExecutionModeError(
      "EXECUTION_ENVIRONMENT_MISMATCH",
      `Observed chain ${input.observedChainId} does not match configured chain ${input.expectedChainId}.`,
    );
  }

  if (input.mode === "FORK_WRITE" && !input.forkDetected) {
    throw new ExecutionModeError(
      "EXECUTION_ENVIRONMENT_MISMATCH",
      "FORK_WRITE requires an explicitly detected local fork runtime.",
    );
  }

  if (input.mode === "TESTNET_WRITE" && !input.testnetConfigured) {
    throw new ExecutionModeError(
      "EXECUTION_ENVIRONMENT_MISMATCH",
      "TESTNET_WRITE requires an explicitly configured and verified testnet deployment.",
    );
  }

  if (input.mode === "FORK_WRITE" || input.mode === "TESTNET_WRITE") return;

  if (!input.liveMainnetBroadcastEnabled) {
    throw new ExecutionModeError(
      "LIVE_MAINNET_DISABLED",
      "No live-mainnet broadcast capability is enabled.",
    );
  }
}

export function assertReadOnly(mode: RuntimeMode): void {
  if (mode !== "LIVE_READ_ONLY" && mode !== "REPLAY") return;
  // This function is intentionally explicit: callers should use it before
  // constructing any write client, even though these modes have no signer.
  return;
}

export function isWriteMode(mode: RuntimeMode): boolean {
  return mode === "FORK_WRITE" || mode === "TESTNET_WRITE" || mode === "LIVE_MAINNET";
}
