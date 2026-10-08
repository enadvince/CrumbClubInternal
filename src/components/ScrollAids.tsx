"use client";
import { useEffect, useState, type RefObject } from "react";

function scrollState(el: HTMLElement | null) {
  if (el) return { top: el.scrollTop, max: el.scrollHeight - el.clientHeight };
  const doc = document.documentElement;
  return { top: window.scrollY, max: doc.scrollHeight - window.innerHeight };
}

function useScroll(target?: RefObject<HTMLElement | null>) {
  const [state, setState] = useState({ top: 0, max: 0 });
  useEffect(() => {
    const el = target?.current ?? null;
    const source: HTMLElement | Window = el ?? window;
    const update = () => setState(scrollState(el));
    update();
    source.addEventListener("scroll", update, { passive: true });
    window.addEventListener("resize", update);
    const observer = el && typeof ResizeObserver !== "undefined" ? new ResizeObserver(update) : null;
    if (el && observer) observer.observe(el);
    return () => {
      source.removeEventListener("scroll", update);
      window.removeEventListener("resize", update);
      observer?.disconnect();
    };
  }, [target]);
  return state;
}

const prefersReducedMotion = () =>
  typeof window !== "undefined" && window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;

/** Thin bar showing how far down a long view (the page, or a scroll container) you are. */
export function ScrollProgress({ target }: { target?: RefObject<HTMLElement | null> }) {
  const { top, max } = useScroll(target);
  if (max <= 0) return null;
  const pct = Math.min(100, Math.max(0, (top / max) * 100));
  return (
    <div
      className={`no-print ${target ? "sticky" : "fixed"} top-0 right-0 left-0 z-30 h-1 bg-crust`}
      role="progressbar" aria-label="Scroll progress" aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(pct)}
    >
      <div className="h-full bg-caramel" style={{ width: `${pct}%` }} />
    </div>
  );
}

/** "Back to top" button that appears once a long list has been scrolled. */
export function BackToTop({ target, threshold = 400 }: { target?: RefObject<HTMLElement | null>; threshold?: number }) {
  const { top } = useScroll(target);
  if (top < threshold) return null;
  return (
    <div className={`no-print pointer-events-none ${target ? "sticky bottom-3 flex justify-end pr-3" : "fixed right-4 bottom-24 z-30"}`}>
      <button
        type="button"
        className="btn-secondary pointer-events-auto min-h-12 shadow-lg"
        onClick={() => (target?.current ?? window).scrollTo({ top: 0, behavior: prefersReducedMotion() ? "auto" : "smooth" })}
      >
        ↑ Back to top
      </button>
    </div>
  );
}
