import { readFile, writeFile } from "node:fs/promises";
import {
  createLiveSnapshotArchive,
  exportArchivedLiveSnapshot,
  importArchivedLiveSnapshot,
  readLiveRuntimeConfig,
  retentionWindows,
  DEFAULT_LIVE_RETENTION_POLICY,
} from "../index.js";

const command = process.argv[2];

if (command === "retention") {
  console.info(JSON.stringify({
    event: "egress.live.retention_review",
    policy: DEFAULT_LIVE_RETENTION_POLICY,
    windows: retentionWindows(),
    automaticPruning: false,
  }, null, 2));
} else if (command === "export") {
  await exportSnapshot();
} else if (command === "import") {
  await importSnapshot();
} else {
  console.error("Usage: snapshot-archive.ts <retention|export|import> [--hash <hash>] [--input <file>] [--output <file>]");
  process.exitCode = 1;
}

async function exportSnapshot(): Promise<void> {
  const config = readLiveRuntimeConfig(process.env);
  if (config.issues.length > 0) return fail(config.issues.join(" "));
  const hash = argument("--hash");
  if (!hash) return fail("--hash is required for export.");
  const archive = createLiveSnapshotArchive(config);
  const snapshot = await archive.get(hash);
  if (!snapshot) return fail(`Snapshot ${hash} was not found.`);
  const observedAt = (await archive.history({ limit: 250 }))
    .find((entry) => entry.snapshot.snapshotHash.toLowerCase() === hash.toLowerCase())
    ?.observation.observedAt;
  const serialized = exportArchivedLiveSnapshot(snapshot, observedAt);
  const output = argument("--output");
  if (output) await writeFile(output, `${serialized}\n`, "utf8");
  else process.stdout.write(`${serialized}\n`);
  console.error(JSON.stringify({
    event: "egress.live.snapshot_exported",
    snapshotHash: snapshot.snapshotHash,
    output: output ?? "stdout",
    broadcastPermitted: false,
    transactionSubmitted: false,
  }));
}

async function importSnapshot(): Promise<void> {
  const config = readLiveRuntimeConfig(process.env);
  if (config.issues.length > 0) return fail(config.issues.join(" "));
  const input = argument("--input");
  if (!input) return fail("--input is required for import.");
  const archive = createLiveSnapshotArchive(config);
  const serialized = await readFile(input, "utf8");
  const result = await importArchivedLiveSnapshot(archive, serialized);
  console.info(JSON.stringify({
    event: "egress.live.snapshot_imported",
    snapshotHash: result.entry.snapshot.snapshotHash,
    snapshotInserted: result.inserted,
    observationInserted: result.observationInserted,
    broadcastPermitted: false,
    transactionSubmitted: false,
  }));
}

function argument(name: string): string | undefined {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

function fail(message: string): never {
  console.error(JSON.stringify({
    event: "egress.live.snapshot_archive_failed",
    message,
    broadcastPermitted: false,
    transactionSubmitted: false,
  }));
  process.exitCode = 1;
  throw new Error(message);
}
