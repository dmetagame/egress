import { NextResponse } from "next/server";
import { getLiveOperationalHealth } from "@/lib/server/live";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  const health = await getLiveOperationalHealth();
  return NextResponse.json(health, {
    status: 200,
    headers: { "cache-control": "no-store, max-age=0" },
  });
}
