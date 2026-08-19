import {
  executionSimulationSchema,
  executionStagingHealthSchema,
  executionStagingIntentSchema,
  executionSubmissionSchema,
  executionSubmissionReservationSchema,
  executionWorkerEventSchema,
  verifyExecutionSimulation,
  verifyExecutionStagingIntent,
  verifyExecutionSubmission,
  verifyExecutionSubmissionReservation,
  verifyExecutionWorkerEvent,
  type ExecutionSimulation,
  type ExecutionStagingHealth,
  type ExecutionStagingIntent,
  type ExecutionSubmission,
  type ExecutionSubmissionReservation,
  type ExecutionWorkerEvent,
  type LatestIntentSummary,
  type LatestReservationSummary,
  type LatestSimulationSummary,
  type LatestSubmissionSummary,
} from "./schemas.js";
import type { ExecutionStagingConfig } from "./config.js";
import { operationalErrorMessage } from "../live/redaction.js";

export interface StagingSnapshotReader {
  get(snapshotHash: string): Promise<import("../live/archive-schemas.js").ArchivedLiveSnapshot | null>;
}

export interface ExecutionStagingStore {
  saveIntent(intent: ExecutionStagingIntent): Promise<{ inserted: boolean; intent: ExecutionStagingIntent }>;
  getIntent(intentHash: string): Promise<ExecutionStagingIntent | null>;
  saveSimulation(simulation: ExecutionSimulation): Promise<{ inserted: boolean; simulation: ExecutionSimulation }>;
  getSimulation(intentHash: string): Promise<ExecutionSimulation | null>;
  saveSubmission(submission: ExecutionSubmission): Promise<{ inserted: boolean; submission: ExecutionSubmission }>;
  reserveSubmission(reservation: ExecutionSubmissionReservation): Promise<{ inserted: boolean; reservation: ExecutionSubmissionReservation }>;
  getSubmission(intentHash: string): Promise<ExecutionSubmission | null>;
  saveWorkerEvent(event: ExecutionWorkerEvent): Promise<{ inserted: boolean }>;
  latestIntent(): Promise<LatestIntentSummary | null>;
  latestSimulation(): Promise<LatestSimulationSummary | null>;
  latestReservation(): Promise<LatestReservationSummary | null>;
  latestSubmission(): Promise<LatestSubmissionSummary | null>;
  latestWorkerEvent(): Promise<ExecutionWorkerEvent | null>;
  databaseHealth(): Promise<{ state: "HEALTHY" | "DEGRADED" | "UNAVAILABLE"; latencyMs: number | null; reason: string | null }>;
}

export class InMemoryExecutionStagingStore implements ExecutionStagingStore {
  private readonly intents = new Map<string, ExecutionStagingIntent>();
  private readonly simulations = new Map<string, ExecutionSimulation>();
  private readonly submissions = new Map<string, ExecutionSubmission>();
  private readonly reservations = new Map<string, ExecutionSubmissionReservation>();
  private readonly events = new Map<string, ExecutionWorkerEvent>();

  async saveIntent(intent: ExecutionStagingIntent): Promise<{ inserted: boolean; intent: ExecutionStagingIntent }> {
    const parsed = executionStagingIntentSchema.parse(intent);
    if (!verifyExecutionStagingIntent(parsed)) throw new Error("Execution intent integrity verification failed.");
    const existing = this.intents.get(parsed.intentHash.toLowerCase());
    if (existing) {
      if (existing.integrityHash.toLowerCase() !== parsed.integrityHash.toLowerCase()) {
        throw new Error("Execution intent hash collision or immutable payload mismatch.");
      }
      return { inserted: false, intent: structuredClone(existing) };
    }
    for (const candidate of this.intents.values()) {
      if (candidate.requestHash.toLowerCase() === parsed.requestHash.toLowerCase() && candidate.intentHash.toLowerCase() !== parsed.intentHash.toLowerCase()) {
        throw new Error("Execution request hash already maps to a different immutable intent.");
      }
    }
    this.intents.set(parsed.intentHash.toLowerCase(), structuredClone(parsed));
    return { inserted: true, intent: structuredClone(parsed) };
  }

  async getIntent(intentHash: string): Promise<ExecutionStagingIntent | null> {
    const value = this.intents.get(intentHash.toLowerCase());
    return value ? structuredClone(value) : null;
  }

  async saveSimulation(simulation: ExecutionSimulation): Promise<{ inserted: boolean; simulation: ExecutionSimulation }> {
    const parsed = executionSimulationSchema.parse(simulation);
    if (!verifyExecutionSimulation(parsed)) throw new Error("Execution simulation integrity verification failed.");
    const existing = [...this.simulations.values()].find((value) => value.intentHash.toLowerCase() === parsed.intentHash.toLowerCase());
    if (existing) {
      if (existing.integrityHash.toLowerCase() !== parsed.integrityHash.toLowerCase()) {
        throw new Error("Execution simulation for an intent is immutable and cannot be replaced.");
      }
      return { inserted: false, simulation: structuredClone(existing) };
    }
    this.simulations.set(parsed.simulationHash.toLowerCase(), structuredClone(parsed));
    return { inserted: true, simulation: structuredClone(parsed) };
  }

  async getSimulation(intentHash: string): Promise<ExecutionSimulation | null> {
    const value = [...this.simulations.values()].find((candidate) => candidate.intentHash.toLowerCase() === intentHash.toLowerCase());
    return value ? structuredClone(value) : null;
  }

  async saveSubmission(submission: ExecutionSubmission): Promise<{ inserted: boolean; submission: ExecutionSubmission }> {
    const parsed = executionSubmissionSchema.parse(submission);
    if (!verifyExecutionSubmission(parsed)) throw new Error("Execution submission integrity verification failed.");
    const existing = [...this.submissions.values()].find((value) => value.intentHash.toLowerCase() === parsed.intentHash.toLowerCase());
    if (existing) {
      if (existing.integrityHash.toLowerCase() !== parsed.integrityHash.toLowerCase()) {
        throw new Error("Execution submission for an intent is immutable and cannot be replaced.");
      }
      return { inserted: false, submission: structuredClone(existing) };
    }
    this.submissions.set(parsed.submissionHash.toLowerCase(), structuredClone(parsed));
    return { inserted: true, submission: structuredClone(parsed) };
  }

  async reserveSubmission(reservation: ExecutionSubmissionReservation): Promise<{ inserted: boolean; reservation: ExecutionSubmissionReservation }> {
    const parsed = executionSubmissionReservationSchema.parse(reservation);
    if (!verifyExecutionSubmissionReservation(parsed)) {
      throw new Error("Execution submission reservation integrity verification failed.");
    }
    const key = parsed.intentHash.toLowerCase();
    const existing = this.reservations.get(key);
    if (existing) return { inserted: false, reservation: structuredClone(existing) };
    this.reservations.set(key, structuredClone(parsed));
    return { inserted: true, reservation: structuredClone(parsed) };
  }

  async getSubmission(intentHash: string): Promise<ExecutionSubmission | null> {
    const value = [...this.submissions.values()].find((candidate) => candidate.intentHash.toLowerCase() === intentHash.toLowerCase());
    return value ? structuredClone(value) : null;
  }

  async saveWorkerEvent(event: ExecutionWorkerEvent): Promise<{ inserted: boolean }> {
    const parsed = executionWorkerEventSchema.parse(event);
    if (!verifyExecutionWorkerEvent(parsed)) throw new Error("Execution worker event integrity verification failed.");
    const key = parsed.eventHash.toLowerCase();
    if (this.events.has(key)) return { inserted: false };
    this.events.set(key, structuredClone(parsed));
    return { inserted: true };
  }

  async latestIntent(): Promise<LatestIntentSummary | null> {
    const value = [...this.intents.values()].sort((a, b) => b.createdAt.localeCompare(a.createdAt))[0];
    return value ? summaryIntent(value) : null;
  }

  async latestSimulation(): Promise<LatestSimulationSummary | null> {
    const value = [...this.simulations.values()].sort((a, b) => b.createdAt.localeCompare(a.createdAt))[0];
    return value ? summarySimulation(value) : null;
  }

  async latestReservation(): Promise<LatestReservationSummary | null> {
    const value = [...this.reservations.values()].sort((a, b) => b.createdAt.localeCompare(a.createdAt))[0];
    return value ? summaryReservation(value) : null;
  }

  async latestSubmission(): Promise<LatestSubmissionSummary | null> {
    const value = [...this.submissions.values()].sort((a, b) => b.createdAt.localeCompare(a.createdAt))[0];
    return value ? summarySubmission(value) : null;
  }

  async latestWorkerEvent(): Promise<ExecutionWorkerEvent | null> {
    const value = [...this.events.values()].sort((a, b) => b.createdAt.localeCompare(a.createdAt))[0];
    return value ? structuredClone(value) : null;
  }

  async databaseHealth(): Promise<{ state: "HEALTHY"; latencyMs: number; reason: null }> {
    return { state: "HEALTHY", latencyMs: 0, reason: null };
  }
}

export async function readExecutionStagingHealth(
  config: ExecutionStagingConfig,
  store: ExecutionStagingStore | null,
  now = new Date(),
): Promise<ExecutionStagingHealth> {
  if (config.environment === "DISABLED") {
    return executionStagingHealthSchema.parse({
      schemaVersion: 1,
      configured: false,
      environment: "DISABLED",
      state: "HEALTHY",
      submissionPermitted: false,
      latestIntent: null,
      latestSimulation: null,
      latestReservation: null,
      latestSubmission: null,
      lastError: null,
      lastEventAt: null,
      generatedAt: now.toISOString(),
    });
  }
  if (config.issues.length > 0 || !store) {
    return executionStagingHealthSchema.parse({
      schemaVersion: 1,
      configured: false,
      environment: config.environment,
      state: "UNAVAILABLE",
      submissionPermitted: false,
      latestIntent: null,
      latestSimulation: null,
      latestReservation: null,
      latestSubmission: null,
      lastError: config.issues.join(" ") || "Execution staging store is unavailable.",
      lastEventAt: null,
      generatedAt: now.toISOString(),
    });
  }
  try {
    const [latestIntent, latestSimulation, latestReservation, latestSubmission, latestEvent] = await Promise.all([
      store.latestIntent(),
      store.latestSimulation(),
      store.latestReservation(),
      store.latestSubmission(),
      store.latestWorkerEvent(),
    ]);
    const db = await store.databaseHealth();
    const state = db.state === "UNAVAILABLE" || latestEvent?.state === "UNAVAILABLE"
      ? "UNAVAILABLE"
      : latestEvent?.state === "DEGRADED" || latestEvent?.eventType === "SIMULATION_FAILED" || latestEvent?.eventType === "SUBMISSION_REVERTED"
        ? "DEGRADED"
        : "HEALTHY";
    return executionStagingHealthSchema.parse({
      schemaVersion: 1,
      configured: true,
      environment: config.environment,
      state,
      submissionPermitted: config.submissionEnabled,
      latestIntent,
      latestSimulation,
      latestReservation,
      latestSubmission,
      lastError: latestEvent?.state === "HEALTHY" ? null : latestEvent?.message ?? db.reason,
      lastEventAt: latestEvent?.createdAt ?? null,
      generatedAt: now.toISOString(),
    });
  } catch (error) {
    return executionStagingHealthSchema.parse({
      schemaVersion: 1,
      configured: true,
      environment: config.environment,
      state: "UNAVAILABLE",
      submissionPermitted: false,
      latestIntent: null,
      latestSimulation: null,
      latestReservation: null,
      latestSubmission: null,
      lastError: operationalErrorMessage(error),
      lastEventAt: null,
      generatedAt: now.toISOString(),
    });
  }
}

function summaryIntent(intent: ExecutionStagingIntent): LatestIntentSummary {
  return {
    intentHash: intent.intentHash,
    snapshotHash: intent.snapshotHash,
    environment: intent.environment,
    chainId: intent.chainId,
    observedBlock: intent.observedBlock,
    createdAt: intent.createdAt,
  };
}

function summarySimulation(simulation: ExecutionSimulation): LatestSimulationSummary {
  return {
    simulationHash: simulation.simulationHash,
    intentHash: simulation.intentHash,
    status: simulation.status,
    createdAt: simulation.createdAt,
  };
}

function summaryReservation(reservation: ExecutionSubmissionReservation): LatestReservationSummary {
  return {
    reservationId: reservation.reservationId,
    intentHash: reservation.intentHash,
    environment: reservation.environment,
    simulationHash: reservation.schemaVersion === 2 ? reservation.simulationHash : null,
    executionFingerprint: reservation.schemaVersion === 2 ? reservation.executionFingerprint : null,
    createdAt: reservation.createdAt,
  };
}

function summarySubmission(submission: ExecutionSubmission): LatestSubmissionSummary {
  return {
    submissionHash: submission.submissionHash,
    intentHash: submission.intentHash,
    environment: submission.environment,
    status: submission.status,
    transactionHash: submission.transactionHash,
    createdAt: submission.createdAt,
  };
}
