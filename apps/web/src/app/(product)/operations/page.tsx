import type { Metadata } from "next";
import { headers } from "next/headers";
import { connection } from "next/server";
import { Activity, Boxes, Database, HeartPulse, Radio, ShieldAlert } from "lucide-react";
import { DefinitionRow, PageHeader, SectionHeading, StatusPill } from "@/components/primitives";
import { getLiveOperationalHealth, type LiveOperationsHealthApiResponse } from "@/lib/server/live";
import { formatDate, healthFactor, shortHash, tokenAmount } from "@/lib/format";

export const metadata: Metadata = { title: "Operations" };
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export default async function OperationsPage() {
  await connection();
  const health = await loadOperationsHealth();
  const tone = healthTone(health.poller.state);
  return (
    <div className="page-stack">
      <PageHeader
        eyebrow="Read-only service health"
        title="Operations"
        description="Monitor observation freshness, archive integrity, and alert delivery without exposing execution controls."
        status={<StatusPill tone={tone} icon={HeartPulse}>{health.poller.state}</StatusPill>}
      />

      <section className="operations-mode-banner" role="status">
        <Radio aria-hidden="true" size={17} />
        <div>
          <strong>LIVE READ-ONLY</strong>
          <span>Current operational state is observational only.</span>
        </div>
        <b>LIVE MAINNET EXECUTION: DISABLED</b>
      </section>

      <div className="operations-grid">
        <section className="settings-section">
          <SectionHeading eyebrow="Service state" title="Observation pipeline" action={<Activity size={18} />} />
          <dl className="definition-list">
            <DefinitionRow label="Poller">{health.poller.state}</DefinitionRow>
            <DefinitionRow label="Last successful poll">
              {health.poller.lastSuccessfulObservationAt ? formatDate(health.poller.lastSuccessfulObservationAt) : "Unavailable"}
            </DefinitionRow>
            <DefinitionRow label="Snapshot age">
              {health.current.ageSeconds === null ? "Unavailable" : `${Math.round(health.current.ageSeconds)}s`}
            </DefinitionRow>
            <DefinitionRow label="Archive">{health.archive.state}</DefinitionRow>
            <DefinitionRow label="Database">{health.database.state}</DefinitionRow>
            <DefinitionRow label="RPC">{health.rpc.state}</DefinitionRow>
            <DefinitionRow label="RPC provider">{health.rpc.provider ?? "Unavailable"}</DefinitionRow>
            <DefinitionRow label="RPC head">{health.rpc.headBlock ?? "Unavailable"}</DefinitionRow>
            <DefinitionRow label="Indexed through">{health.rpc.indexedThroughBlock ?? "Unavailable"}</DefinitionRow>
            <DefinitionRow label="Index lag">{health.rpc.indexLagBlocks === null ? "Unavailable" : `${health.rpc.indexLagBlocks} blocks`}</DefinitionRow>
          </dl>
          {health.poller.lastError ? <p className="operations-reason">{health.poller.lastError}</p> : null}
        </section>

        <section className="settings-section">
          <SectionHeading eyebrow="Freshness gates" title="Evidence health" action={<ShieldAlert size={18} />} />
          <dl className="definition-list">
            <DefinitionRow label="Oracle">{freshnessLabel(health.oracle.state, health.oracle.ageSeconds)}</DefinitionRow>
            <DefinitionRow label="OKX source">{freshnessLabel(health.source.state, health.source.ageSeconds)}</DefinitionRow>
            <DefinitionRow label="Alert delivery">{health.alertDelivery.state}</DefinitionRow>
            <DefinitionRow label="Pending deliveries">{health.alertDelivery.pending}</DefinitionRow>
            <DefinitionRow label="Failed deliveries">{health.alertDelivery.failed}</DefinitionRow>
            <DefinitionRow label="Last generated">{formatDate(health.generatedAt)}</DefinitionRow>
          </dl>
          {health.oracle.reason || health.source.reason ? (
            <p className="operations-reason">{health.oracle.reason ?? health.source.reason}</p>
          ) : null}
        </section>
      </div>

      <section className="settings-section">
        <SectionHeading eyebrow="Isolated write boundary" title="Execution staging" action={<Boxes size={18} />} />
        <dl className="definition-list">
          <DefinitionRow label="Worker">{health.executionStaging.configured ? "Configured" : "Not configured"}</DefinitionRow>
          <DefinitionRow label="Environment">{health.executionStaging.environment}</DefinitionRow>
          <DefinitionRow label="Worker health">{health.executionStaging.state}</DefinitionRow>
          <DefinitionRow label="Submission">{health.executionStaging.submissionPermitted ? "Explicitly enabled for staging" : "Simulation only"}</DefinitionRow>
          <DefinitionRow label="Latest intent">
            {health.executionStaging.latestIntent ? <code>{shortHash(health.executionStaging.latestIntent.intentHash)}</code> : "Unavailable"}
          </DefinitionRow>
          <DefinitionRow label="Latest simulation">
            {health.executionStaging.latestSimulation?.status ?? "Unavailable"}
          </DefinitionRow>
          <DefinitionRow label="Latest reservation">
            {health.executionStaging.latestReservation
              ? <code>{shortHash(health.executionStaging.latestReservation.reservationId)}</code>
              : "None"}
          </DefinitionRow>
          <DefinitionRow label="Execution fingerprint">
            {health.executionStaging.latestReservation?.executionFingerprint
              ? <code>{shortHash(health.executionStaging.latestReservation.executionFingerprint)}</code>
              : "Unavailable"}
          </DefinitionRow>
          <DefinitionRow label="Latest submission">
            {health.executionStaging.latestSubmission?.status ?? "None"}
          </DefinitionRow>
          <DefinitionRow label="Live mainnet execution">DISABLED</DefinitionRow>
        </dl>
        {health.executionStaging.lastError ? <p className="operations-reason">{health.executionStaging.lastError}</p> : null}
      </section>

      <section className="settings-section">
        <SectionHeading eyebrow="Current observation" title="Protected position state" action={<Database size={18} />} />
        <div className="operations-metric-grid">
          <OperationMetric label="Health factor" value={health.current.healthFactorWad ? healthFactor(health.current.healthFactorWad) : "Unavailable"} />
          <OperationMetric label="xETH debt" value={health.current.debtBalanceWei ? `${tokenAmount(health.current.debtBalanceWei)} xETH` : "Unavailable"} />
          <OperationMetric label="xBETH collateral" value={health.current.collateralBalanceWei ? `${tokenAmount(health.current.collateralBalanceWei)} xBETH` : "Unavailable"} />
          <OperationMetric label="Executable liquidity" value={health.current.liquidityExecutable === null ? "Unavailable" : health.current.liquidityExecutable ? "Sufficient" : "Blocked"} />
        </div>
        <dl className="definition-list">
          <DefinitionRow label="Snapshot hash">
            {health.current.snapshotHash ? <code>{shortHash(health.current.snapshotHash)}</code> : "Unavailable"}
          </DefinitionRow>
          <DefinitionRow label="Observed at">
            {health.current.observedAt ? formatDate(health.current.observedAt) : "Unavailable"}
          </DefinitionRow>
          <DefinitionRow label="Archive status">{health.current.archiveStatus ?? "Unavailable"}</DefinitionRow>
          <DefinitionRow label="Archive lag">
            {health.metrics.archiveLagSeconds === null ? "Unavailable" : `${Math.round(health.metrics.archiveLagSeconds)}s`}
          </DefinitionRow>
        </dl>
      </section>

      <div className="operations-grid">
        <section className="settings-section">
          <SectionHeading eyebrow="Metrics" title="Archive and alert counters" />
          <dl className="definition-list">
            <DefinitionRow label="Poll successes">{health.metrics.pollSuccesses}</DefinitionRow>
            <DefinitionRow label="Poll failures">{health.metrics.pollFailures}</DefinitionRow>
            <DefinitionRow label="Archive write failures">{health.metrics.archiveWriteFailures}</DefinitionRow>
            <DefinitionRow label="Alerts generated">{health.metrics.alertsGenerated}</DefinitionRow>
            <DefinitionRow label="Alerts deduplicated">{health.metrics.alertsDeduplicated}</DefinitionRow>
            <DefinitionRow label="Delivery attempts">{health.metrics.alertDeliveryAttempts}</DefinitionRow>
          </dl>
        </section>
        <section className="settings-section">
          <SectionHeading eyebrow="Snapshot status" title="Archived observation counts" />
          <dl className="definition-list">
            <DefinitionRow label="Complete">{health.metrics.snapshotStatusCounts.COMPLETE}</DefinitionRow>
            <DefinitionRow label="Stale">{health.metrics.snapshotStatusCounts.STALE}</DefinitionRow>
            <DefinitionRow label="Invalid">{health.metrics.snapshotStatusCounts.INVALID}</DefinitionRow>
            <DefinitionRow label="Unavailable">{health.metrics.snapshotStatusCounts.UNAVAILABLE}</DefinitionRow>
            <DefinitionRow label="Last poll duration">{health.metrics.pollDurationMs === null ? "Unavailable" : `${health.metrics.pollDurationMs}ms`}</DefinitionRow>
          </dl>
        </section>
      </div>
    </div>
  );
}

async function loadOperationsHealth(): Promise<LiveOperationsHealthApiResponse> {
  const requestHeaders = await headers();
  const host = requestHeaders.get("x-forwarded-host")?.split(",")[0]?.trim() ?? requestHeaders.get("host");
  const protocol = requestHeaders.get("x-forwarded-proto")?.split(",")[0]?.trim() ?? "https";

  if (!host) return getLiveOperationalHealth();

  try {
    const response = await fetch(`${protocol}://${host}/api/operations/health`, {
      cache: "no-store",
      headers: { accept: "application/json" },
    });
    if (!response.ok) return getLiveOperationalHealth();
    return await response.json() as LiveOperationsHealthApiResponse;
  } catch {
    return getLiveOperationalHealth();
  }
}

function OperationMetric({ label, value }: { label: string; value: string }) {
  return (
    <div className="operations-metric">
      <span>{label}</span>
      <strong>{value}</strong>
    </div>
  );
}

function freshnessLabel(state: string, ageSeconds: number | null): string {
  if (ageSeconds === null) return state;
  return `${state} / ${Math.round(ageSeconds)}s old`;
}

function healthTone(state: string): "success" | "warning" | "danger" | "neutral" {
  if (state === "HEALTHY") return "success";
  if (state === "DEGRADED") return "warning";
  if (state === "UNAVAILABLE") return "danger";
  return "neutral";
}
