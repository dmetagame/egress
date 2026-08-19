import type { Metadata } from "next";
import Link from "next/link";
import { Database, KeyRound, Network, Settings, ShieldCheck } from "lucide-react";
import { AddressText, DefinitionRow, PageHeader, SectionHeading, StatusPill } from "@/components/primitives";
import { getProductSnapshot } from "@/lib/server/snapshot";
import { formatDate, shortHash } from "@/lib/format";

export const metadata: Metadata = { title: "Settings" };

export default async function SettingsPage() {
  const snapshot = await getProductSnapshot();
  return (
    <div className="page-stack">
      <PageHeader
        eyebrow="Trust configuration"
        title="Settings"
        description="Inspect the historical fork configuration and the actors bound into this verified simulation. Current chain-1952 deployment proof is published separately."
        status={<StatusPill tone="info" icon={Settings}>READ ONLY</StatusPill>}
      />
      <div className="settings-grid">
        <section className="settings-section">
          <SectionHeading eyebrow="Historical simulation" title="Pinned X Layer fork" action={<Network size={18} />} />
          <dl className="definition-list">
            <DefinitionRow label="Chain ID">{snapshot.environment.chainId}</DefinitionRow>
            <DefinitionRow label="Fork block">{snapshot.environment.forkBlock.toLocaleString("en-US")}</DefinitionRow>
            <DefinitionRow label="Fork block hash"><code>{shortHash(snapshot.environment.forkBlockHash)}</code></DefinitionRow>
            <DefinitionRow label="Live broadcast">Disabled</DefinitionRow>
            <DefinitionRow label="Evidence scope">Historical fork only</DefinitionRow>
            <DefinitionRow label="Artifact generated">{formatDate(snapshot.generatedAt)}</DefinitionRow>
          </dl>
        </section>

        <section className="settings-section">
          <SectionHeading eyebrow="Trusted actors" title="Authorization boundary" action={<KeyRound size={18} />} />
          <dl className="definition-list">
            <DefinitionRow label="Protected user"><AddressText value={snapshot.actors.user} /></DefinitionRow>
            <DefinitionRow label="Keeper"><AddressText value={snapshot.actors.keeper} /></DefinitionRow>
            <DefinitionRow label="Risk attestor"><AddressText value={snapshot.actors.riskAttestor} /></DefinitionRow>
            <DefinitionRow label="Policy ID"><code>{shortHash(snapshot.authorization.policyId)}</code></DefinitionRow>
            <DefinitionRow label="Protocol hash"><code>{shortHash(snapshot.authorization.policy.protocolConfigHash)}</code></DefinitionRow>
          </dl>
        </section>
      </div>

      <section className="contract-registry">
        <SectionHeading
          eyebrow="Immutable protocol scope"
          title="Contract registry"
          description="The policy binds the deployed executor to these Aave, token, and Uniswap addresses."
          action={<StatusPill tone="info" icon={ShieldCheck}>HISTORICAL FORK</StatusPill>}
        />
        <div className="contract-table" role="table" aria-label="Contract registry">
          {[
            ["Egress executor", snapshot.contracts.egressExecutor],
            ["Aave pool", snapshot.contracts.aavePool],
            ["xBETH", snapshot.contracts.xbEth],
            ["xETH", snapshot.contracts.xeth],
            ["aXbETH", snapshot.contracts.aXbEth],
            ["Uniswap pool", snapshot.contracts.swapPool],
          ].map(([label, address]) => (
            <div className="contract-row" role="row" key={label}>
              <span role="cell"><Database aria-hidden="true" size={15} /> {label}</span>
              <code role="cell">{address}</code>
              <span role="cell">Historical fork / verified</span>
            </div>
          ))}
        </div>
      </section>

      <Link className="text-link" href="/overview#phase11-evidence">
        View finalized X Layer testnet deployment evidence
      </Link>
    </div>
  );
}
