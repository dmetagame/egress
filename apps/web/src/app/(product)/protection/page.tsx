import type { Metadata } from "next";
import { ShieldCheck } from "lucide-react";
import { PageHeader, StatusPill } from "@/components/primitives";
import { PolicyReview, ProtectionSetup, RevocationPanel } from "@/components/protection-console";
import { getProductSnapshot } from "@/lib/server/snapshot";

export const metadata: Metadata = { title: "Protection policy" };

export default async function ProtectionPage() {
  const snapshot = await getProductSnapshot();
  const observedAt = Math.floor(new Date(snapshot.market.position.observedAt).getTime() / 1_000);
  const expired = Number(snapshot.authorization.policy.expiresAt) <= observedAt;
  const active = snapshot.policyState.active && !expired;
  return (
    <div className="page-stack">
      <PageHeader
        eyebrow="Bounded authorization"
        title="Protection"
        description="Review the policy that defines exactly what Egress may touch, when it may act, and when it must fail closed."
        status={<StatusPill tone={active ? "success" : "danger"} icon={ShieldCheck}>{active ? "ACTIVE AT EVALUATION" : expired ? "EXPIRED" : "REVOKED"}</StatusPill>}
      />
      <PolicyReview snapshot={snapshot} />
      <ProtectionSetup snapshot={snapshot} />
      <RevocationPanel snapshot={snapshot} />
    </div>
  );
}
