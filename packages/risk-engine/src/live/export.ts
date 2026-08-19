import { stableStringify } from "../domain/hash.js";
import {
  liveArchiveHistoryEntrySchema,
  type ArchivedLiveSnapshot,
} from "./archive-schemas.js";
import {
  createObservation,
  parseArchivedSnapshot,
  type LiveSnapshotArchive,
} from "./archive.js";

export const LIVE_SNAPSHOT_EXPORT_VERSION = 1 as const;

export interface LiveSnapshotExport {
  exportVersion: typeof LIVE_SNAPSHOT_EXPORT_VERSION;
  snapshot: ArchivedLiveSnapshot;
  observation: ReturnType<typeof createObservation> | null;
}

export function exportArchivedLiveSnapshot(
  record: ArchivedLiveSnapshot,
  observedAt?: string,
): string {
  const snapshot = parseArchivedSnapshot(record);
  const observation = observedAt
    ? createObservation(snapshot.snapshotHash as `0x${string}`, observedAt)
    : null;
  return stableStringify({
    exportVersion: LIVE_SNAPSHOT_EXPORT_VERSION,
    snapshot,
    observation,
  });
}

export function parseLiveSnapshotExport(value: string | unknown): LiveSnapshotExport {
  const parsed = typeof value === "string" ? JSON.parse(value) : value;
  if (!parsed || typeof parsed !== "object") throw new Error("Live snapshot export must be an object.");
  const candidate = parsed as Record<string, unknown>;
  if (candidate.exportVersion !== LIVE_SNAPSHOT_EXPORT_VERSION) {
    throw new Error(`Unsupported live snapshot export version: ${String(candidate.exportVersion)}.`);
  }
  const snapshot = parseArchivedSnapshot(candidate.snapshot);
  const observation = candidate.observation === null || candidate.observation === undefined
    ? null
    : liveArchiveHistoryEntrySchema.shape.observation.parse(candidate.observation);
  if (observation && observation.snapshotHash.toLowerCase() !== snapshot.snapshotHash.toLowerCase()) {
    throw new Error("Export observation does not reference the exported snapshot.");
  }
  return { exportVersion: LIVE_SNAPSHOT_EXPORT_VERSION, snapshot, observation };
}

export async function importArchivedLiveSnapshot(
  archive: LiveSnapshotArchive,
  value: string | unknown,
  observedAt?: string,
): Promise<Awaited<ReturnType<LiveSnapshotArchive["archive"]>>> {
  const parsed = parseLiveSnapshotExport(value);
  return archive.archive(
    parsed.snapshot,
    observedAt ?? parsed.observation?.observedAt ?? parsed.snapshot.createdAt,
  );
}
