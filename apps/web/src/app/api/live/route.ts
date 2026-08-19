import { NextResponse } from "next/server";
import { emitLiveSnapshotLogs, getLiveArchiveDashboard } from "@/lib/server/live";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  try {
    const dashboard = await getLiveArchiveDashboard();
    const envelope = dashboard.envelope;
    emitLiveSnapshotLogs(envelope);
    return NextResponse.json(envelope, {
      status: 200,
      headers: { "cache-control": "no-store, max-age=0" },
    });
  } catch (error) {
    const body = {
      mode: "LIVE_READ_ONLY" as const,
      status: "LIVE_DATA_UNAVAILABLE" as const,
      reasons: ["Live read-only snapshot failed safely. Retry after adapter health is restored."],
    };
    console.error(JSON.stringify({
      event: "egress.live.route_error",
      mode: "LIVE_READ_ONLY",
      broadcastAllowed: false,
      liveMainnetBroadcast: false,
      errorType: error instanceof Error ? error.name : "UnknownError",
    }));
    return NextResponse.json(body, {
      status: 503,
      headers: { "cache-control": "no-store, max-age=0" },
    });
  }
}
