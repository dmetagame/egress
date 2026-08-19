import { formatUnits } from "viem";

export function tokenAmount(value: string, maximumFractionDigits = 4): string {
  const numeric = Number(formatUnits(BigInt(value), 18));
  return new Intl.NumberFormat("en-US", {
    minimumFractionDigits: 0,
    maximumFractionDigits,
  }).format(numeric);
}

export function healthFactor(value: string, digits = 4): string {
  return Number(formatUnits(BigInt(value), 18)).toFixed(digits);
}

export function bps(value: string | number): string {
  return `${(Number(value) / 100).toFixed(Number(value) % 100 === 0 ? 0 : 2)}%`;
}

export function shortAddress(value: string, lead = 6, tail = 4): string {
  return `${value.slice(0, lead)}...${value.slice(-tail)}`;
}

export function shortHash(value: string): string {
  return shortAddress(value, 10, 8);
}

export function formatDate(value: string | number): string {
  const date = typeof value === "number" ? new Date(value * 1_000) : new Date(value);
  return new Intl.DateTimeFormat("en-US", {
    month: "short",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    timeZone: "UTC",
    timeZoneName: "short",
  }).format(date);
}

export function duration(seconds: string | number): string {
  const value = Number(seconds);
  if (value % 3600 === 0) return `${value / 3600}h`;
  if (value % 60 === 0) return `${value / 60}m`;
  return `${value}s`;
}

export function number(value: string | number): string {
  return new Intl.NumberFormat("en-US").format(Number(value));
}

export function unixDate(seconds: string): string {
  return formatDate(Number(seconds));
}
