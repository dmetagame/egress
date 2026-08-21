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

const AUTHORITATIVE_OKX_SOURCE_URL_ALIASES = [
  "https://www.okx.com/en-us/x-rwa",
  "https://www.okx.com/en-us/help/how-does-xasset-work",
] as const;

const ALLOWLISTED_OKX_SOURCE_URLS = [
  ...AUTHORITATIVE_OKX_SOURCES.map((source) => source.url),
  ...AUTHORITATIVE_OKX_SOURCE_URL_ALIASES,
] as const;

export function sourceById(sourceId: string): SourceDefinition | undefined {
  return AUTHORITATIVE_OKX_SOURCES.find((source) => source.id === sourceId);
}

export function isAllowlistedSourceUrl(url: string): boolean {
  try {
    const candidate = new URL(url);
    return ALLOWLISTED_OKX_SOURCE_URLS.some((url) => {
      const approved = new URL(url);
      return (
        candidate.protocol === "https:" &&
        candidate.origin === approved.origin &&
        candidate.username === "" &&
        candidate.password === "" &&
        candidate.search === "" &&
        candidate.hash === "" &&
        candidate.pathname.replace(/\/$/, "") === approved.pathname.replace(/\/$/, "")
      );
    });
  } catch {
    return false;
  }
}
