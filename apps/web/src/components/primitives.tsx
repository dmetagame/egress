import type { LucideIcon } from "lucide-react";
import { CircleCheck, CircleDot, CircleX, Clock3, TriangleAlert } from "lucide-react";
import { shortAddress } from "@/lib/format";

export type Tone = "neutral" | "success" | "warning" | "danger" | "info";

const toneIcons: Record<Tone, LucideIcon> = {
  neutral: CircleDot,
  success: CircleCheck,
  warning: TriangleAlert,
  danger: CircleX,
  info: Clock3,
};

export function StatusPill({
  children,
  tone = "neutral",
  icon: Icon = toneIcons[tone],
  compact = false,
}: {
  children: React.ReactNode;
  tone?: Tone;
  icon?: LucideIcon;
  compact?: boolean;
}) {
  return (
    <span className={`status-pill tone-${tone}${compact ? " is-compact" : ""}`}>
      <Icon aria-hidden="true" size={compact ? 12 : 14} strokeWidth={2} />
      {children}
    </span>
  );
}

export function SectionHeading({
  eyebrow,
  title,
  description,
  action,
}: {
  eyebrow?: string;
  title: string;
  description?: string;
  action?: React.ReactNode;
}) {
  return (
    <header className="section-heading">
      <div>
        {eyebrow ? <p className="eyebrow">{eyebrow}</p> : null}
        <h2>{title}</h2>
        {description ? <p className="section-description">{description}</p> : null}
      </div>
      {action ? <div className="section-action">{action}</div> : null}
    </header>
  );
}

export function Metric({
  label,
  value,
  detail,
  tone = "neutral",
}: {
  label: string;
  value: React.ReactNode;
  detail?: React.ReactNode;
  tone?: Tone;
}) {
  return (
    <div className={`metric metric-${tone}`}>
      <span className="metric-label">{label}</span>
      <strong className="metric-value">{value}</strong>
      {detail ? <span className="metric-detail">{detail}</span> : null}
    </div>
  );
}

export function DefinitionRow({
  label,
  children,
  hint,
}: {
  label: string;
  children: React.ReactNode;
  hint?: string;
}) {
  return (
    <div className="definition-row">
      <div>
        <dt>{label}</dt>
        {hint ? <span className="definition-hint">{hint}</span> : null}
      </div>
      <dd>{children}</dd>
    </div>
  );
}

export function AddressText({ value, label }: { value: string; label?: string }) {
  return (
    <span className="address-text" title={value}>
      {label ? <span>{label}</span> : null}
      <code>{shortAddress(value)}</code>
    </span>
  );
}

export function PageHeader({
  eyebrow,
  title,
  description,
  status,
}: {
  eyebrow: string;
  title: string;
  description: string;
  status?: React.ReactNode;
}) {
  return (
    <header className="page-header">
      <div>
        <p className="eyebrow">{eyebrow}</p>
        <h1>{title}</h1>
        <p>{description}</p>
      </div>
      {status ? <div className="page-header-status">{status}</div> : null}
    </header>
  );
}
