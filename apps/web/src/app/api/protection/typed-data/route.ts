import { NextResponse } from "next/server";
import { getAddress, isAddress } from "viem";
import {
  EGRESS_PROTECTION_POLICY_TYPES,
  protectionPolicyId,
} from "@egress/risk-engine";
import { loadPhase5Artifact } from "@/lib/server/snapshot";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export function isPublicReadOnlyRuntime(
  environment: Readonly<Partial<NodeJS.ProcessEnv>> = process.env,
): boolean {
  return (
    environment.NODE_ENV === "production" ||
    environment.EGRESS_DEPLOYMENT_ENV === "production" ||
    Boolean(environment.VERCEL)
  );
}

export async function GET(request: Request) {
  if (isPublicReadOnlyRuntime()) {
    return NextResponse.json(
      { error: "Policy preparation is disabled in the public read-only demo." },
      { status: 403, headers: { "cache-control": "no-store" } },
    );
  }

  const user = new URL(request.url).searchParams.get("user");
  if (!user || !isAddress(user)) {
    return NextResponse.json({ error: "A valid wallet address is required" }, { status: 400 });
  }

  const artifact = await loadPhase5Artifact();
  const contract = artifact.contracts.egressExecutor as `0x${string}`;
  const policy = {
    ...artifact.authorization.policy,
    user: getAddress(user),
    expiresAt: String(Math.floor(Date.now() / 1_000) + 86_400),
    nonce: String(Math.floor(Date.now() / 1_000)),
    revocationNonce: "0",
  };
  const policyId = protectionPolicyId({
    chainId: artifact.environment.chainId,
    egressContract: contract,
    policy,
  });

  return NextResponse.json({
    environment: {
      label: artifact.label,
      chainId: artifact.environment.chainId,
      contract,
    },
    policy,
    policyId,
    domain: {
      name: "Egress",
      version: "1",
      chainId: artifact.environment.chainId,
      verifyingContract: contract,
    },
    primaryType: "ProtectionPolicy",
    types: EGRESS_PROTECTION_POLICY_TYPES,
  });
}
