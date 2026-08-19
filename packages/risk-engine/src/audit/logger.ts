import type { RiskEventRecord } from "../domain/schemas.js";
import type { RiskEventStore } from "../sources/store.js";

export class RiskAuditLogger {
  constructor(private readonly store: RiskEventStore) {}

  async record(event: RiskEventRecord): Promise<void> {
    await this.store.saveEvent(event);
  }

  async get(riskEventId: string): Promise<RiskEventRecord | null> {
    return this.store.getEvent(riskEventId);
  }
}
