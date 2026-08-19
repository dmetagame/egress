import { NextResponse } from "next/server";
import {
  getLiveArchiveDashboard,
  toLiveAlertsApiResponse,
} from "@/lib/server/live";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  const limit = readLimit(new URL(request.url).searchParams.get("limit"));
  const dashboard = await getLiveArchiveDashboard(process.env, {
    alertLimit: limit,
    refreshIfDue: false,
  });
  return NextResponse.json(toLiveAlertsApiResponse(dashboard), {
    status: 200,
    headers: { "cache-control": "no-store, max-age=0" },
  });
}

function readLimit(value: string | null): number {
  const parsed = Number(value ?? 30);
  return Number.isInteger(parsed) ? Math.max(1, Math.min(100, parsed)) : 30;
}
