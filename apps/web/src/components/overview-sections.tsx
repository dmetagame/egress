import {
  BrainCircuit,
  Clock3,
  Droplets,
  Fingerprint,
  KeyRound,
  LockKeyhole,
  Radio,
  ShieldCheck,
} from "lucide-react";
import type { ProductSnapshot } from "@/lib/types";
import {
  bps,
  duration,
  formatDate,
  healthFactor,
  shortHash,
  tokenAmount,
  unixDate,
} from "@/lib/format";
import { AddressText, DefinitionRow, SectionHeading, StatusPill } from "./primitives";

export function OverviewSections({ snapshot }: { snapshot: ProductSnapshot }) {
  const baseline = snapshot.revisions.find((revision) => revision.revision === "A")!;
  const baselineClaim = baseline.evidence[0];
  const policy = snapshot.authorization.policy;
  const liquidity = snapshot.market.liquidity;
  return (
    <div className="overview-grid">
      <section className="overview-panel risk-status-panel">
        <SectionHeading
          eyebrow="RWA risk"
          title="Normal conditions"
          action={<StatusPill tone="success" icon={Radio}>NORMAL</StatusPill>}
        />
        <div className="risk-signal-row">
          <span className="risk-orbit" aria-hidden="true"><BrainCircuit size={22} /></span>
          <div>
            <strong>{baselineClaim?.statement ?? "Baseline source revision validated."}</strong>
            <p>{baselineClaim?.positionImpact ?? "No material deterioration detected."}</p>
          </div>
        </div>
        <div className="panel-meta-row">
          <span>OKX authoritative source</span>
          <code>{baseline.sourceRevisionIds[0]}</code>
          <span>{Math.round((baselineClaim?.confidence ?? 0) * 100)}% confidence</span>
        </div>
      </section>

      <section className="overview-panel liquidity-panel">
        <SectionHeading
          eyebrow="Exit liquidity"
          title="Executable"
          action={<StatusPill tone="success" icon={Droplets}>AVAILABLE</StatusPill>}
        />
        <dl className="definition-list">
          <DefinitionRow label="Expected execution price">{tokenAmount(liquidity.executionPriceWad, 6)} xETH / xBETH</DefinitionRow>
          <DefinitionRow label="Estimated slippage">{bps(liquidity.estimatedSlippageBps)}</DefinitionRow>
          <DefinitionRow label="Price impact">{bps(liquidity.priceImpactBps)}</DefinitionRow>
          <DefinitionRow label="Oracle deviation">{bps(liquidity.oraclePoolDeviationBps)}</DefinitionRow>
          <DefinitionRow label="Pool balances">
            {tokenAmount(liquidity.poolTokenInBalanceWei, 2)} / {tokenAmount(liquidity.poolTokenOutBalanceWei, 2)}
          </DefinitionRow>
        </dl>
        <div className="panel-meta-row">
          <AddressText value={liquidity.pool} label="Uniswap V3" />
          <span>Fee {liquidity.feeTier / 10_000}%</span>
          <span>Block {liquidity.blockNumber}</span>
        </div>
      </section>

      <section className="overview-panel policy-panel">
        <SectionHeading
          eyebrow="Protection policy"
          title="Bounded autonomy"
          action={<StatusPill tone="success" icon={LockKeyhole}>AUTHORIZED</StatusPill>}
        />
        <dl className="definition-list policy-compact-grid">
          <DefinitionRow label="Risk trigger">{policy.minimumRiskLevel === 3 ? "HIGH" : "CRITICAL"}</DefinitionRow>
          <DefinitionRow label="Health trigger">{"HF <= "}{healthFactor(policy.maxPreHealthFactor)}</DefinitionRow>
          <DefinitionRow label="Minimum post-action HF">{healthFactor(policy.minPostHealthFactor)}</DefinitionRow>
          <DefinitionRow label="Maximum repayment">{tokenAmount(policy.maxRepaymentPerExecution)} xETH</DefinitionRow>
          <DefinitionRow label="Maximum collateral">{tokenAmount(policy.maxCollateralPerExecution)} xBETH</DefinitionRow>
          <DefinitionRow label="Maximum slippage">{bps(policy.maxSlippageBps)}</DefinitionRow>
        </dl>
        <div className="panel-meta-row">
          <span><Clock3 aria-hidden="true" size={13} /> {duration(policy.cooldownSeconds)} cooldown</span>
          <span>{policy.maxExecutions} execution allowed</span>
          <span>Active at evaluation</span>
        </div>
      </section>

      <section className="overview-panel autonomy-panel">
        <SectionHeading
          eyebrow="Autonomy"
          title="User signs once"
          action={<StatusPill tone="info" icon={KeyRound}>PRE-AUTHORIZED</StatusPill>}
        />
        <div className="autonomy-statement">
          <ShieldCheck aria-hidden="true" size={28} />
          <div>
            <strong>No post-event signature consumed</strong>
            <p>The keeper can submit only the fixed policy scope. It never receives custody or arbitrary wallet permissions.</p>
          </div>
        </div>
        <dl className="definition-list">
          <DefinitionRow label="Policy ID"><code>{shortHash(snapshot.authorization.policyId)}</code></DefinitionRow>
          <DefinitionRow label="Policy nonce">{policy.nonce}</DefinitionRow>
          <DefinitionRow label="Permit nonce">{snapshot.authorization.permitNonceAfterSetup}{" -> "}{snapshot.authorization.postEventPermitNonce}</DefinitionRow>
          <DefinitionRow label="Policy expiry">{unixDate(policy.expiresAt)}</DefinitionRow>
        </dl>
        <div className="panel-meta-row">
          <span><Fingerprint aria-hidden="true" size={13} /> EIP-712 policy</span>
          <span>Recorded {formatDate(snapshot.generatedAt)}</span>
        </div>
      </section>
    </div>
  );
}
