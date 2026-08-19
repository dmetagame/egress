"use client";

import { useRef } from "react";
import { useGSAP } from "@gsap/react";
import { gsap } from "gsap";
import { ScrollTrigger } from "gsap/ScrollTrigger";

gsap.registerPlugin(useGSAP, ScrollTrigger);

function reducedMotion(): boolean {
  return window.matchMedia("(prefers-reduced-motion: reduce)").matches;
}

export function Reveal({
  children,
  className = "",
  delay = 0,
  distance = 24,
}: {
  children: React.ReactNode;
  className?: string;
  delay?: number;
  distance?: number;
}) {
  const root = useRef<HTMLDivElement>(null);

  useGSAP(() => {
    if (!root.current || reducedMotion()) return;
    gsap.from(root.current, {
      autoAlpha: 0,
      y: distance,
      duration: 0.82,
      delay,
      ease: "power3.out",
      scrollTrigger: {
        trigger: root.current,
        start: "top 88%",
        once: true,
      },
    });
  }, { scope: root });

  return <div className={`motion-reveal ${className}`.trim()} ref={root}>{children}</div>;
}

export function Stagger({
  children,
  className = "",
}: {
  children: React.ReactNode;
  className?: string;
}) {
  const root = useRef<HTMLDivElement>(null);

  useGSAP(() => {
    if (!root.current || reducedMotion()) return;
    gsap.from(root.current.querySelectorAll<HTMLElement>("[data-stagger-item]"), {
      autoAlpha: 0,
      y: 20,
      duration: 0.68,
      stagger: 0.09,
      ease: "power3.out",
      scrollTrigger: {
        trigger: root.current,
        start: "top 84%",
        once: true,
      },
    });
  }, { scope: root });

  return <div className={`motion-stagger ${className}`.trim()} ref={root}>{children}</div>;
}

export function StateTransition({
  children,
  stateKey,
  className = "",
}: {
  children: React.ReactNode;
  stateKey: string;
  className?: string;
}) {
  const root = useRef<HTMLDivElement>(null);

  useGSAP(() => {
    if (!root.current || reducedMotion()) return;
    const timeline = gsap.timeline();
    timeline
      .fromTo(root.current, { autoAlpha: 0.72 }, { autoAlpha: 1, duration: 0.22 })
      .fromTo(
        root.current.querySelectorAll<HTMLElement>("[data-state-item]"),
        { autoAlpha: 0, y: 10 },
        { autoAlpha: 1, y: 0, duration: 0.42, stagger: 0.055, ease: "power2.out" },
        0,
      );
  }, { dependencies: [stateKey], scope: root, revertOnUpdate: true });

  return (
    <div className={`state-transition ${className}`.trim()} ref={root}>
      {children}
    </div>
  );
}
