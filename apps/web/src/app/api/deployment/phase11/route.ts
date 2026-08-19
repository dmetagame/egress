import { NextResponse } from "next/server";
import { getPhase11PublicEvidence } from "@/lib/server/phase11-evidence";

export const runtime = "nodejs";
export const dynamic = "force-static";

export async function GET() {
  const evidence = await getPhase11PublicEvidence();
  return NextResponse.json(
    {
      mode: "READ_ONLY_HISTORICAL_EVIDENCE",
      network: "X Layer testnet",
      chainId: evidence.chainId,
      evidence,
      transactionSubmitted: false,
      broadcastPermitted: false,
    },
    {
      headers: {
        "cache-control": "public, max-age=300, s-maxage=3600, stale-while-revalidate=86400",
      },
    },
  );
}
