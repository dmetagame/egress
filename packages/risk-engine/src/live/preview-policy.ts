import type { Address } from "viem";
import type { UserProtectionPolicy } from "../domain/schemas.js";
import { replayPolicy } from "../replay/fixtures.js";

/**
 * A read-only planner needs limits even when no live Egress policy has been
 * registered for the account. These limits are deliberately marked preview
 * only by the snapshot layer and can never authorize a write.
 */
export function readOnlyPreviewPolicy(user: Address, now = new Date()): UserProtectionPolicy {
  return {
    ...replayPolicy(now),
    policyId: "policy_live_read_only_preview",
    user,
    automaticExecutionEnabled: false,
    authorizationExpiresAt: new Date(now.getTime() + 86_400_000).toISOString(),
  };
}
