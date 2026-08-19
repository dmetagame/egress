"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import {
  Activity,
  BrainCircuit,
  ChevronRight,
  Gauge,
  HeartPulse,
  LockKeyhole,
  Settings,
  ShieldCheck,
} from "lucide-react";
import type { ProductSnapshot } from "@/lib/types";
import { shortAddress } from "@/lib/format";

const navigation = [
  { href: "/overview", label: "Overview", icon: Gauge },
  { href: "/protection", label: "Protection", icon: ShieldCheck },
  { href: "/risk", label: "Risk intelligence", icon: BrainCircuit },
  { href: "/activity", label: "Activity", icon: Activity },
  { href: "/settings", label: "Settings", icon: Settings },
  { href: "/operations", label: "Operations", icon: HeartPulse },
] as const;

export function AppShell({
  snapshot,
  children,
}: {
  snapshot: ProductSnapshot;
  children: React.ReactNode;
}) {
  const pathname = usePathname();
  return (
    <div className="app-shell">
      <aside className="sidebar">
        <Link className="brand" href="/" aria-label="Egress home">
          <span className="brand-mark" aria-hidden="true">
            <LockKeyhole size={18} strokeWidth={2.2} />
          </span>
          <span>
            <strong>EGRESS</strong>
            <small>Protection infrastructure</small>
          </span>
        </Link>

        <nav className="primary-nav" aria-label="Primary navigation">
          {navigation.map(({ href, label, icon: Icon }) => {
            const active = pathname === href;
            return (
              <Link
                aria-current={active ? "page" : undefined}
                aria-label={label}
                className={active ? "is-active" : undefined}
                href={href}
                key={href}
                title={label}
              >
                <Icon aria-hidden="true" size={17} />
                <span>{label}</span>
                {active ? <ChevronRight className="nav-caret" aria-hidden="true" size={14} /> : null}
              </Link>
            );
          })}
        </nav>

        <div className="sidebar-system">
          <span className="sidebar-system-label"><span className="system-pulse" aria-hidden="true" /> Monitoring boundary</span>
          <code>{shortAddress(snapshot.actors.user, 8, 6)}</code>
          <span>Historical fork evidence / chain {snapshot.environment.chainId}</span>
        </div>
      </aside>

      <div className="application-column">
        <EnvironmentNotice />
        <main className="application-main">{children}</main>
      </div>
    </div>
  );
}

export function EnvironmentNotice() {
  return (
    <div className="environment-banner environment-live" data-lenis-prevent-wheel role="status">
      <span className="environment-indicator" aria-hidden="true" />
      <strong>READ-ONLY DEMO</strong>
      <span>X Layer testnet evidence / chain 1952</span>
      <span>Current live observation only when configured</span>
      <span className="environment-secondary">Historical fork simulation remains labeled separately</span>
    </div>
  );
}
