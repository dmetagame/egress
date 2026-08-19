import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { RiskEventRecord, SourceDiff, SourceSnapshot } from "../domain/schemas.js";
import {
  riskEventRecordSchema,
  sourceDiffSchema,
  sourceSnapshotSchema,
} from "../domain/schemas.js";

export interface RevisionStore {
  latest(sourceId: string): Promise<SourceSnapshot | null>;
  getRevision(revisionId: string): Promise<SourceSnapshot | null>;
  getDiff(diffId: string): Promise<SourceDiff | null>;
  saveRevision(snapshot: SourceSnapshot, diff: SourceDiff): Promise<RevisionWriteResult>;
  updateExtractionStatus(
    revisionId: string,
    status: SourceSnapshot["extractionStatus"],
  ): Promise<void>;
}

export interface RevisionWriteResult {
  snapshot: SourceSnapshot;
  diff: SourceDiff;
  inserted: boolean;
}

export interface RiskEventStore {
  saveEvent(event: RiskEventRecord): Promise<void>;
  getEvent(riskEventId: string): Promise<RiskEventRecord | null>;
}

interface DatabaseShape {
  snapshots: SourceSnapshot[];
  diffs: SourceDiff[];
  events: RiskEventRecord[];
}

const EMPTY_DATABASE: DatabaseShape = { snapshots: [], diffs: [], events: [] };

export class JsonFileStore implements RevisionStore, RiskEventStore {
  constructor(private readonly filePath: string) {}

  async latest(sourceId: string): Promise<SourceSnapshot | null> {
    const database = await this.readDatabase();
    return (
      database.snapshots
        .filter((snapshot) => snapshot.sourceId === sourceId)
        .sort((a, b) => b.sourceVersion - a.sourceVersion)[0] ?? null
    );
  }

  async getRevision(revisionId: string): Promise<SourceSnapshot | null> {
    return (await this.readDatabase()).snapshots.find(
      (snapshot) => snapshot.revisionId === revisionId,
    ) ?? null;
  }

  async getDiff(diffId: string): Promise<SourceDiff | null> {
    return (await this.readDatabase()).diffs.find((diff) => diff.diffId === diffId) ?? null;
  }

  async saveRevision(snapshot: SourceSnapshot, diff: SourceDiff): Promise<RevisionWriteResult> {
    const database = await this.readDatabase();
    const existing = database.snapshots.find(
      (candidate) => candidate.revisionId === snapshot.revisionId,
    );
    if (existing) {
      const existingDiff = database.diffs.find(
        (candidate) => candidate.diffId === existing.diffId,
      );
      if (!existingDiff) throw new Error(`Source revision ${existing.revisionId} has no stored diff.`);
      return { snapshot: existing, diff: existingDiff, inserted: false };
    }
    const parsedSnapshot = sourceSnapshotSchema.parse(snapshot);
    const parsedDiff = sourceDiffSchema.parse(diff);
    database.snapshots.push(parsedSnapshot);
    database.diffs.push(parsedDiff);
    await this.writeDatabase(database);
    return { snapshot: parsedSnapshot, diff: parsedDiff, inserted: true };
  }

  async updateExtractionStatus(
    revisionId: string,
    status: SourceSnapshot["extractionStatus"],
  ): Promise<void> {
    const database = await this.readDatabase();
    const snapshot = database.snapshots.find(
      (candidate) => candidate.revisionId === revisionId,
    );
    if (!snapshot) throw new Error(`Unknown source revision ${revisionId}`);
    snapshot.extractionStatus = status;
    await this.writeDatabase(database);
  }

  async saveEvent(event: RiskEventRecord): Promise<void> {
    const database = await this.readDatabase();
    const parsed = riskEventRecordSchema.parse(event);
    const index = database.events.findIndex(
      (candidate) => candidate.riskEventId === parsed.riskEventId,
    );
    if (index >= 0) database.events[index] = parsed;
    else database.events.push(parsed);
    await this.writeDatabase(database);
  }

  async getEvent(riskEventId: string): Promise<RiskEventRecord | null> {
    return (await this.readDatabase()).events.find(
      (event) => event.riskEventId === riskEventId,
    ) ?? null;
  }

  private async readDatabase(): Promise<DatabaseShape> {
    try {
      const raw = await readFile(this.filePath, "utf8");
      const parsed = JSON.parse(raw) as DatabaseShape;
      return {
        snapshots: parsed.snapshots.map((value) => sourceSnapshotSchema.parse(value)),
        diffs: parsed.diffs.map((value) => sourceDiffSchema.parse(value)),
        events: parsed.events.map((value) => riskEventRecordSchema.parse(value)),
      };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return structuredClone(EMPTY_DATABASE);
      throw error;
    }
  }

  private async writeDatabase(database: DatabaseShape): Promise<void> {
    await mkdir(dirname(this.filePath), { recursive: true });
    const temporaryPath = `${this.filePath}.${process.pid}.tmp`;
    await writeFile(temporaryPath, `${JSON.stringify(database, null, 2)}\n`, "utf8");
    await rename(temporaryPath, this.filePath);
  }
}

export class InMemoryStore implements RevisionStore, RiskEventStore {
  readonly snapshots: SourceSnapshot[] = [];
  readonly diffs: SourceDiff[] = [];
  readonly events: RiskEventRecord[] = [];

  async latest(sourceId: string): Promise<SourceSnapshot | null> {
    return (
      this.snapshots
        .filter((snapshot) => snapshot.sourceId === sourceId)
        .sort((a, b) => b.sourceVersion - a.sourceVersion)[0] ?? null
    );
  }

  async getRevision(revisionId: string): Promise<SourceSnapshot | null> {
    return this.snapshots.find((snapshot) => snapshot.revisionId === revisionId) ?? null;
  }

  async getDiff(diffId: string): Promise<SourceDiff | null> {
    return this.diffs.find((diff) => diff.diffId === diffId) ?? null;
  }

  async saveRevision(snapshot: SourceSnapshot, diff: SourceDiff): Promise<RevisionWriteResult> {
    const existing = this.snapshots.find(
      (candidate) => candidate.revisionId === snapshot.revisionId,
    );
    if (existing) {
      const existingDiff = this.diffs.find(
        (candidate) => candidate.diffId === existing.diffId,
      );
      if (!existingDiff) throw new Error(`Source revision ${existing.revisionId} has no stored diff.`);
      return { snapshot: existing, diff: existingDiff, inserted: false };
    }
    const parsedSnapshot = sourceSnapshotSchema.parse(snapshot);
    const parsedDiff = sourceDiffSchema.parse(diff);
    this.snapshots.push(parsedSnapshot);
    this.diffs.push(parsedDiff);
    return { snapshot: parsedSnapshot, diff: parsedDiff, inserted: true };
  }

  async updateExtractionStatus(
    revisionId: string,
    status: SourceSnapshot["extractionStatus"],
  ): Promise<void> {
    const snapshot = this.snapshots.find(
      (candidate) => candidate.revisionId === revisionId,
    );
    if (!snapshot) throw new Error(`Unknown source revision ${revisionId}`);
    snapshot.extractionStatus = status;
  }

  async saveEvent(event: RiskEventRecord): Promise<void> {
    const parsed = riskEventRecordSchema.parse(event);
    const index = this.events.findIndex(
      (candidate) => candidate.riskEventId === parsed.riskEventId,
    );
    if (index >= 0) this.events[index] = parsed;
    else this.events.push(parsed);
  }

  async getEvent(riskEventId: string): Promise<RiskEventRecord | null> {
    return this.events.find((event) => event.riskEventId === riskEventId) ?? null;
  }
}

export function defaultStorePath(
  packageRoot = fileURLToPath(new URL("../../", import.meta.url)),
): string {
  return join(packageRoot, ".data", "egress-risk.json");
}
