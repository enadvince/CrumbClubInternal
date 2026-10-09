"use client";
import { useEffect, useState } from "react";
import { applyTheme, readTheme, type ThemeChoice } from "@/lib/theme";

const NEXT: Record<ThemeChoice, ThemeChoice> = { light: "dark", dark: "system", system: "light" };
const LABEL: Record<ThemeChoice, string> = { light: "☀ Light", dark: "☾ Dark", system: "◐ System" };

/** Cycles light, dark and system theme. Remembered on this device. */
export function ThemeToggle({ className = "" }: { className?: string }) {
  const [choice, setChoice] = useState<ThemeChoice>("system");
  useEffect(() => {
    setChoice(readTheme());
    const mq = window.matchMedia?.("(prefers-color-scheme: dark)");
    const onChange = () => { if (readTheme() === "system") applyTheme("system"); };
    mq?.addEventListener("change", onChange);
    return () => mq?.removeEventListener("change", onChange);
  }, []);
  return (
    <button
      type="button"
      className={`btn-ghost min-h-11 text-sm ${className}`}
      onClick={() => { const next = NEXT[choice]; applyTheme(next); setChoice(next); }}
      aria-label={`Theme: ${choice}. Switch to ${NEXT[choice]}.`}
    >
      {LABEL[choice]}
    </button>
  );
}
