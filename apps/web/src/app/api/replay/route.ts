import { NextResponse } from "next/server";
import { runReplayRevision } from "@/lib/server/replay";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(request: Request) {
  try {
    const body = (await request.json()) as { revision?: unknown };
    const response = await runReplayRevision(body.revision);
    return NextResponse.json(response);
  } catch (error) {
    const message = error instanceof Error ? error.message : "Replay failed safely";
    return NextResponse.json({ error: message }, { status: 400 });
  }
}
