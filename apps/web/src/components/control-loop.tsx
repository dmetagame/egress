import type { LucideIcon } from "lucide-react";
import {
  BrainCircuit,
  CircleCheck,
  CircleDashed,
  FileSearch,
  FlaskConical,
  Gavel,
  Route,
  Zap,
} from "lucide-react";

export type LoopStageStatus =
  | "pending"
  | "active"
  | "normal"
  | "warning"
  | "passed"
  | "blocked"
  | "executed";

export interface LoopStageState {
  status: LoopStageStatus;
  detail: string;
}

const stages: Array<{ key: string; label: string; icon: LucideIcon }> = [
  { key: "signal", label: "RWA signal", icon: FileSearch },
  { key: "analysis", label: "AI analysis", icon: BrainCircuit },
  { key: "policy", label: "Policy", icon: Gavel },
  { key: "market", label: "Market check", icon: Route },
  { key: "simulation", label: "Simulation", icon: FlaskConical },
  { key: "execution", label: "Execution", icon: Zap },
];

function StatusIcon({ status }: { status: LoopStageStatus }) {
  if (status === "passed" || status === "executed" || status === "normal") {
    return <CircleCheck aria-hidden="true" className="loop-status-icon" size={15} />;
  }
  return <CircleDashed aria-hidden="true" className="loop-status-icon" size={15} />;
}

export function EgressControlLoop({ states }: { states: LoopStageState[] }) {
  return (
    <div className="control-loop" aria-label="Egress control loop">
      {stages.map(({ key, label, icon: Icon }, index) => {
        const state = states[index] ?? { status: "pending", detail: "Waiting" };
        return (
          <div className="control-loop-segment" data-state-item key={key}>
            <div className={`control-loop-stage loop-${state.status}`}>
              <span className="loop-icon" aria-hidden="true">
                <Icon size={19} />
              </span>
              <span className="loop-copy">
                <strong>{label}</strong>
                <small>{state.detail}</small>
              </span>
              <StatusIcon status={state.status} />
            </div>
            {index < stages.length - 1 ? <span className="loop-connector" aria-hidden="true" /> : null}
          </div>
        );
      })}
    </div>
  );
}
