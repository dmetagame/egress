import { objectHash, shortId } from "../domain/hash.js";
import {
  archivedLiveSnapshotSchema,
  liveAlertSchema,
  liveSnapshotObservationSchema,
  type ArchivedLiveSnapshot,
  type LiveAlert,
  type LiveArchiveHistoryEntry,
  type LiveArchiveStatus,
  type LiveSnapshotObservation,
} from "./archive-schemas.js";
import {
  canonicalEnvelopeState,
  liveSnapshotStateHash,
  protocolConfigurationHash,
  verifyEnvelopeStateHash,
} from "./canonical.js";
import type { LiveSnapshotEnvelope } from "./schemas.js";

const ONCHAIN_ADAPTERS = new Set([
  "xlayer",
  "configuration",
  "aave",
  "xbeth",
  "oracle",
  "uniswap-pool",
  "uniswap",
]);

export interface ArchiveWriteResult {
  inserted: boolean;
  observationInserted: boolean;
  entry: LiveArchiveHistoryEntry;
}

export interface AlertWriteResult {
  inserted: LiveAlert[];
  duplicates: LiveAlert[];
}

export interface LiveSnapshotArchive {
  archive(record: ArchivedLiveSnapshot, observedAt?: string): Promise<ArchiveWriteResult>;
  current(): Promise<LiveArchiveHistoryEntry | null>;
  history(options?: { limit?: number; before?: string }): Promise<LiveArchiveHistoryEntry[]>;
  get(snapshotHash: string): Promise<ArchivedLiveSnapshot | null>;
  saveAlerts(alerts: readonly LiveAlert[]): Promise<AlertWriteResult>;
  alerts(options?: { limit?: number; before?: string }): Promise<LiveAlert[]>;
}

export function buildArchivedLiveSnapshot(
  envelope: LiveSnapshotEnvelope,
  createdAt = envelope.generatedAt,
): ArchivedLiveSnapshot {
  const consistencyReasons = blockConsistencyReasons(envelope);
  const calculatedSnapshotHash = envelope.snapshot
    ? liveSnapshotStateHash(envelope.snapshot)
    : objectHash(canonicalEnvelopeState(envelope));
  const claimedHashMatches = !envelope.snapshot ||
    envelope.snapshot.snapshotHash.toLowerCase() === calculatedSnapshotHash.toLowerCase();
  if (!claimedHashMatches) {
    consistencyReasons.push("SNAPSHOT_INTEGRITY_FAILURE: claimed snapshot hash does not match canonical state.");
  }

  const archiveStatus = classifyArchiveStatus(envelope, consistencyReasons, claimedHashMatches);
  const snapshot = envelope.snapshot;
  const position = snapshot?.aave.position ?? envelope.partial.position;
  const oracle = snapshot?.oracle ?? envelope.partial.oracle;
  const liquidity = snapshot?.marketContext.liquidity ?? envelope.partial.liquidity;
  const rwaEvidence = snapshot?.rwa ?? envelope.partial.rwa;
  const policyEvaluation = snapshot?.executionPreview.policyEvaluation ??
    envelope.partial.executionPreview?.policyEvaluation ?? null;
  const executionPreview = snapshot?.executionPreview ?? envelope.partial.executionPreview;
  const chain = snapshot?.chain ?? envelope.partial.chain;
  const adapterVersions = snapshot?.adapterVersions ?? Object.fromEntries(
    envelope.adapters.map((adapter) => [adapter.adapter, adapter.version]),
  );
  const provenance = [...new Set([
    ...envelope.adapters.flatMap((adapter) => adapter.provenance),
    ...(rwaEvidence?.sourceStates.flatMap((source) => [
      source.sourceUrl,
      source.revisionId,
      source.contentHash,
    ]) ?? []),
  ])].sort();

  const recordWithoutIntegrity = {
    schemaVersion: 1 as const,
    snapshotHash: calculatedSnapshotHash,
    archiveStatus,
    consistencyStatus: blockConsistencyReasons(envelope).length === 0
      ? "CONSISTENT" as const
      : "INCONSISTENT_BLOCK_DATA" as const,
    consistencyReasons: [...new Set(consistencyReasons)],
    integrityValid: claimedHashMatches,
    chainId: chain?.chainId ?? null,
    account: snapshot?.account ?? envelope.partial.account,
    observedBlock: chain?.blockNumber ?? null,
    blockHash: chain?.blockHash ?? null,
    timestamp: chain?.blockTimestamp ?? envelope.generatedAt,
    position,
    oracle,
    liquidity,
    rwaEvidence,
    freshness: {
      allCriticalFresh: archiveStatus === "COMPLETE",
      adapters: envelope.adapters,
    },
    riskClassification: archiveStatus === "COMPLETE"
      ? rwaEvidence?.riskLevel ?? null
      : null,
    policyEvaluation,
    executionPreview,
    adapterVersions,
    configurationHash: protocolConfigurationHash(envelope),
    provenance,
    envelope,
    broadcastPermitted: false as const,
    transactionSubmitted: false as const,
    createdAt,
  };
  return archivedLiveSnapshotSchema.parse({
    ...recordWithoutIntegrity,
    integrityHash: objectHash(recordWithoutIntegrity),
  });
}

export function verifyArchivedLiveSnapshot(record: ArchivedLiveSnapshot): boolean {
  const parsed = archivedLiveSnapshotSchema.safeParse(record);
  if (!parsed.success) return false;
  const { integrityHash, ...payload } = parsed.data;
  if (integrityHash.toLowerCase() !== objectHash(payload).toLowerCase()) return false;
  return verifyEnvelopeStateHash(parsed.data.envelope, parsed.data.snapshotHash);
}

export function createObservation(
  snapshotHash: `0x${string}`,
  observedAt: string,
): LiveSnapshotObservation {
  return liveSnapshotObservationSchema.parse({
    observationId: shortId("observation", { snapshotHash, observedAt }),
    snapshotHash,
    observedAt,
  });
}

export function parseArchivedSnapshot(value: unknown): ArchivedLiveSnapshot {
  const record = archivedLiveSnapshotSchema.parse(value);
  if (!verifyArchivedLiveSnapshot(record)) {
    throw new Error(`Snapshot integrity verification failed for ${record.snapshotHash}.`);
  }
  return record;
}

export function parseLiveAlert(value: unknown): LiveAlert {
  return liveAlertSchema.parse(value);
}

export function blockConsistencyReasons(envelope: LiveSnapshotEnvelope): string[] {
  const reasons: string[] = [];
  const chain = envelope.snapshot?.chain ?? envelope.partial.chain;
  if (!chain) return reasons;
  const expectedBlock = chain.blockNumber;
  const position = envelope.snapshot?.aave.position ?? envelope.partial.position;
  const liquidity = envelope.snapshot?.marketContext.liquidity ?? envelope.partial.liquidity;

  if (position && position.blockNumber !== expectedBlock) {
    reasons.push(`INCONSISTENT_BLOCK_DATA: Aave position block ${position.blockNumber} != ${expectedBlock}.`);
  }
  if (liquidity && liquidity.blockNumber !== expectedBlock) {
    reasons.push(`INCONSISTENT_BLOCK_DATA: Uniswap quote block ${liquidity.blockNumber} != ${expectedBlock}.`);
  }
  for (const adapter of envelope.adapters) {
    if (!ONCHAIN_ADAPTERS.has(adapter.adapter) || adapter.status !== "AVAILABLE") continue;
    if (adapter.freshness.blockNumber === null) {
      reasons.push(`INCONSISTENT_BLOCK_DATA: ${adapter.adapter} omitted block metadata.`);
      continue;
    }
    if (adapter.freshness.blockNumber !== expectedBlock) {
      reasons.push(
        `INCONSISTENT_BLOCK_DATA: ${adapter.adapter} block ${adapter.freshness.blockNumber} != ${expectedBlock}.`,
      );
    }
  }
  return reasons;
}

function classifyArchiveStatus(
  envelope: LiveSnapshotEnvelope,
  consistencyReasons: readonly string[],
  integrityValid: boolean,
): LiveArchiveStatus {
  if (
    !integrityValid ||
    consistencyReasons.length > 0 ||
    envelope.adapters.some((adapter) => adapter.status === "INVALID_CONFIGURATION")
  ) {
    return "INVALID";
  }
  if (envelope.adapters.some((adapter) => adapter.status === "STALE")) return "STALE";
  if (
    envelope.status === "AVAILABLE" &&
    envelope.snapshot !== null &&
    envelope.snapshot.freshness.allRequiredFresh &&
    envelope.adapters.every((adapter) => adapter.status === "AVAILABLE") &&
    envelope.snapshot.executionPreview.broadcastPermitted === false &&
    envelope.snapshot.executionPreview.transactionSubmitted === false
  ) {
    return "COMPLETE";
  }
  return "UNAVAILABLE";
}
