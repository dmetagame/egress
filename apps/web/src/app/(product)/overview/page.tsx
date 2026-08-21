import type { Metadata } from "next";
import { connection } from "next/server";
import { ShieldCheck } from "lucide-react";
import { OverviewSections } from "@/components/overview-sections";
import { LiveOverview } from "@/components/live-overview";
import { ProtectionDashboard } from "@/components/protection-dashboard";
import { PageHeader, StatusPill } from "@/components/primitives";
import { PositionStrip } from "@/components/position-strip";
import { Phase11EvidencePanel } from "@/components/phase11-evidence-panel";
import { ReplayConsole } from "@/components/replay-console";
import { getProductSnapshot } from "@/lib/server/snapshot";
import { readOverviewLiveData } from "@/lib/server/overview-live";

export const metadata: Metadata = { title: "Protection overview" };
export const runtime = "nodejs";

export default async function OverviewPage() {
  await connection();
  const [snapshot, liveData] = await Promise.all([
    getProductSnapshot(),
    readOverviewLiveData(),
  ]);
  const liveAvailable = liveData.current.status === "COMPLETE";
  return (
    <div className="page-stack">
      <PageHeader
        eyebrow="xBETH / xETH protection system"
        title="Position protection"
        description="Current health, protection readiness, independent risk signals, and the evidence behind every decision."
        status={<StatusPill tone={liveAvailable ? "success" : "warning"} icon={ShieldCheck}>{liveAvailable ? "LIVE SNAPSHOT AVAILABLE" : "LIVE DATA UNAVAILABLE"}</StatusPill>}
      />
      <ProtectionDashboard live={liveData.current.envelope} current={liveData.current} />
      <LiveOverview
        initial={liveData.current.envelope}
        initialCurrent={liveData.current}
        initialHistory={liveData.history.items}
        initialAlerts={liveData.alerts.items}
      />
      <Phase11EvidencePanel />
      <section className="fork-evidence-section" aria-label="Pinned fork execution evidence">
        <div className="fork-evidence-heading">
          <div>
            <p className="eyebrow">Recorded execution proof</p>
            <h2>Pinned X Layer fork simulation</h2>
            <p>Historical Phase 5 execution evidence below is intentionally separate from the current live read-only state.</p>
          </div>
          <StatusPill tone="info">PINNED FORK</StatusPill>
        </div>
        <PositionStrip snapshot={snapshot} />
      </section>
      <OverviewSections snapshot={snapshot} />
      <ReplayConsole snapshot={snapshot} />
    </div>
  );
}
