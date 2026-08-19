import { describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

import { runReplayRevision } from "./replay";

describe("public replay evidence", () => {
  it("uses committed attestation evidence without creating a runtime signer", async () => {
    const response = await runReplayRevision("C");

    expect(response.event.attestation).not.toBeNull();
    expect(response.event.intent?.status).toBe("AWAITING_USER_SIGNATURE");
    if (!response.event.executionResult) {
      throw new Error("Committed replay evidence is missing its execution result");
    }
    expect(response.event.executionResult.status).toBe("NOT_SUBMITTED");
    expect(response.autonomous?.decision.status).toBe("WOULD_EXECUTE");
  });
});
