import { createHash } from "node:crypto";
import { keccak256, stringToHex } from "viem";

export function sha256(value: string): `sha256:${string}` {
  return `sha256:${createHash("sha256").update(value, "utf8").digest("hex")}`;
}

export function stableStringify(value: unknown): string {
  if (value === null || typeof value !== "object") {
    return JSON.stringify(value);
  }

  if (Array.isArray(value)) {
    return `[${value.map(stableStringify).join(",")}]`;
  }

  const record = value as Record<string, unknown>;
  return `{${Object.keys(record)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${stableStringify(record[key])}`)
    .join(",")}}`;
}

export function objectHash(value: unknown): `0x${string}` {
  return keccak256(stringToHex(stableStringify(value)));
}

export function shortId(prefix: string, value: unknown): string {
  return `${prefix}_${objectHash(value).slice(2, 18)}`;
}

export function withoutSha256Prefix(hash: string): `0x${string}` {
  return `0x${hash.replace(/^sha256:/, "")}`;
}
