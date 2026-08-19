import { createHmac, randomUUID } from "node:crypto";
import { shortId, stableStringify } from "../domain/hash.js";
import type { LiveAlert } from "./archive-schemas.js";
import { operationalErrorMessage } from "./redaction.js";
import {
  createAlertDelivery,
  createOperationalEvent,
  type LiveAlertDelivery,
  type LiveOperationalStore,
} from "./operations.js";

export interface AlertSinkDeliveryContext {
  idempotencyKey: string;
  attemptedAt: string;
  signal: AbortSignal;
}

export interface AlertSinkDeliveryResult {
  responseStatus: number | null;
}

export interface AlertSink {
  readonly id: string;
  deliver(
    alert: LiveAlert,
    context: AlertSinkDeliveryContext,
  ): Promise<AlertSinkDeliveryResult>;
}

export type AlertDeliveryOutcomeStatus =
  | "DELIVERED"
  | "FAILED"
  | "ALREADY_DELIVERED"
  | "LEASED"
  | "DEFERRED"
  | "EXHAUSTED";

export interface AlertDeliveryOutcome {
  alertId: string;
  sinkId: string;
  status: AlertDeliveryOutcomeStatus;
  attempts: number;
  responseStatus: number | null;
  reason: string | null;
}

export interface AlertDeliveryRunResult {
  outcomes: AlertDeliveryOutcome[];
  delivered: number;
  failed: number;
  skipped: number;
}

export interface LiveAlertDeliveryServiceOptions {
  store: LiveOperationalStore;
  sinks: readonly AlertSink[];
  now?: () => Date;
  sleep?: (milliseconds: number) => Promise<void>;
  maxAttemptsPerRun?: number;
  maxTotalAttempts?: number;
  retryBackoffMs?: number;
  maxRetryBackoffMs?: number;
  deliveryTimeoutMs?: number;
  leaseMs?: number;
}

export class LiveAlertDeliveryService {
  constructor(private readonly options: LiveAlertDeliveryServiceOptions) {
    const sinkIds = options.sinks.map((sink) => sink.id);
    if (new Set(sinkIds).size !== sinkIds.length) {
      throw new Error("Alert sink IDs must be unique.");
    }
  }

  async deliver(alerts: readonly LiveAlert[]): Promise<AlertDeliveryRunResult> {
    const outcomes: AlertDeliveryOutcome[] = [];
    for (const alert of alerts) {
      for (const sink of this.options.sinks) {
        outcomes.push(await this.deliverOne(alert, sink));
      }
    }
    return {
      outcomes,
      delivered: outcomes.filter((outcome) => outcome.status === "DELIVERED").length,
      failed: outcomes.filter((outcome) => outcome.status === "FAILED").length,
      skipped: outcomes.filter((outcome) =>
        outcome.status !== "DELIVERED" && outcome.status !== "FAILED"
      ).length,
    };
  }

  private async deliverOne(alert: LiveAlert, sink: AlertSink): Promise<AlertDeliveryOutcome> {
    const existing = await this.options.store.alertDelivery(alert.alertId, sink.id);
    if (existing?.status === "DELIVERED") {
      return outcome(alert, sink, existing, "ALREADY_DELIVERED", null);
    }

    const now = this.now();
    if (existing?.nextAttemptAt && existing.nextAttemptAt > now.toISOString()) {
      return outcome(alert, sink, existing, "DEFERRED", "The bounded retry window has not elapsed.");
    }

    const maxTotalAttempts = boundedInteger(this.options.maxTotalAttempts ?? 6, 1, 20);
    if (existing && existing.attempts >= maxTotalAttempts && existing.nextAttemptAt === null) {
      return outcome(alert, sink, existing, "EXHAUSTED", "The configured delivery attempt limit was reached.");
    }

    const delivery = existing ?? createAlertDelivery({ alert, sinkId: sink.id, now: now.toISOString() });
    const leaseId = randomUUID();
    const leaseMs = boundedInteger(this.options.leaseMs ?? 120_000, 1_000, 600_000);
    const claimed = await this.options.store.claimAlertDelivery(delivery, {
      leaseId,
      claimedAt: now.toISOString(),
      leaseExpiresAt: new Date(now.getTime() + leaseMs).toISOString(),
    });
    if (!claimed) {
      const latest = await this.options.store.alertDelivery(alert.alertId, sink.id) ?? delivery;
      return outcome(alert, sink, latest, "LEASED", "Another worker owns the delivery lease.");
    }

    const maxAttemptsPerRun = boundedInteger(this.options.maxAttemptsPerRun ?? 3, 1, 5);
    const attemptsThisRun = Math.min(maxAttemptsPerRun, maxTotalAttempts - delivery.attempts);
    let attempts = delivery.attempts;
    let responseStatus: number | null = null;
    let lastError: string | null = null;

    for (let runAttempt = 1; runAttempt <= attemptsThisRun; runAttempt += 1) {
      attempts += 1;
      const attemptedAt = this.now();
      const startedAt = attemptedAt.toISOString();
      await this.record(createOperationalEvent({
        eventType: "ALERT_DELIVERY_ATTEMPTED",
        healthState: "HEALTHY",
        snapshotHash: alert.snapshotHash,
        block: alert.block,
        startedAt,
        completedAt: startedAt,
        durationMs: 0,
        payload: { alertId: alert.alertId, sinkId: sink.id, attempt: attempts },
      }));

      try {
        const result = await withAbortTimeout(
          (signal) => sink.deliver(alert, {
            idempotencyKey: delivery.idempotencyKey,
            attemptedAt: startedAt,
            signal,
          }),
          this.options.deliveryTimeoutMs ?? 10_000,
          `Alert sink ${sink.id} timed out.`,
        );
        responseStatus = result.responseStatus;
        const completedAt = this.now().toISOString();
        const delivered = createAlertDelivery({
          alert,
          sinkId: sink.id,
          now: completedAt,
          status: "DELIVERED",
          attempts,
          responseStatus,
          lastAttemptAt: startedAt,
          deliveredAt: completedAt,
          createdAt: delivery.createdAt,
        });
        const completed = await this.options.store.completeAlertDelivery(delivered, leaseId);
        if (!completed) {
          const latest = await this.options.store.alertDelivery(alert.alertId, sink.id) ?? delivered;
          return outcome(
            alert,
            sink,
            latest,
            latest.status === "DELIVERED" ? "ALREADY_DELIVERED" : "LEASED",
            "Delivery completed after its storage lease changed; canonical state was not overwritten.",
          );
        }
        await this.record(createOperationalEvent({
          eventType: "ALERT_DELIVERY_SUCCEEDED",
          healthState: "HEALTHY",
          snapshotHash: alert.snapshotHash,
          block: alert.block,
          startedAt,
          completedAt,
          durationMs: elapsedMs(attemptedAt, completedAt),
          payload: { alertId: alert.alertId, sinkId: sink.id, attempt: attempts, responseStatus },
        }));
        return outcome(alert, sink, delivered, "DELIVERED", null);
      } catch (error) {
        responseStatus = error instanceof AlertSinkDeliveryError ? error.responseStatus : null;
        lastError = safeErrorMessage(error);
        const completedAt = this.now().toISOString();
        await this.record(createOperationalEvent({
          eventType: "ALERT_DELIVERY_FAILED",
          healthState: "DEGRADED",
          snapshotHash: alert.snapshotHash,
          block: alert.block,
          startedAt,
          completedAt,
          durationMs: elapsedMs(attemptedAt, completedAt),
          payload: {
            alertId: alert.alertId,
            sinkId: sink.id,
            attempt: attempts,
            responseStatus,
            error: lastError,
          },
        }));
        if (runAttempt < attemptsThisRun) {
          await (this.options.sleep ?? defaultSleep)(this.retryDelay(attempts));
        }
      }
    }

    const completedAt = this.now();
    const exhausted = attempts >= maxTotalAttempts;
    const failed = createAlertDelivery({
      alert,
      sinkId: sink.id,
      now: completedAt.toISOString(),
      status: "FAILED",
      attempts,
      responseStatus,
      lastError,
      lastAttemptAt: completedAt.toISOString(),
      nextAttemptAt: exhausted
        ? null
        : new Date(completedAt.getTime() + this.retryDelay(attempts)).toISOString(),
      createdAt: delivery.createdAt,
    });
    const completed = await this.options.store.completeAlertDelivery(failed, leaseId);
    if (!completed) {
      const latest = await this.options.store.alertDelivery(alert.alertId, sink.id) ?? failed;
      return outcome(
        alert,
        sink,
        latest,
        latest.status === "DELIVERED" ? "ALREADY_DELIVERED" : "LEASED",
        "The delivery lease changed before failure state could be persisted.",
      );
    }
    return outcome(alert, sink, failed, "FAILED", lastError);
  }

  private retryDelay(attempt: number): number {
    const base = boundedInteger(this.options.retryBackoffMs ?? 1_000, 0, 60_000);
    const maximum = boundedInteger(this.options.maxRetryBackoffMs ?? 60_000, base, 600_000);
    return Math.min(maximum, base * 2 ** Math.max(0, attempt - 1));
  }

  private now(): Date {
    return this.options.now?.() ?? new Date();
  }

  private async record(event: ReturnType<typeof createOperationalEvent>): Promise<void> {
    try {
      await this.options.store.saveOperationalEvent(event);
    } catch {
      // Delivery state remains authoritative when operational telemetry is unavailable.
    }
  }
}

export class ConsoleAlertSink implements AlertSink {
  readonly id = "console";

  constructor(
    private readonly logger: (line: string) => void = (line) => console.info(line),
  ) {}

  async deliver(alert: LiveAlert, context: AlertSinkDeliveryContext): Promise<AlertSinkDeliveryResult> {
    this.logger(stableStringify({
      event: "egress.live.alert",
      mode: "LIVE_READ_ONLY",
      idempotencyKey: context.idempotencyKey,
      alert,
      broadcastPermitted: false,
      transactionSubmitted: false,
    }));
    return { responseStatus: null };
  }
}

export interface WebhookAlertSinkOptions {
  url: string;
  secret: string;
  sinkId?: string;
  fetch?: typeof fetch;
}

export class WebhookAlertSink implements AlertSink {
  readonly id: string;
  private readonly url: string;
  private readonly secret: string;
  private readonly fetchImplementation: typeof fetch;

  constructor(options: WebhookAlertSinkOptions) {
    const url = validatedWebhookUrl(options.url);
    if (options.secret.length < 32) {
      throw new Error("Webhook signing secret must contain at least 32 characters.");
    }
    this.id = options.sinkId?.trim() || shortId("webhook", url.toString());
    this.url = url.toString();
    this.secret = options.secret;
    this.fetchImplementation = options.fetch ?? fetch;
  }

  async deliver(alert: LiveAlert, context: AlertSinkDeliveryContext): Promise<AlertSinkDeliveryResult> {
    const body = stableStringify({
      schemaVersion: 1,
      event: "egress.live.alert",
      mode: "LIVE_READ_ONLY",
      alert,
      broadcastPermitted: false,
      transactionSubmitted: false,
    });
    const signature = createHmac("sha256", this.secret)
      .update(`${context.attemptedAt}.${body}`, "utf8")
      .digest("hex");
    const response = await this.fetchImplementation(this.url, {
      method: "POST",
      body,
      signal: context.signal,
      redirect: "error",
      headers: {
        "content-type": "application/json",
        "idempotency-key": context.idempotencyKey,
        "x-egress-alert-id": alert.alertId,
        "x-egress-timestamp": context.attemptedAt,
        "x-egress-signature": `sha256=${signature}`,
      },
    });
    if (!response.ok) {
      throw new AlertSinkDeliveryError(
        `Webhook sink returned HTTP ${response.status}.`,
        response.status,
      );
    }
    return { responseStatus: response.status };
  }
}

export class AlertSinkDeliveryError extends Error {
  constructor(message: string, public readonly responseStatus: number | null) {
    super(message);
    this.name = "AlertSinkDeliveryError";
  }
}

function outcome(
  alert: LiveAlert,
  sink: AlertSink,
  delivery: LiveAlertDelivery,
  status: AlertDeliveryOutcomeStatus,
  reason: string | null,
): AlertDeliveryOutcome {
  return {
    alertId: alert.alertId,
    sinkId: sink.id,
    status,
    attempts: delivery.attempts,
    responseStatus: delivery.responseStatus,
    reason,
  };
}

function withAbortTimeout<T>(
  operation: (signal: AbortSignal) => Promise<T>,
  milliseconds: number,
  message: string,
): Promise<T> {
  const timeoutMs = boundedInteger(milliseconds, 1, 120_000);
  const controller = new AbortController();
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => {
      controller.abort();
      reject(new Error(message));
    }, timeoutMs);
    operation(controller.signal).then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error) => {
        clearTimeout(timer);
        reject(error);
      },
    );
  });
}

function validatedWebhookUrl(value: string): URL {
  const url = new URL(value);
  const local = url.hostname === "127.0.0.1" || url.hostname === "localhost";
  if (url.username || url.password) throw new Error("Webhook URL must not contain embedded credentials.");
  if (url.protocol !== "https:" && !(url.protocol === "http:" && local)) {
    throw new Error("Webhook URL must use HTTPS unless it targets a local test runtime.");
  }
  return url;
}

function elapsedMs(startedAt: Date, completedAt: string): number {
  return Math.max(0, new Date(completedAt).getTime() - startedAt.getTime());
}

function safeErrorMessage(error: unknown): string {
  return operationalErrorMessage(error);
}

function boundedInteger(value: number, minimum: number, maximum: number): number {
  if (!Number.isFinite(value)) return minimum;
  return Math.max(minimum, Math.min(maximum, Math.floor(value)));
}

function defaultSleep(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}
