import type { SourceDefinition } from "../domain/schemas.js";

export const AUTHORITATIVE_OKX_SOURCES = [
  {
    id: "okx-x-rwa-overview",
    url: "https://www.okx.com/x-rwa",
    authority: "OKX",
    assetScope: ["X_RWA", "XBETH"],
    enabled: true,
  },
  {
    id: "okx-x-rwa-deposit-withdrawal",
    url: "https://www.okx.com/help/how-does-xasset-work",
    authority: "OKX",
    assetScope: ["X_RWA", "XBETH"],
    enabled: true,
  },
] as const satisfies readonly SourceDefinition[];

export function sourceById(sourceId: string): SourceDefinition | undefined {
  return AUTHORITATIVE_OKX_SOURCES.find((source) => source.id === sourceId);
}

export function isAllowlistedSourceUrl(url: string): boolean {
  try {
    const candidate = new URL(url);
    return AUTHORITATIVE_OKX_SOURCES.some((source) => {
      const approved = new URL(source.url);
      return (
        candidate.protocol === "https:" &&
        candidate.hostname === approved.hostname &&
        candidate.pathname.replace(/\/$/, "") === approved.pathname.replace(/\/$/, "")
      );
    });
  } catch {
    return false;
  }
}
