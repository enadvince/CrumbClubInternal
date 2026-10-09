"use client";
import { useState, type InputHTMLAttributes } from "react";

/** Password or PIN input with a Show/Hide toggle. */
export function SecretInput({ className = "", ...props }: Omit<InputHTMLAttributes<HTMLInputElement>, "type">) {
  const [visible, setVisible] = useState(false);
  return (
    <div className="flex items-stretch gap-2">
      <input {...props} type={visible ? "text" : "password"} className={`input ${className}`} />
      <button
        type="button"
        className="btn-secondary min-h-12 shrink-0 px-3 text-sm"
        onClick={() => setVisible((v) => !v)}
        aria-pressed={visible}
        aria-label={visible ? "Hide" : "Show"}
      >
        {visible ? "Hide" : "Show"}
      </button>
    </div>
  );
}
