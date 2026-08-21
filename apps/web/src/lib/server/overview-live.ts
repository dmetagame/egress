import "server-only";

import { headers } from "next/headers";
import type {
  LiveAlertsApiResponse,
  LiveCurrentApiResponse,
  LiveHistoryApiResponse,
} from "@/lib/types";

export interface OverviewLiveData {
  current: LiveCurrentApiResponse;
  history: LiveHistoryApiResponse;
  alerts: LiveAlertsApiResponse;
}

export async function readOverviewLiveData(): Promise<OverviewLiveData> {
  const requestHeaders = await headers();
  const host = requestHeaders.get("host");
  if (!host || !isTrustedHost(host)) {
    throw new Error("Egress cannot resolve its trusted read-only API origin.");
  }
  const protocol = process.env.VERCEL ? "https" : "http";
  const baseUrl = `${protocol}://${host}`;
  const [current, history, alerts] = await Promise.all([
    readJson<LiveCurrentApiResponse>(`${baseUrl}/api/live/current`),
    readJson<LiveHistoryApiResponse>(`${baseUrl}/api/live/history?limit=20`),
    readJson<LiveAlertsApiResponse>(`${baseUrl}/api/live/alerts?limit=30`),
  ]);
  return { current, history, alerts };
}

async function readJson<T>(url: string): Promise<T> {
  const response = await fetch(url, { cache: "no-store" });
  if (!response.ok) throw new Error(`Read-only live API returned HTTP ${response.status}.`);
  return response.json() as Promise<T>;
}

function isTrustedHost(host: string): boolean {
  if (/^(localhost|127\.0\.0\.1)(:\d+)?$/u.test(host)) return true;
  return /^([a-z0-9-]+\.)*vercel\.app$/iu.test(host);
}
