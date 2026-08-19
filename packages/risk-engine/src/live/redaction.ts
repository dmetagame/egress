export function redactOperationalText(value: string, maximumLength = 500): string {
  return value
    .replace(/\b(?:https?|postgres(?:ql)?):\/\/[^\s"']+/gi, "[redacted-url]")
    .replace(/\b0x[0-9a-fA-F]{40}\b/g, "[redacted-address]")
    .replace(/\b(secret|password|token|private[_-]?key|mnemonic)=([^\s&]+)/gi, "$1=[redacted]")
    .slice(0, maximumLength);
}

export function operationalErrorMessage(error: unknown): string {
  const message = error instanceof Error
    ? (error.message.split("\n")[0] ?? error.name)
    : String(error);
  return redactOperationalText(message);
}
