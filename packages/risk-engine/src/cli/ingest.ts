import { JsonFileStore, defaultStorePath } from "../sources/store.js";
import { AllowlistedHttpSourceFetcher } from "../sources/fetcher.js";
import { SourceIngestionService } from "../sources/ingest.js";
import { AUTHORITATIVE_OKX_SOURCES } from "../sources/registry.js";

const store = new JsonFileStore(defaultStorePath());
const ingestion = new SourceIngestionService(
  new AllowlistedHttpSourceFetcher(),
  store,
);

for (const source of AUTHORITATIVE_OKX_SOURCES) {
  try {
    const result = await ingestion.ingest(source);
    if (result.status === "UNCHANGED") {
      process.stdout.write(
        `${source.id}: UNCHANGED ${result.snapshot.revisionId} (${result.snapshot.normalized.lines.length} lines)\n`,
      );
      continue;
    }
    process.stdout.write(
      `${source.id}: CREATED ${result.snapshot.revisionId} v${result.snapshot.sourceVersion} (${result.snapshot.normalized.lines.length} lines, ${result.diff.hunks.length} hunks)\n`,
    );
  } catch (error) {
    process.stderr.write(
      `${source.id}: FAILED ${error instanceof Error ? error.message : String(error)}\n`,
    );
    process.exitCode = 1;
  }
}
