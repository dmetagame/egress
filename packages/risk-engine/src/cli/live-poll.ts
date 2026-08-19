import {
  createLiveAlertDeliveryService,
  createLiveRevisionStore,
  createLiveSnapshotArchive,
  LiveRiskSnapshotService,
  LiveSnapshotPoller,
  readLiveRuntimeConfig,
} from "../index.js";

const config = readLiveRuntimeConfig(process.env);
if (config.issues.length > 0) {
  console.error(JSON.stringify({
    event: "egress.live.poller_configuration_invalid",
    mode: "LIVE_READ_ONLY",
    issues: config.issues,
    broadcastPermitted: false,
    transactionSubmitted: false,
  }));
  process.exitCode = 1;
} else {
  const archive = createLiveSnapshotArchive(config);
  const alertDelivery = createLiveAlertDeliveryService(config, archive);
  const poller = new LiveSnapshotPoller({
    archive,
    read: () => new LiveRiskSnapshotService({
      rpcUrl: config.rpcUrl,
      rpcUrls: config.rpcUrls,
      account: config.account,
      egressSpender: config.egressSpender,
      maxBlockAgeSeconds: config.maxBlockAgeSeconds,
      observationBlockNumber: config.observationBlockNumber,
      observationBlockHash: config.observationBlockHash,
      maxOracleAgeSeconds: config.maxOracleAgeSeconds,
      maxSourceAgeSeconds: config.maxSourceAgeSeconds,
      store: createLiveRevisionStore(config),
    }).read(),
    readTimeoutMs: config.pollReadTimeoutMs,
    archiveTimeoutMs: config.pollArchiveTimeoutMs,
    maxAttempts: config.pollMaxAttempts,
    retryBackoffMs: config.pollRetryBackoffMs,
    maxRetryBackoffMs: config.pollMaxRetryBackoffMs,
    failureThreshold: config.pollFailureThreshold,
    deliverAlerts: alertDelivery ? (alerts) => alertDelivery.deliver(alerts) : undefined,
    onResult: (result) => {
      console.info(JSON.stringify({
        event: "egress.live.poll_completed",
        mode: "LIVE_READ_ONLY",
        archiveStatus: result.archived.entry.snapshot.archiveStatus,
        snapshotHash: result.archived.entry.snapshot.snapshotHash,
        blockNumber: result.archived.entry.snapshot.observedBlock,
        snapshotInserted: result.archived.inserted,
        observationInserted: result.archived.observationInserted,
        alertTypes: result.alerts.map((alert) => alert.alertType),
        alertDelivery: result.delivery ? {
          delivered: result.delivery.delivered,
          failed: result.delivery.failed,
          skipped: result.delivery.skipped,
        } : null,
        pollerHealth: poller.getHealth(),
        broadcastPermitted: false,
        transactionSubmitted: false,
      }));
    },
  });

  const runOnce = process.argv.includes("--once");

  try {
    if (runOnce) {
      await poller.pollOnce();
    } else {
      const abort = new AbortController();
      process.once("SIGINT", () => abort.abort());
      process.once("SIGTERM", () => abort.abort());
      await poller.run(config.pollIntervalSeconds, abort.signal);
    }
  } catch (error) {
    console.error(JSON.stringify({
      event: "egress.live.poll_failed",
      mode: "LIVE_READ_ONLY",
      errorType: error instanceof Error ? error.name : "UnknownError",
      message: error instanceof Error ? error.message.split("\n")[0] : "Unknown polling failure",
      broadcastPermitted: false,
      transactionSubmitted: false,
    }));
    process.exitCode = 1;
  }
}
