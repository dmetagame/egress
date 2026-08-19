import { ArrowRight, Check, ExternalLink, Fuel, ShieldCheck, Zap } from "lucide-react";
import type { ReplayApiResponse } from "@/lib/types";
import { bps, healthFactor, number, shortHash, tokenAmount } from "@/lib/format";
import { DefinitionRow, SectionHeading, StatusPill } from "./primitives";

export function ExecutionPreview({ response }: { response: ReplayApiResponse }) {
  const autonomous = response.autonomous;
  if (!autonomous?.decision.execution) {
    return (
      <section className="execution-preview is-inactive">
        <SectionHeading
          eyebrow="Bounded action"
          title="No execution authorized"
          description="The current risk level is below the policy trigger. Monitoring continues."
        />
      </section>
    );
  }

  const execution = autonomous.decision.execution;
  const plan = autonomous.decision.market.plan;
  const position = autonomous.decision.market.position;
  return (
    <section className="execution-preview">
      <SectionHeading
        eyebrow="Bounded action"
        title="Egress will deleverage"
        description="The keeper calculated these values; the AI did not choose transaction amounts."
        action={<StatusPill tone="success" icon={ShieldCheck}>Within policy</StatusPill>}
      />
      <div className="simulation-comparison" aria-label="Current position, proposed protection, and expected result">
        <article>
          <span className="simulation-column-label">Current position</span>
          <div><small>Health factor</small><strong>{position ? healthFactor(position.healthFactorWad) : "Unavailable"}</strong></div>
          <div><small>xETH debt</small><strong>{position ? tokenAmount(position.debtBalanceWei, 5) : "Unavailable"}</strong></div>
          <div><small>xBETH collateral</small><strong>{position ? tokenAmount(position.collateralBalanceWei, 5) : "Unavailable"}</strong></div>
        </article>
        <ArrowRight className="comparison-arrow" aria-hidden="true" size={18} />
        <article>
          <span className="simulation-column-label">Proposed protection</span>
          <div><small>Debt repayment</small><strong>{tokenAmount(execution.repayAmount, 5)} xETH</strong></div>
          <div><small>Collateral route</small><strong>{tokenAmount(execution.collateralAmount, 5)} xBETH</strong></div>
          <div><small>Minimum output</small><strong>{tokenAmount(execution.minSwapOut, 5)} xETH</strong></div>
        </article>
        <ArrowRight className="comparison-arrow" aria-hidden="true" size={18} />
        <article className="simulation-expected">
          <span className="simulation-column-label">Expected result</span>
          <div><small>Projected health factor</small><strong>{healthFactor(plan.projectedPostHealthFactorWad, 6)}</strong></div>
          <div><small>Expected swap output</small><strong>{tokenAmount(execution.expectedSwapOut, 5)} xETH</strong></div>
          <div><small>Simulation</small><strong>Within policy</strong></div>
        </article>
      </div>
      <div className="execution-route" aria-label="Deleveraging route detail">
        <div>
          <span>Flash borrow</span>
          <strong>{tokenAmount(execution.repayAmount, 6)} xETH</strong>
        </div>
        <ArrowRight aria-hidden="true" size={18} />
        <div>
          <span>Withdraw</span>
          <strong>{tokenAmount(execution.collateralAmount, 6)} xBETH</strong>
        </div>
        <ArrowRight aria-hidden="true" size={18} />
        <div>
          <span>Swap output</span>
          <strong>{tokenAmount(execution.expectedSwapOut, 6)} xETH</strong>
        </div>
      </div>
      <dl className="definition-list compact-list">
        <DefinitionRow label="Minimum output">{tokenAmount(execution.minSwapOut, 6)} xETH</DefinitionRow>
        <DefinitionRow label="Maximum slippage">{bps(response.event.policy.maximumSlippageBps)}</DefinitionRow>
        <DefinitionRow label="Projected health factor">{healthFactor(plan.projectedPostHealthFactorWad, 6)}</DefinitionRow>
        <DefinitionRow label="Flash premium ceiling">{tokenAmount(plan.flashLoanPremiumCeilingWei, 6)} xETH</DefinitionRow>
        <DefinitionRow label="Execution nonce">{execution.executionNonce}</DefinitionRow>
      </dl>
    </section>
  );
}

const executionStages = [
  "Detected",
  "Analyzed",
  "Policy checked",
  "Simulated",
  "Authorized",
  "Executed",
  "Confirmed",
];

export function ExecutionResult({ response }: { response: ReplayApiResponse }) {
  const autonomous = response.autonomous;
  if (!autonomous) return null;
  if (autonomous.decision.status !== "WOULD_EXECUTE" || !autonomous.decision.simulation.success) {
    return (
      <section className="execution-result is-failed">
        <SectionHeading
          eyebrow="Execution safety boundary"
          title={autonomous.decision.simulation.success ? "Execution not submitted" : "Simulation failed safely"}
          description="The fork transaction is not presented as protected because the final execution gate did not pass."
          action={<StatusPill tone="danger">DO NOT EXECUTE</StatusPill>}
        />
        <div className="inline-alert alert-danger" role="status">
          <span>{autonomous.decision.reasons.join(" ") || "No confirmed execution result was returned."}</span>
        </div>
      </section>
    );
  }
  const result = autonomous.execution;
  if (!result) {
    return (
      <section className="execution-result is-failed">
        <SectionHeading
          eyebrow="Execution result"
          title="Execution failed safely"
          description="No confirmed transaction result was returned. Egress does not claim the position was protected."
          action={<StatusPill tone="danger">UNCONFIRMED</StatusPill>}
        />
      </section>
    );
  }
  const before = result.deleveraged.healthFactorBeforeWad;
  const after = result.deleveraged.healthFactorAfterWad;
  return (
    <section className="execution-result">
      <SectionHeading
        eyebrow="Recorded fork execution"
        title="Position protected"
        description="This transaction executed against real production contracts inside the pinned X Layer fork."
        action={<StatusPill tone="success" icon={Zap}>CONFIRMED</StatusPill>}
      />

      <div className="execution-timeline" aria-label="Execution timeline">
        {executionStages.map((stage, index) => (
          <div key={stage}>
            <span className="timeline-dot"><Check aria-hidden="true" size={12} /></span>
            <strong>{stage}</strong>
            <small>{index < 5 ? "Policy cycle" : `Block ${result.blockNumber}`}</small>
          </div>
        ))}
      </div>

      <div className="outcome-comparison">
        <div>
          <span>Health factor</span>
          <strong>{healthFactor(before)}</strong>
          <ArrowRight aria-hidden="true" size={18} />
          <strong className="outcome-positive">{healthFactor(after)}</strong>
        </div>
        <div>
          <span>Debt repaid</span>
          <strong>{tokenAmount(result.deleveraged.debtRepaidWei, 6)} xETH</strong>
        </div>
        <div>
          <span>Collateral sold</span>
          <strong>{tokenAmount(result.deleveraged.collateralSoldWei, 6)} xBETH</strong>
        </div>
        <div>
          <span>Surplus returned</span>
          <strong>{tokenAmount(result.deleveraged.surplusReturnedWei, 6)} xETH</strong>
        </div>
      </div>

      <div className="transaction-line">
        <span><Fuel aria-hidden="true" size={14} /> {number(result.gasUsed)} gas</span>
        <code title={result.transactionHash}>{shortHash(result.transactionHash)}</code>
        <span className="fork-transaction-label">FORK TRANSACTION</span>
        <button className="icon-button" title="Explorer unavailable for a local fork transaction" type="button" disabled>
          <ExternalLink aria-hidden="true" size={15} />
          <span className="sr-only">Open transaction</span>
        </button>
      </div>
    </section>
  );
}
