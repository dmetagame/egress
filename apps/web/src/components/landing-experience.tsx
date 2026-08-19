"use client";

import { useRef } from "react";
import Link from "next/link";
import { useGSAP } from "@gsap/react";
import { gsap } from "gsap";
import {
  Activity,
  ArrowDown,
  ArrowRight,
  BadgeCheck,
  Braces,
  Check,
  CircleGauge,
  FileCheck2,
  Fingerprint,
  FlaskConical,
  Gauge,
  LockKeyhole,
  Radar,
  ScanSearch,
  Shield,
  ShieldCheck,
  Sparkles,
  Waves,
} from "lucide-react";
import { Reveal, Stagger } from "./motion-primitives";

gsap.registerPlugin(useGSAP);

const protectionSteps = [
  {
    number: "01",
    title: "Monitor",
    detail: "Observe xBETH backing signals, Aave position health, oracle state, and executable liquidity.",
    icon: Radar,
  },
  {
    number: "02",
    title: "Detect",
    detail: "Link a material source revision to a bounded risk verdict with traceable evidence.",
    icon: ScanSearch,
  },
  {
    number: "03",
    title: "Validate",
    detail: "Re-check policy scope, fresh market state, liquidity, attestation, and contract bounds.",
    icon: FileCheck2,
  },
  {
    number: "04",
    title: "Simulate",
    detail: "Preview the exact debt repayment, collateral route, minimum output, and expected health factor.",
    icon: FlaskConical,
  },
  {
    number: "05",
    title: "Protect",
    detail: "Present a bounded protection path only after every deterministic gate has passed.",
    icon: ShieldCheck,
  },
] as const;

const stateSequence = ["CALM", "AWARE", "AT RISK", "PROTECTION ARMED", "PROTECTED"] as const;

export function LandingExperience() {
  const root = useRef<HTMLElement>(null);

  useGSAP(() => {
    if (!root.current || window.matchMedia("(prefers-reduced-motion: reduce)").matches) return;
    const timeline = gsap.timeline({ defaults: { ease: "power3.out" } });
    timeline
      .from("[data-hero-nav]", { autoAlpha: 0, y: -14, duration: 0.6 })
      .from("[data-hero-line]", { autoAlpha: 0, yPercent: 55, duration: 0.9, stagger: 0.09 }, 0.12)
      .from("[data-hero-copy]", { autoAlpha: 0, y: 18, duration: 0.72, stagger: 0.08 }, 0.36)
      .from("[data-hero-visual]", { autoAlpha: 0, x: 24, scale: 0.985, duration: 1 }, 0.28)
      .from(".hero-scan-line", { scaleY: 0, duration: 1.15 }, 0.55)
      .from(".hero-monitor-node", { autoAlpha: 0, scale: 0.8, stagger: 0.1, duration: 0.55 }, 0.62);
  }, { scope: root });

  return (
    <main className="landing-page landing-v2" ref={root}>
      <section className="egress-hero" id="product">
        <nav className="landing-nav landing-nav-v2" data-hero-nav aria-label="Landing navigation">
          <Link className="brand" href="/" aria-label="Egress home">
            <span className="brand-mark"><LockKeyhole aria-hidden="true" size={18} /></span>
            <span><strong>EGRESS</strong><small>Protection infrastructure</small></span>
          </Link>
          <div className="landing-nav-links">
            <a href="#how-it-works">How it works</a>
            <a href="#protection">Protection</a>
            <a href="#evidence">Evidence</a>
          </div>
          <Link className="button button-secondary" href="/overview">
            Open Egress <ArrowRight aria-hidden="true" size={15} />
          </Link>
        </nav>

        <div className="hero-atmosphere" aria-hidden="true">
          <span className="atmosphere-grid" />
          <span className="atmosphere-glow" />
        </div>

        <div className="egress-hero-grid">
          <div className="hero-copy-v2">
            <p className="hero-kicker" data-hero-copy>
              <span className="signal-dot" aria-hidden="true" />
              Non-custodial circuit breaker / Aave X Layer
            </p>
            <h1 aria-label="Your position. Protected before liquidation.">
              <span className="hero-heading-line"><span data-hero-line>Your position.</span></span>
              <span className="hero-heading-line"><span data-hero-line>Protected before</span></span>
              <span className="hero-heading-line hero-heading-accent"><span data-hero-line>liquidation.</span></span>
            </h1>
            <p className="hero-summary" data-hero-copy>
              Egress watches xBETH backing risk, Aave position health, and executable liquidity, then prepares a policy-bounded protection path before deterioration becomes catastrophic.
            </p>
            <div className="landing-actions" data-hero-copy>
              <Link className="button button-primary button-large" href="/overview">
                Open Egress <ArrowRight aria-hidden="true" size={16} />
              </Link>
              <a className="button button-quiet button-large" href="#how-it-works">
                See how it works <ArrowDown aria-hidden="true" size={16} />
              </a>
            </div>
            <div className="hero-trust-line" data-hero-copy>
              <span><Check aria-hidden="true" size={13} /> No custody</span>
              <span><Check aria-hidden="true" size={13} /> User-defined bounds</span>
              <span><Check aria-hidden="true" size={13} /> Explainable evidence</span>
            </div>
          </div>

          <div className="hero-protection-visual" data-hero-visual aria-label="Illustrative Egress protection system">
            <div className="visual-chrome">
              <span><span className="signal-dot" /> Protection model</span>
              <b>ILLUSTRATIVE - NOT LIVE DATA</b>
            </div>
            <div className="visual-stage">
              <div className="hero-orbit orbit-outer" aria-hidden="true" />
              <div className="hero-orbit orbit-inner" aria-hidden="true" />
              <div className="hero-scan-line" aria-hidden="true" />
              <div className="hero-position-core">
                <Shield aria-hidden="true" size={29} strokeWidth={1.6} />
                <span>POSITION</span>
                <strong>MONITORED</strong>
              </div>
              <span className="hero-monitor-node node-collateral"><Waves size={15} /><b>xBETH</b><small>Collateral</small></span>
              <span className="hero-monitor-node node-debt"><Braces size={15} /><b>xETH</b><small>Debt</small></span>
              <span className="hero-monitor-node node-health"><Gauge size={15} /><b>Aave</b><small>Health</small></span>
              <span className="hero-monitor-node node-risk"><Activity size={15} /><b>Backing</b><small>Risk signal</small></span>
            </div>
            <div className="visual-boundary">
              <div className="boundary-labels"><span>Protection boundary</span><span>Liquidation boundary</span></div>
              <div className="boundary-track"><span className="boundary-position" /><span className="boundary-protection" /><span className="boundary-liquidation" /></div>
              <div className="boundary-caption"><ShieldCheck size={14} /><span>Egress validates a bounded route before the position reaches the hard boundary.</span></div>
            </div>
          </div>
        </div>

        <div className="hero-system-rail" aria-label="Egress system boundary">
          <span>Observe</span><i />
          <span>Evidence</span><i />
          <span>Policy</span><i />
          <span>Simulation</span><i />
          <strong>Protection</strong>
        </div>
      </section>

      <section className="landing-statement">
        <Reveal>
          <p className="eyebrow">The problem</p>
          <h2>Liquidation protection usually reacts after the position is already in distress.</h2>
          <p>Egress is designed around the earlier decision: detect a credible risk signal, prove the position is vulnerable, and validate a constrained exit path while optionality still exists.</p>
        </Reveal>
      </section>

      <section className="landing-process" id="how-it-works">
        <Reveal className="landing-section-heading">
          <p className="eyebrow">The protection loop</p>
          <h2>Five deliberate stages. One bounded outcome.</h2>
          <p>The system moves from quiet observation to protection readiness without granting arbitrary transaction authority.</p>
        </Reveal>
        <Stagger className="protection-step-grid">
          {protectionSteps.map(({ number, title, detail, icon: Icon }) => (
            <article data-stagger-item key={title}>
              <div className="step-index"><span>{number}</span><Icon aria-hidden="true" size={18} /></div>
              <h3>{title}</h3>
              <p>{detail}</p>
              <span className="step-line" aria-hidden="true" />
            </article>
          ))}
        </Stagger>
      </section>

      <section className="state-story" id="protection">
        <div className="state-story-copy">
          <Reveal>
            <p className="eyebrow">State, not spectacle</p>
            <h2>The interface changes only when the protection state changes.</h2>
            <p>Calm monitoring gives way to focused validation. Once a path is simulated and bounded, the interface stabilizes around a clear decision.</p>
          </Reveal>
          <div className="state-sequence" aria-label="Protection state progression">
            {stateSequence.map((state, index) => (
              <div key={state}>
                <span>{String(index + 1).padStart(2, "0")}</span>
                <strong>{state}</strong>
              </div>
            ))}
          </div>
        </div>

        <Reveal className="policy-boundary-card">
          <div className="policy-boundary-head">
            <span><LockKeyhole aria-hidden="true" size={17} /> Deterministic boundary</span>
            <b>FAIL CLOSED</b>
          </div>
          <div className="policy-boundary-body">
            <div><small>AI may</small><strong>Interpret evidence</strong><span>Classify source changes and explain why they matter.</span></div>
            <ArrowRight aria-hidden="true" size={18} />
            <div><small>Policy must</small><strong>Authorize scope</strong><span>Constrain assets, amounts, slippage, freshness, and timing.</span></div>
            <ArrowRight aria-hidden="true" size={18} />
            <div><small>Contracts will</small><strong>Enforce bounds</strong><span>Reject any action that does not match the signed protection policy.</span></div>
          </div>
        </Reveal>
      </section>

      <section className="simulation-story">
        <Reveal className="landing-section-heading">
          <p className="eyebrow">Simulation before action</p>
          <h2>Nothing executes blindly.</h2>
          <p>The user sees the current position, the proposed bounded protection, and the expected result as one continuous decision.</p>
        </Reveal>
        <Stagger className="simulation-story-grid">
          <article data-stagger-item>
            <span className="simulation-stage-label">Current position</span>
            <CircleGauge aria-hidden="true" size={25} />
            <h3>Vulnerability established</h3>
            <p>Debt, collateral, health factor, and the triggering evidence are observed at a pinned block.</p>
          </article>
          <span className="simulation-arrow" aria-hidden="true"><ArrowRight size={20} /></span>
          <article data-stagger-item>
            <span className="simulation-stage-label">Proposed protection</span>
            <FlaskConical aria-hidden="true" size={25} />
            <h3>Exact route simulated</h3>
            <p>Repayment, collateral withdrawal, swap output, premium, and slippage remain inside policy.</p>
          </article>
          <span className="simulation-arrow" aria-hidden="true"><ArrowRight size={20} /></span>
          <article data-stagger-item>
            <span className="simulation-stage-label">Expected result</span>
            <ShieldCheck aria-hidden="true" size={25} />
            <h3>Health restored</h3>
            <p>A target health factor and complete evidence trail are required before protection is presented as ready.</p>
          </article>
        </Stagger>
        <p className="illustrative-note"><Sparkles aria-hidden="true" size={13} /> Illustrative workflow. The console displays only verified snapshot and simulation values.</p>
      </section>

      <section className="evidence-story" id="evidence">
        <Reveal className="evidence-story-copy">
          <p className="eyebrow">Verified evidence</p>
          <h2>Every decision remains explainable.</h2>
          <p>The main interface stays calm. The technical record remains one level beneath it, ready for operators, auditors, and users who need to inspect exactly what Egress observed and why it acted.</p>
          <Link className="text-link" href="/activity">Inspect the evidence trail <ArrowRight aria-hidden="true" size={15} /></Link>
        </Reveal>
        <Stagger className="evidence-ledger-preview">
          {[
            [Fingerprint, "Snapshot hash", "Immutable observation identity"],
            [BadgeCheck, "Policy version", "The exact signed control boundary"],
            [FlaskConical, "Simulation evidence", "Inputs, bounds, and expected outcome"],
            [FileCheck2, "Transaction evidence", "Confirmation and runtime result when applicable"],
          ].map(([Icon, title, detail]) => {
            const EvidenceIcon = Icon as typeof Fingerprint;
            return (
              <article data-stagger-item key={String(title)}>
                <EvidenceIcon aria-hidden="true" size={17} />
                <div><strong>{String(title)}</strong><span>{String(detail)}</span></div>
                <code>VERIFIED</code>
              </article>
            );
          })}
        </Stagger>
      </section>

      <section className="landing-closing">
        <Reveal>
          <span className="closing-mark"><ShieldCheck aria-hidden="true" size={27} /></span>
          <p className="eyebrow">Egress</p>
          <h2>Protect the position before the market makes the decision.</h2>
          <p>Open the read-only console to inspect position health, protection readiness, risk signals, policy bounds, simulation evidence, and the complete audit trail.</p>
          <Link className="button button-primary button-large" href="/overview">Open Egress <ArrowRight aria-hidden="true" size={16} /></Link>
        </Reveal>
      </section>
    </main>
  );
}
