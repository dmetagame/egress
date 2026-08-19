import type { SourceDefinition, SourceDiff, SourceSnapshot } from "../domain/schemas.js";
import { sha256, shortId } from "../domain/hash.js";
import type { SourceFetcher } from "./fetcher.js";
import { normalizeHtml } from "./normalize.js";
import { createSourceDiff } from "./diff.js";
import type { RevisionStore } from "./store.js";

export type IngestionResult =
  | { status: "UNCHANGED"; snapshot: SourceSnapshot; retrievedAt: string }
  | { status: "CREATED"; snapshot: SourceSnapshot; diff: SourceDiff };

export class SourceIngestionService {
  constructor(
    private readonly fetcher: SourceFetcher,
    private readonly store: RevisionStore,
  ) {}

  async ingest(source: SourceDefinition): Promise<IngestionResult> {
    const retrieved = await this.fetcher.fetch(source);
    const normalized = normalizeHtml(retrieved.rawContent, source);
    if (normalized.lines.length === 0 || normalized.text.length < 40) {
      throw new Error(`Source ${source.id} normalized to insufficient content`);
    }

    const previous = await this.store.latest(source.id);
    const contentHash = sha256(normalized.text);
    if (previous?.contentHash === contentHash) {
      return { status: "UNCHANGED", snapshot: previous, retrievedAt: retrieved.retrievedAt };
    }

    const sourceVersion = (previous?.sourceVersion ?? 0) + 1;
    const revisionBase = {
      sourceId: source.id,
      sourceVersion,
      contentHash,
    };
    const revisionId = shortId("rev", revisionBase);
    const provisional: SourceSnapshot = {
      revisionId,
      sourceId: source.id,
      sourceUrl: source.url,
      sourceVersion,
      retrievedAt: retrieved.retrievedAt,
      contentHash,
      rawContentHash: sha256(retrieved.rawContent),
      rawContent: retrieved.rawContent,
      normalized,
      previousRevisionId: previous?.revisionId ?? null,
      diffId: null,
      extractionStatus: "PENDING",
      responseMetadata: retrieved.responseMetadata,
    };
    const diff = createSourceDiff(previous, provisional, retrieved.retrievedAt);
    const snapshot = { ...provisional, diffId: diff.diffId };
    const persisted = await this.store.saveRevision(snapshot, diff);
    return { status: "CREATED", snapshot: persisted.snapshot, diff: persisted.diff };
  }

  async setExtractionStatus(
    revisionId: string,
    status: SourceSnapshot["extractionStatus"],
  ): Promise<void> {
    await this.store.updateExtractionStatus(revisionId, status);
  }
}
