"use client";
import { useState } from "react";

/** Small "Copy" button for codes: order numbers, QR references, device codes. */
export function CopyButton({ value, label = "Copy", className = "" }: { value: string; label?: string; className?: string }) {
  const [copied, setCopied] = useState(false);
  async function copy() {
    try {
      await navigator.clipboard.writeText(value);
    } catch {
      // Older WebViews: fall back to a hidden textarea.
      const ta = document.createElement("textarea");
      ta.value = value;
      ta.setAttribute("readonly", "");
      ta.style.position = "absolute";
      ta.style.left = "-9999px";
      document.body.appendChild(ta);
      ta.select();
      document.execCommand("copy");
      ta.remove();
    }
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  }
  return (
    <button
      type="button"
      onClick={(e) => { e.stopPropagation(); void copy(); }}
      className={`inline-flex min-h-11 min-w-11 items-center justify-center gap-1 rounded-lg border border-crust-dark bg-paper px-2 text-xs font-semibold text-ink hover:bg-crust active:bg-crust-dark ${className}`}
      aria-label={copied ? `Copied ${value}` : `${label} ${value}`}
    >
      <span aria-hidden>{copied ? "✓" : "⧉"}</span>
      <span aria-live="polite">{copied ? "Copied" : label}</span>
    </button>
  );
}
