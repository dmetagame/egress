import { NextResponse } from "next/server";
import {
  getLiveArchiveDashboard,
  toLiveCurrentApiResponse,
} from "@/lib/server/live";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  const dashboard = await getLiveArchiveDashboard();
  return NextResponse.json(toLiveCurrentApiResponse(dashboard), {
    status: 200,
    headers: { "cache-control": "no-store, max-age=0" },
  });
}
