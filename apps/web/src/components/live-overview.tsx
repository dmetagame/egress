"use client";

import { useCallback, useEffect, useState } from "react";
import {
  Activity,
  AlertTriangle,
  BrainCircuit,
  Database,
  Droplets,
  RefreshCw,
  Radio,
  ShieldAlert,
} from "lucide-react";
import type {
  LiveAlertsApiResponse,
  LiveApiResponse,
  LiveCurrentApiResponse,
  LiveHistoryApiResponse,
  LiveHistoryItem,
} from "@/lib/types";
import { bps, formatDate, healthFactor, shortHash, tokenAmount } from "@/lib/format";
import { DefinitionRow, SectionHeading, StatusPill, type Tone } from "./primitives";

export function LiveOverview({
  initial,
  initialCurrent = null,
  initialHistory = [],
  initialAlerts = [],
}: {
  initial: LiveApiResponse;
  initialCurrent?: LiveCurrentApiResponse | null;
  initialHistory?: LiveHistoryItem[];
  initialAlerts?: LiveAlertsApiResponse["items"];
}) {
  const [envelope, setEnvelope] = useState(initial);
  const [current, setCurrent] = useState<LiveCurrentApiResponse | null>(initialCurrent);
  const [history, setHistory] = useState<LiveHistoryItem[]>(initialHistory);
  const [alerts, setAlerts] = useState<LiveAlertsApiResponse["items"]>(initialAlerts);
  const [refreshing, setRefreshing] = useState(false);
  const [requestError, setRequestError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    setRefreshing(true);
    setRequestError(null);
    try {
      const currentResponse = await fetch("/api/live/current", { cache: "no-store" });
      const currentBody = (await currentResponse.json()) as LiveCurrentApiResponse | { reasons?: string[] };
      if (!currentResponse.ok || !("envelope" in currentBody)) {
        throw new Error(
          apiReason(currentBody) ??
          "Live read-only data could not be refreshed.",
        );
      }
      const [historyResponse, alertsResponse] = await Promise.all([
        fetch("/api/live/history?limit=20", { cache: "no-store" }),
        fetch("/api/live/alerts?limit=30", { cache: "no-store" }),
      ]);
      const historyBody = (await historyResponse.json()) as LiveHistoryApiResponse | { reasons?: string[] };
      const alertsBody = (await alertsResponse.json()) as LiveAlertsApiResponse | { reasons?: string[] };
      if (
        !historyResponse.ok ||
        !alertsResponse.ok ||
        !("items" in historyBody) ||
        !("items" in alertsBody)
      ) {
        throw new Error(
          apiReason(historyBody) ?? apiReason(alertsBody) ??
          "Live read-only data could not be refreshed.",
        );
      }
      setCurrent(currentBody);
      setEnvelope(currentBody.envelope);
      setHistory(historyBody.items);
      setAlerts(alertsBody.items);
    } catch (error) {
      setRequestError(error instanceof Error ? error.message : "Live read-only refresh failed safely.");
    } finally {
      setRefreshing(false);
    }
  }, []);

  useEffect(() => {
    const timer = window.setInterval(() => void refresh(), 30_000);
    return () => window.clearInterval(timer);
  }, [refresh]);

  const snapshot = envelope.snapshot;
  const archiveSnapshot = current?.snapshot ?? null;
  const partial = envelope.partial;
  const rwa = snapshot?.rwa ?? partial.rwa;
  const pool = snapshot?.uniswap ?? partial.uniswapPool;
  const position = snapshot?.marketContext.position ?? partial.position;
  const liquidity = snapshot?.marketContext.liquidity ?? partial.liquidity;
  const available = (current ? current.status === "COMPLETE" : envelope.status === "AVAILABLE") &&
    envelope.status === "AVAILABLE" && snapshot !== null;
  const riskLevel = rwa?.status === "AVAILABLE" ? rwa.riskLevel : null;
  const riskTone = toneForRisk(riskLevel);
  const previewSurplusWei = snapshot
    ? estimatedSurplusWei(
        snapshot.executionPreview.plan.expectedSwapOutWei,
        snapshot.executionPreview.plan.repayAmountWei,
        snapshot.executionPreview.plan.flashLoanPremiumCeilingWei,
      )
    : "0";

  return (
    <section className="live-overview" id="live-evidence" aria-label="Live read-only X Layer state">
      <SectionHeading
        eyebrow="Verified evidence"
        title="Live observation record"
        description="Block-pinned Aave, oracle, Uniswap, and OKX evidence. This path has no signer and cannot broadcast."
        action={
          <div className="live-overview-actions">
            <StatusPill tone={available ? "success" : "warning"} icon={available ? Radio : AlertTriangle}>
              {available ? "LIVE DATA AVAILABLE" : "DATA UNAVAILABLE"}
            </StatusPill>
            <button className="icon-button" disabled={refreshing} onClick={() => void refresh()} type="button" aria-label="Refresh live read-only data">
              <RefreshCw className={refreshing ? "spin" : undefined} aria-hidden="true" size={15} />
            </button>
          </div>
        }
      />

      <div className="live-mode-line" role="status">
        <strong>DATA MODE: LIVE READ-ONLY</strong>
        <span>{partial.chain ? `Chain ${partial.chain.chainId}` : "Chain unavailable"}</span>
        <span>{partial.chain ? `Block ${Number(partial.chain.blockNumber).toLocaleString("en-US")}` : "Block unavailable"}</span>
        <span>Archive: {current?.status ?? "UNAVAILABLE"}</span>
        <span>PREVIEW ONLY / NO TRANSACTION SUBMITTED</span>
      </div>

      {requestError ? (
        <div className="inline-alert alert-danger" role="alert">
          <AlertTriangle aria-hidden="true" size={17} />
          <span>{requestError} The last verified response remains displayed.</span>
        </div>
      ) : null}

      {!available ? (
        <LiveUnavailable envelope={envelope} />
      ) : (
        <>
          <div className="live-metric-grid">
            <LiveMetric label="Health factor" value={healthFactor(snapshot.aave.position.healthFactorWad)} detail="Aave account data" tone="warning" />
            <LiveMetric label="xBETH collateral" value={`${tokenAmount(snapshot.aave.position.collateralBalanceWei, 4)} xBETH`} detail="aXbETH balance" />
            <LiveMetric label="xETH debt" value={`${tokenAmount(snapshot.aave.position.debtBalanceWei, 4)} xETH`} detail="Variable debt" tone="warning" />
            <LiveMetric label="Executable quote" value={liquidity?.executable ? "Available" : "Unavailable"} detail={liquidity ? `${bps(liquidity.estimatedSlippageBps)} slippage` : "Quote missing"} tone={liquidity?.executable ? "success" : "danger"} />
            <LiveMetric label="RWA risk" value={riskLevel ?? "UNAVAILABLE"} detail={rwa?.latestRetrievedAt ? formatDate(rwa.latestRetrievedAt) : "Evidence unavailable"} tone={riskTone} />
            <LiveMetric label="Snapshot" value={shortHash(snapshot.snapshotHash)} detail={formatDate(snapshot.generatedAt)} tone="info" />
          </div>

          <details className="verified-evidence-disclosure">
            <summary>
              <span><Database aria-hidden="true" size={16} /> Expand technical evidence</span>
              <span>Block, market, archive, source, and adapter details</span>
            </summary>
            <div className="verified-evidence-content">
              <div className="live-detail-grid">
                <section className="live-detail-panel">
              <SectionHeading eyebrow="Market provenance" title="Current state" action={<StatusPill tone="success">SAME BLOCK</StatusPill>} />
              <dl className="definition-list">
                <DefinitionRow label="Block hash"><code>{shortHash(snapshot.chain.blockHash)}</code></DefinitionRow>
                <DefinitionRow label="xBETH oracle">{oraclePrice(snapshot.oracle.xbEth.priceBase, snapshot.oracle.xbEth.decimals)}</DefinitionRow>
                <DefinitionRow label="xETH oracle">{oraclePrice(snapshot.oracle.xeth.priceBase, snapshot.oracle.xeth.decimals)}</DefinitionRow>
                <DefinitionRow label="Pool liquidity">{tokenAmount(snapshot.uniswap.activeLiquidity, 2)}</DefinitionRow>
                <DefinitionRow label="Pool balances">{tokenAmount(snapshot.uniswap.poolTokenInBalanceWei, 2)} / {tokenAmount(snapshot.uniswap.poolTokenOutBalanceWei, 2)}</DefinitionRow>
                <DefinitionRow label="Market update">{formatDate(snapshot.chain.blockTimestamp)}</DefinitionRow>
                <DefinitionRow label="Oracle update">{snapshot.oracle.xeth.updatedAt ? formatDate(snapshot.oracle.xeth.updatedAt) : "Unavailable"}</DefinitionRow>
                <DefinitionRow label="Evidence update">{snapshot.rwa.latestRetrievedAt ? formatDate(snapshot.rwa.latestRetrievedAt) : "Unavailable"}</DefinitionRow>
              </dl>
                </section>

                <section className="live-detail-panel">
              <SectionHeading eyebrow="Deterministic decision" title="Execution preview" action={<StatusPill tone="info">PREVIEW ONLY</StatusPill>} />
              <dl className="definition-list">
                <DefinitionRow label="Current health factor">{healthFactor(snapshot.aave.position.healthFactorWad)}</DefinitionRow>
                <DefinitionRow label="Target health factor">{healthFactor(snapshot.policy.policy?.targetPostHealthFactorWad ?? "0")}</DefinitionRow>
                <DefinitionRow label="Proposed repayment">{tokenAmount(snapshot.executionPreview.plan.repayAmountWei)} xETH</DefinitionRow>
                <DefinitionRow label="Proposed collateral">{tokenAmount(snapshot.executionPreview.plan.collateralAmountWei)} xBETH</DefinitionRow>
                <DefinitionRow label="Expected output">{tokenAmount(snapshot.executionPreview.plan.expectedSwapOutWei)} xETH</DefinitionRow>
                <DefinitionRow label="Minimum output">{tokenAmount(snapshot.executionPreview.plan.minimumSwapOutWei)} xETH</DefinitionRow>
                <DefinitionRow label="Estimated slippage">{bps(snapshot.marketContext.liquidity.estimatedSlippageBps)}</DefinitionRow>
                <DefinitionRow label="Flash premium ceiling">{tokenAmount(snapshot.executionPreview.plan.flashLoanPremiumCeilingWei, 6)} xETH</DefinitionRow>
                <DefinitionRow label="Surplus at premium ceiling">{tokenAmount(previewSurplusWei, 6)} xETH</DefinitionRow>
                <DefinitionRow label="Maximum repayment">{tokenAmount(snapshot.policy.policy?.maximumRepaymentWei ?? "0")} xETH</DefinitionRow>
                <DefinitionRow label="Maximum collateral">{tokenAmount(snapshot.policy.policy?.maximumCollateralWei ?? "0")} xBETH</DefinitionRow>
                <DefinitionRow label="Maximum slippage">{bps(snapshot.policy.policy?.maximumSlippageBps ?? 0)}</DefinitionRow>
                <DefinitionRow label="Plan status">{snapshot.executionPreview.plan.executable ? "EXECUTABLE" : "BLOCKED"}</DefinitionRow>
                <DefinitionRow label="Policy decision">{snapshot.executionPreview.policyEvaluation.allowed ? "BOUNDED ACTION PERMITTED" : "NO ACTION PERMITTED"}</DefinitionRow>
              </dl>
              <p className="live-preview-note">{snapshot.executionPreview.reason}</p>
                </section>
              </div>

              <div className="live-archive-grid">
                <section className="live-detail-panel" aria-label="Recent live risk history">
              <SectionHeading eyebrow="Append-only observations" title="Recent risk history" action={<StatusPill tone="info">HISTORY</StatusPill>} />
              {history.length === 0 ? (
                <p className="live-empty-state">No archived observations yet.</p>
              ) : (
                <div className="live-history-list">
                  {history.slice(0, 8).map((item) => <HistoryRow item={item} key={item.observationId} />)}
                </div>
              )}
                </section>

                <section className="live-detail-panel" aria-label="Live alerts">
              <SectionHeading eyebrow="Deterministic monitoring" title="Alerts" action={<StatusPill tone={alerts.length ? "warning" : "success"}>{alerts.length ? `${alerts.length} RECENT` : "NONE"}</StatusPill>} />
              {alerts.length === 0 ? (
                <p className="live-empty-state">No state transitions or operational alerts recorded.</p>
              ) : (
                <div className="live-alert-list">
                  {alerts.slice(0, 6).map((alert) => (
                    <div className={`live-alert-row severity-${alert.severity.toLowerCase()}`} key={alert.alertId}>
                      <div className="live-alert-row-head">
                        <strong>{alert.alertType.replaceAll("_", " ")}</strong>
                        <StatusPill tone={toneForAlert(alert.severity)} compact>{alert.severity}</StatusPill>
                      </div>
                      <p>{alert.evidence[0]?.message ?? "Evidence recorded."}</p>
                      <small>{formatDate(alert.createdAt)} · block {alert.block ?? "unavailable"} · {shortHash(alert.snapshotHash)}</small>
                    </div>
                  ))}
                </div>
              )}
                </section>
              </div>

              <section className="live-detail-panel live-snapshot-detail" aria-label="Current snapshot detail">
            <SectionHeading eyebrow="Immutable archive record" title="Snapshot detail" action={<StatusPill tone="success">CURRENT</StatusPill>} />
            <dl className="definition-list live-snapshot-definition">
              <DefinitionRow label="Snapshot hash"><code>{archiveSnapshot ? shortHash(archiveSnapshot.snapshotHash) : "Unavailable"}</code></DefinitionRow>
              <DefinitionRow label="Integrity hash"><code>{archiveSnapshot ? shortHash(archiveSnapshot.integrityHash) : "Unavailable"}</code></DefinitionRow>
              <DefinitionRow label="Observed block">{archiveSnapshot?.observedBlock ?? "Unavailable"}</DefinitionRow>
              <DefinitionRow label="Block hash"><code>{archiveSnapshot ? shortHash(archiveSnapshot.blockHash ?? "") : "Unavailable"}</code></DefinitionRow>
              <DefinitionRow label="Archive status">{archiveSnapshot?.archiveStatus ?? "UNAVAILABLE"}</DefinitionRow>
              <DefinitionRow label="Block consistency">{archiveSnapshot?.consistencyStatus ?? "UNAVAILABLE"}</DefinitionRow>
              <DefinitionRow label="Observation time">{current?.observation ? formatDate(current.observation.observedAt) : "Unavailable"}</DefinitionRow>
              <DefinitionRow label="Source revisions">{archiveSnapshot?.sourceStates.map((source) => source.revisionId).join(", ") || "Unavailable"}</DefinitionRow>
              <DefinitionRow label="Broadcast"><strong>DISABLED</strong></DefinitionRow>
            </dl>
              </section>
              <AdapterHealthList adapters={envelope.adapters} />
            </div>
          </details>
        </>
      )}

      {!available ? <AdapterHealthList adapters={envelope.adapters} /> : null}
    </section>
  );
}

function HistoryRow({ item }: { item: LiveHistoryItem }) {
  const tone = item.status === "COMPLETE" ? toneForRisk(item.riskClassification) : "warning";
  return (
    <div className="live-history-row">
      <time>{formatDate(item.timestamp)}</time>
      <strong>{item.riskClassification ?? item.status}</strong>
      <span>{item.healthFactorWad ? healthFactor(item.healthFactorWad) : "HF unavailable"}</span>
      <StatusPill tone={tone} compact>{item.status}</StatusPill>
    </div>
  );
}

function LiveUnavailable({ envelope }: { envelope: LiveApiResponse }) {
  const partial = envelope.partial;
  const rwa = partial.rwa;
  const pool = partial.uniswapPool;
  return (
    <div className="live-unavailable-grid">
      <div className="live-unavailable-primary">
        <ShieldAlert aria-hidden="true" size={23} />
        <div>
          <strong>Egress cannot establish a complete current position snapshot.</strong>
          <p>No risk level, protection status, or transaction preview is inferred from missing data.</p>
          <ul>
            {envelope.reasons.map((reason) => <li key={reason}>{reason}</li>)}
          </ul>
        </div>
      </div>
      <div className="live-partial-facts">
        <span><Activity aria-hidden="true" size={15} /> X Layer RPC <strong>{partial.chain?.rpcHealthy ? "AVAILABLE" : "UNAVAILABLE"}</strong></span>
        <span><Database aria-hidden="true" size={15} /> Protocol config <strong>{statusFor(envelope, "configuration")}</strong></span>
        <span><Droplets aria-hidden="true" size={15} /> Uniswap pool <strong>{pool?.configurationVerified ? "AVAILABLE" : "UNAVAILABLE"}</strong></span>
        <span><BrainCircuit aria-hidden="true" size={15} /> OKX evidence <strong>{rwa?.status ?? "UNAVAILABLE"}</strong></span>
      </div>
    </div>
  );
}

function AdapterHealthList({ adapters }: { adapters: LiveApiResponse["adapters"] }) {
  return (
    <div className="adapter-health-grid" aria-label="Live adapter health">
      {adapters.map((adapter) => (
        <div className="adapter-health-item" key={adapter.adapter}>
          <span>{adapter.adapter.replaceAll("-", " ")}</span>
          <StatusPill tone={adapter.status === "AVAILABLE" ? "success" : adapter.status === "STALE" ? "warning" : "danger"} compact>
            {adapter.status}
          </StatusPill>
          <small>{adapter.freshness.sourceTimestamp ? formatDate(adapter.freshness.sourceTimestamp) : adapter.message}</small>
        </div>
      ))}
    </div>
  );
}

function LiveMetric({ label, value, detail, tone = "neutral" }: { label: string; value: string; detail: string; tone?: Tone }) {
  return (
    <div className={`live-metric tone-border-${tone}`}>
      <span>{label}</span>
      <strong>{value}</strong>
      <small>{detail}</small>
    </div>
  );
}

function statusFor(envelope: LiveApiResponse, adapterName: string): string {
  return envelope.adapters.find((adapter) => adapter.adapter === adapterName)?.status ?? "UNAVAILABLE";
}

function toneForRisk(level: string | null): Tone {
  if (level === "HIGH" || level === "CRITICAL") return "danger";
  if (level === "MEDIUM") return "warning";
  if (level === "NORMAL" || level === "LOW") return "success";
  return "neutral";
}

function toneForAlert(level: string): Tone {
  if (level === "CRITICAL" || level === "HIGH") return "danger";
  if (level === "WARNING") return "warning";
  return "info";
}

function oraclePrice(value: string, decimals: number): string {
  const numeric = Number(BigInt(value)) / 10 ** decimals;
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "USD",
    maximumFractionDigits: 2,
  }).format(numeric);
}

function estimatedSurplusWei(
  expectedOutputWei: string,
  repaymentWei: string,
  premiumCeilingWei: string,
): string {
  const expected = BigInt(expectedOutputWei);
  const obligations = BigInt(repaymentWei) + BigInt(premiumCeilingWei);
  return (expected > obligations ? expected - obligations : 0n).toString();
}

function apiReason(body: object): string | undefined {
  if (!("reasons" in body) || !Array.isArray(body.reasons)) return undefined;
  return typeof body.reasons[0] === "string" ? body.reasons[0] : undefined;
}
