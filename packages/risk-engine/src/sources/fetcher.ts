import type { SourceDefinition } from "../domain/schemas.js";
import { isAllowlistedSourceUrl } from "./registry.js";

export interface RetrievedSource {
  source: SourceDefinition;
  retrievedAt: string;
  rawContent: string;
  responseMetadata: {
    status: number;
    contentType: string | null;
    etag: string | null;
    lastModified: string | null;
    finalUrl: string;
  };
}

export interface SourceFetcher {
  fetch(source: SourceDefinition): Promise<RetrievedSource>;
}

const MAX_REDIRECTS = 3;

async function readBoundedText(
  response: Response,
  maxBytes: number,
  controller: AbortController,
): Promise<string> {
  if (!response.body) return "";

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let receivedBytes = 0;
  let text = "";

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!value) continue;

      receivedBytes += value.byteLength;
      if (receivedBytes > maxBytes) {
        controller.abort();
        throw new Error(`Source response exceeds ${maxBytes} bytes`);
      }
      text += decoder.decode(value, { stream: true });
    }
    return text + decoder.decode();
  } finally {
    reader.releaseLock();
  }
}

export class AllowlistedHttpSourceFetcher implements SourceFetcher {
  constructor(
    private readonly options: {
      timeoutMs?: number;
      maxBytes?: number;
      userAgent?: string;
      fetchImplementation?: typeof fetch;
    } = {},
  ) {}

  async fetch(source: SourceDefinition): Promise<RetrievedSource> {
    if (!source.enabled || !isAllowlistedSourceUrl(source.url)) {
      throw new Error(`Source is not allowlisted: ${source.url}`);
    }

    const timeoutMs = this.options.timeoutMs ?? 15_000;
    const maxBytes = this.options.maxBytes ?? 2_000_000;
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), timeoutMs);

    try {
      const fetchImplementation = this.options.fetchImplementation ?? fetch;
      let requestUrl = source.url;

      for (let redirects = 0; redirects <= MAX_REDIRECTS; redirects += 1) {
        if (!isAllowlistedSourceUrl(requestUrl)) {
          throw new Error(`Source redirected outside allowlist: ${requestUrl}`);
        }
        const response = await fetchImplementation(requestUrl, {
          redirect: "manual",
          signal: controller.signal,
          headers: {
            accept: "text/html,application/xhtml+xml",
            "accept-language": "en-US,en;q=0.9",
            "user-agent":
              this.options.userAgent ??
              "Egress-RWA-Monitor/0.1 (+https://github.com/egress; authoritative-source-monitor)",
          },
        });

        if (response.status >= 300 && response.status < 400) {
          const location = response.headers.get("location");
          if (!location) {
            throw new Error(`Source ${source.id} returned a redirect without a location`);
          }
          if (redirects === MAX_REDIRECTS) {
            throw new Error(`Source ${source.id} exceeded ${MAX_REDIRECTS} redirects`);
          }
          requestUrl = new URL(location, requestUrl).toString();
          continue;
        }

        if (!response.ok) {
          throw new Error(`Failed to retrieve ${source.id}: HTTP ${response.status}`);
        }

        const finalUrl = response.url || requestUrl;
        if (!isAllowlistedSourceUrl(finalUrl)) {
          throw new Error(`Source redirected outside allowlist: ${finalUrl}`);
        }

        const contentType = response.headers.get("content-type");
        if (!contentType?.toLowerCase().includes("text/html")) {
          throw new Error(`Unexpected content type for ${source.id}: ${contentType ?? "missing"}`);
        }

        const declaredLength = Number(response.headers.get("content-length") ?? 0);
        if (Number.isFinite(declaredLength) && declaredLength > maxBytes) {
          throw new Error(`Source ${source.id} exceeds ${maxBytes} bytes`);
        }

        const rawContent = await readBoundedText(response, maxBytes, controller);
        return {
          source,
          retrievedAt: new Date().toISOString(),
          rawContent,
          responseMetadata: {
            status: response.status,
            contentType,
            etag: response.headers.get("etag"),
            lastModified: response.headers.get("last-modified"),
            finalUrl,
          },
        };
      }

      throw new Error(`Source ${source.id} exceeded ${MAX_REDIRECTS} redirects`);
    } finally {
      clearTimeout(timeout);
    }
  }
}

export class InMemorySourceFetcher implements SourceFetcher {
  constructor(
    private readonly contentBySourceId: ReadonlyMap<
      string,
      { rawContent: string; retrievedAt?: string }
    >,
  ) {}

  async fetch(source: SourceDefinition): Promise<RetrievedSource> {
    const fixture = this.contentBySourceId.get(source.id);
    if (!fixture) {
      throw new Error(`Missing fixture for source ${source.id}`);
    }

    return {
      source,
      retrievedAt: fixture.retrievedAt ?? new Date().toISOString(),
      rawContent: fixture.rawContent,
      responseMetadata: {
        status: 200,
        contentType: "text/html; charset=utf-8",
        etag: null,
        lastModified: null,
        finalUrl: source.url,
      },
    };
  }
}
