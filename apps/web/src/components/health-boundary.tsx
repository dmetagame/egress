"use client";

import { useRef } from "react";
import { useGSAP } from "@gsap/react";
import { gsap } from "gsap";
import { Activity, ShieldCheck, TriangleAlert } from "lucide-react";

gsap.registerPlugin(useGSAP);

interface HealthBoundaryProps {
  value: number | null;
  trigger?: number | null;
  target?: number | null;
  observedLabel?: string;
  compact?: boolean;
}

const SCALE_MIN = 0.96;
const SCALE_MAX = 1.24;

function clamp(value: number): number {
  return Math.max(0, Math.min(100, value));
}

function markerPosition(value: number): number {
  return clamp(((value - SCALE_MIN) / (SCALE_MAX - SCALE_MIN)) * 100);
}

export function HealthBoundary({
  value,
  trigger = null,
  target = null,
  observedLabel = "Current position",
  compact = false,
}: HealthBoundaryProps) {
  const root = useRef<HTMLElement>(null);
  const state = healthState(value, trigger);
  const position = value === null ? null : markerPosition(value);
  const triggerPosition = trigger === null ? null : markerPosition(trigger);
  const visibleTriggerPosition = triggerPosition ?? markerPosition(1.05);
  const targetPosition = target === null ? null : markerPosition(target);

  useGSAP(() => {
    if (!root.current || position === null || window.matchMedia("(prefers-reduced-motion: reduce)").matches) return;
    gsap.fromTo(
      root.current.querySelector(".health-position-marker"),
      { left: `${markerPosition(1)}%`, autoAlpha: 0 },
      { left: `${position}%`, autoAlpha: 1, duration: 1.05, ease: "power3.out" },
    );
    gsap.fromTo(
      root.current.querySelector(".health-distance-line"),
      { scaleX: 0 },
      { scaleX: 1, duration: 0.9, delay: 0.18, ease: "power2.out" },
    );
  }, { dependencies: [position], scope: root, revertOnUpdate: true });

  const Icon = state.tone === "danger" ? TriangleAlert : state.tone === "success" ? ShieldCheck : Activity;
  const summary = value === null
    ? "Health factor is unavailable. No protection state is inferred."
    : `Health factor ${value.toFixed(4)}. ${state.label}. Liquidation boundary is 1.0000${trigger ? ` and the policy trigger is ${trigger.toFixed(4)}` : ""}.`;

  return (
    <figure className={`health-boundary${compact ? " is-compact" : ""}`} ref={root}>
      <figcaption>
        <div>
          <span className="health-boundary-kicker">Position health</span>
          <strong>{value === null ? "Unavailable" : value.toFixed(4)}</strong>
        </div>
        <span className={`health-boundary-state tone-text-${state.tone}`}>
          <Icon aria-hidden="true" size={15} /> {state.label}
        </span>
      </figcaption>

      <p className="sr-only">{summary}</p>
      <div className="health-boundary-plot" aria-hidden="true">
        <div className="health-zone health-zone-liquidation" style={{ width: `${markerPosition(1)}%` }}><span>Liquidation</span></div>
        <div
          className="health-zone health-zone-danger"
          style={{ left: `${markerPosition(1)}%`, width: `${Math.max(0, visibleTriggerPosition - markerPosition(1))}%` }}
        >
          <span>Danger</span>
        </div>
        <div className="health-zone health-zone-safe" style={{ left: `${visibleTriggerPosition}%`, width: `${100 - visibleTriggerPosition}%` }}><span>Safe</span></div>

        <span className="health-wall health-wall-liquidation" style={{ left: `${markerPosition(1)}%` }}>
          <b>1.0000</b><small>Liquidation boundary</small>
        </span>
        {triggerPosition !== null ? (
          <span className="health-wall health-wall-trigger" style={{ left: `${triggerPosition}%` }}>
            <b>{trigger?.toFixed(4)}</b><small>Warning / policy trigger</small>
          </span>
        ) : null}
        {targetPosition !== null ? (
          <span className="health-target-marker" style={{ left: `${targetPosition}%` }}>
            <small>Protection target</small>
          </span>
        ) : null}
        {position !== null ? (
          <>
            <span
              className={`health-distance-line tone-fill-${state.tone}`}
              style={{ left: `${markerPosition(1)}%`, width: `${Math.max(0, position - markerPosition(1))}%` }}
            />
            <span className={`health-position-marker tone-marker-${state.tone}`} style={{ left: `${position}%` }}>
              <span />
              <b>{observedLabel}</b>
            </span>
          </>
        ) : (
          <span className="health-unavailable-marker">No verified position data</span>
        )}
      </div>

      <div className="health-boundary-scale" aria-hidden="true">
        <span>{SCALE_MIN.toFixed(2)}</span>
        <span>1.10</span>
        <span>{SCALE_MAX.toFixed(2)}+</span>
      </div>
    </figure>
  );
}

function healthState(value: number | null, trigger: number | null): { label: string; tone: "neutral" | "warning" | "danger" | "success" } {
  if (value === null) return { label: "DATA UNAVAILABLE", tone: "neutral" };
  if (value <= 1) return { label: "LIQUIDATION", tone: "danger" };
  if (trigger !== null && value <= trigger) return { label: "DANGER / TRIGGERED", tone: "danger" };
  if (trigger !== null) return { label: "SAFE / MONITORING", tone: "success" };
  return { label: "ABOVE LIQUIDATION", tone: "warning" };
}
