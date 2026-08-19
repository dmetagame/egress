import * as cheerio from "cheerio";
import type { NormalizedDocument, SourceDefinition } from "../domain/schemas.js";
import { sha256 } from "../domain/hash.js";

const CONTENT_ROOT_SELECTORS = [
  "article",
  "main",
  "[role='main']",
  "[class*='articleContainer']",
  "[class*='contentContainer']",
];

const BLOCK_SELECTORS = "h1,h2,h3,h4,h5,h6,p,li,th,td,dt,dd,blockquote";
export const MAX_NORMALIZED_LINES = 2_000;
export const MAX_NORMALIZED_TEXT_BYTES = 750_000;

function decodeAndCollapseWhitespace(value: string): string {
  return value
    .replace(/\u00a0/g, " ")
    .replace(/[\t\r\f\v ]+/g, " ")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function isNoise(text: string): boolean {
  const normalized = text.toLowerCase();
  return (
    normalized.length < 2 ||
    normalized === "skip to main content" ||
    normalized === "cookie preferences" ||
    normalized.startsWith("©") ||
    normalized.includes("all rights reserved")
  );
}

export function normalizeHtml(
  rawContent: string,
  _source: SourceDefinition,
): NormalizedDocument {
  const $ = cheerio.load(rawContent);

  $(
    "script,style,noscript,template,svg,canvas,iframe,nav,header,footer,form,button,input,select,textarea",
  ).remove();
  $("[hidden],[aria-hidden='true'],[style*='display:none'],[style*='display: none']").remove();

  const title = decodeAndCollapseWhitespace(
    $("meta[property='og:title']").attr("content") ?? $("title").first().text(),
  );
  const description = decodeAndCollapseWhitespace(
    $("meta[name='description']").attr("content") ??
      $("meta[property='og:description']").attr("content") ??
      "",
  );

  let root = $(CONTENT_ROOT_SELECTORS[0] ?? "body").first();
  for (const selector of CONTENT_ROOT_SELECTORS) {
    const candidate = $(selector).first();
    if (candidate.length > 0 && candidate.text().trim().length > root.text().trim().length) {
      root = candidate;
    }
  }
  if (root.length === 0) root = $("body");

  const lines: Array<{ line: number; section: string; text: string }> = [];
  const seen = new Set<string>();
  let section = title || "Document";

  root.find(BLOCK_SELECTORS).each((_index, element) => {
    const tag = element.tagName.toLowerCase();
    const text = decodeAndCollapseWhitespace($(element).text());
    if (isNoise(text)) return;

    if (/^h[1-6]$/.test(tag)) {
      section = text;
    }

    const dedupeKey = `${section}\u0000${text}`;
    if (seen.has(dedupeKey)) return;
    seen.add(dedupeKey);
    lines.push({ line: lines.length + 1, section, text });
  });

  if (description && !lines.some((line) => line.text === description)) {
    lines.unshift({ line: 1, section: title || "Metadata", text: description });
    lines.forEach((line, index) => {
      line.line = index + 1;
    });
  }

  const text = lines.map((line) => line.text).join("\n");
  if (lines.length > MAX_NORMALIZED_LINES) {
    throw new Error(
      `Normalized document exceeds the ${MAX_NORMALIZED_LINES}-line safety limit`,
    );
  }
  if (Buffer.byteLength(text, "utf8") > MAX_NORMALIZED_TEXT_BYTES) {
    throw new Error(
      `Normalized document exceeds the ${MAX_NORMALIZED_TEXT_BYTES}-byte safety limit`,
    );
  }
  return {
    title,
    description,
    text,
    lines,
    semanticFingerprint: sha256(text.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim()),
  };
}
