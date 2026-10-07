"use client";
import { useEffect, useState } from "react";
import { parsePeso, type Centavos } from "@/lib/money";

/** Text input for peso amounts. Keeps the raw text while typing; reports centavos (or null). */
export function MoneyInput({
  id, value, onChange, required, placeholder = "0.00", className = "", autoFocus,
}: {
  id: string; value: Centavos | null; onChange: (v: Centavos | null) => void;
  required?: boolean; placeholder?: string; className?: string; autoFocus?: boolean;
}) {
  const [text, setText] = useState(value == null ? "" : toText(value));

  useEffect(() => {
    // Sync when the parent changes the value (not while it matches what was typed).
    if (parsePeso(text) !== value) setText(value == null ? "" : toText(value));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [value]);

  const invalid = text !== "" && parsePeso(text) == null;
  return (
    <div className={`relative ${className}`}>
      <span aria-hidden className="pointer-events-none absolute top-1/2 left-3 -translate-y-1/2 font-semibold text-ink-soft">₱</span>
      <input
        id={id}
        inputMode="decimal"
        autoComplete="off"
        autoFocus={autoFocus}
        required={required}
        aria-invalid={invalid}
        placeholder={placeholder}
        className={`input pl-7 text-right tabular-nums ${invalid ? "border-danger" : ""}`}
        value={text}
        onChange={(e) => {
          setText(e.target.value);
          onChange(parsePeso(e.target.value));
        }}
      />
    </div>
  );
}

function toText(c: Centavos) {
  const whole = Math.trunc(c / 100);
  const cents = Math.abs(c % 100);
  return cents === 0 ? String(whole) : `${whole}.${String(cents).padStart(2, "0")}`;
}
