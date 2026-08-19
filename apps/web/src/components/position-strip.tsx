import { Activity, Landmark, Route, ShieldCheck } from "lucide-react";
import type { ProductSnapshot } from "@/lib/types";
import { bps, healthFactor, tokenAmount } from "@/lib/format";
import { Metric, StatusPill } from "./primitives";

export function PositionStrip({ snapshot }: { snapshot: ProductSnapshot }) {
  const before = snapshot.position.before;
  const distance = (Number(healthFactor(before.healthFactorWad, 6)) - 1) * 100;
  return (
    <section className="position-strip" aria-label="Protected position summary">
      <Metric
        label="Protection status"
        value="Protected"
        detail={
          <StatusPill tone="success" icon={ShieldCheck} compact>
            Pre-authorized
          </StatusPill>
        }
        tone="success"
      />
      <Metric
        label="xBETH collateral"
        value={`${tokenAmount(before.collateralWei, 3)} xBETH`}
        detail="Aave X Layer"
      />
      <Metric
        label="xETH debt"
        value={`${tokenAmount(before.debtWei, 3)} xETH`}
        detail="Variable rate"
        tone="warning"
      />
      <Metric
        label="Health factor"
        value={healthFactor(before.healthFactorWad)}
        detail={`${distance.toFixed(2)}% above liquidation`}
        tone="danger"
      />
      <Metric
        label="Liquidation threshold"
        value={bps(before.liquidationThresholdBps)}
        detail="xBETH e-mode"
      />
      <Metric
        label="Execution state"
        value="Ready"
        detail={
          <span className="inline-icon-label">
            <Route aria-hidden="true" size={13} /> Liquidity executable
          </span>
        }
        tone="info"
      />
      <span className="position-strip-decoration" aria-hidden="true">
        <Landmark size={18} />
        <Activity size={18} />
      </span>
    </section>
  );
}
