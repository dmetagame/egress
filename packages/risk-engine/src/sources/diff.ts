import type {
  NormalizedLine,
  SourceDiff,
  SourceSnapshot,
} from "../domain/schemas.js";
import { shortId } from "../domain/hash.js";

interface DiffOperation {
  type: "equal" | "add" | "remove";
  oldLine?: NormalizedLine;
  newLine?: NormalizedLine;
}

const MAX_DIFF_LINES = 2_000;
const MAX_LCS_CELLS = 2_000_000;

function lineKey(line: NormalizedLine): string {
  return `${line.section}\u0000${line.text}`;
}

function diffLines(
  previous: readonly NormalizedLine[],
  current: readonly NormalizedLine[],
): DiffOperation[] {
  if (previous.length > MAX_DIFF_LINES || current.length > MAX_DIFF_LINES) {
    throw new Error(`Normalized source exceeds the ${MAX_DIFF_LINES}-line semantic diff limit`);
  }
  const rows = previous.length + 1;
  const columns = current.length + 1;
  if (rows * columns > MAX_LCS_CELLS) {
    throw new Error(
      `Semantic diff requires ${rows * columns} LCS cells, exceeding the ${MAX_LCS_CELLS}-cell safety limit`,
    );
  }
  const lcs = Array.from({ length: rows }, () => new Uint32Array(columns));

  for (let i = previous.length - 1; i >= 0; i -= 1) {
    for (let j = current.length - 1; j >= 0; j -= 1) {
      lcs[i]![j] =
        lineKey(previous[i]!) === lineKey(current[j]!)
          ? lcs[i + 1]![j + 1]! + 1
          : Math.max(lcs[i + 1]![j]!, lcs[i]![j + 1]!);
    }
  }

  const operations: DiffOperation[] = [];
  let i = 0;
  let j = 0;
  while (i < previous.length && j < current.length) {
    if (lineKey(previous[i]!) === lineKey(current[j]!)) {
      operations.push({ type: "equal", oldLine: previous[i], newLine: current[j] });
      i += 1;
      j += 1;
    } else if (lcs[i + 1]![j]! >= lcs[i]![j + 1]!) {
      operations.push({ type: "remove", oldLine: previous[i] });
      i += 1;
    } else {
      operations.push({ type: "add", newLine: current[j] });
      j += 1;
    }
  }
  while (i < previous.length) operations.push({ type: "remove", oldLine: previous[i++] });
  while (j < current.length) operations.push({ type: "add", newLine: current[j++] });
  return operations;
}

function canonicalMeaning(value: string): string {
  return value
    .toLowerCase()
    .normalize("NFKC")
    .replace(/[\p{P}\p{S}\s]+/gu, " ")
    .trim();
}

export function createSourceDiff(
  previous: SourceSnapshot | null,
  current: SourceSnapshot,
  generatedAt = new Date().toISOString(),
): SourceDiff {
  const operations = diffLines(previous?.normalized.lines ?? [], current.normalized.lines);
  const hunks: SourceDiff["hunks"] = [];
  let index = 0;

  while (index < operations.length) {
    if (operations[index]?.type === "equal") {
      index += 1;
      continue;
    }

    const group: DiffOperation[] = [];
    while (index < operations.length && operations[index]?.type !== "equal") {
      group.push(operations[index]!);
      index += 1;
    }

    const removed = group.flatMap((operation) => (operation.oldLine ? [operation.oldLine] : []));
    const added = group.flatMap((operation) => (operation.newLine ? [operation.newLine] : []));
    const section = added[0]?.section ?? removed[0]?.section ?? "Document";
    const hunkBase = {
      section,
      oldStartLine: removed[0]?.line ?? 0,
      oldEndLine: removed.at(-1)?.line ?? 0,
      newStartLine: added[0]?.line ?? 0,
      newEndLine: added.at(-1)?.line ?? 0,
      removedLines: removed.map((line) => line.text),
      addedLines: added.map((line) => line.text),
    };
    hunks.push({ hunkId: shortId("hunk", hunkBase), ...hunkBase });
  }

  const removedMeaning = canonicalMeaning(
    hunks.flatMap((hunk) => hunk.removedLines).join(" "),
  );
  const addedMeaning = canonicalMeaning(hunks.flatMap((hunk) => hunk.addedLines).join(" "));
  const cosmeticOnly = hunks.length > 0 && removedMeaning === addedMeaning;
  const kind = previous ? "CHANGED" : "INITIAL";
  const diffBase = {
    sourceId: current.sourceId,
    fromRevisionId: previous?.revisionId ?? null,
    toRevisionId: current.revisionId,
    generatedAt,
    kind,
    cosmeticOnly,
    summary:
      kind === "INITIAL"
        ? `Initial snapshot with ${current.normalized.lines.length} normalized lines.`
        : cosmeticOnly
          ? "Only formatting or punctuation changed."
          : `${hunks.length} changed section${hunks.length === 1 ? "" : "s"}: ${hunks
              .map((hunk) => hunk.section)
              .join(", ")}.`,
    hunks,
  } as const;

  return { diffId: shortId("diff", diffBase), ...diffBase };
}
