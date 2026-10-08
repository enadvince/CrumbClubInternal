import type { ReactNode } from "react";

export function PageHeader({ title, subtitle, actions }: { title: string; subtitle?: ReactNode; actions?: ReactNode }) {
  return (
    <div className="mb-6 flex flex-wrap items-end justify-between gap-3">
      <div>
        <h1 className="text-2xl font-black tracking-tight sm:text-3xl">{title}</h1>
        {subtitle && <p className="mt-1 text-ink-soft">{subtitle}</p>}
      </div>
      {actions && <div className="flex flex-wrap gap-2">{actions}</div>}
    </div>
  );
}

type Tone = "info" | "ok" | "warn" | "danger";
const toneClass: Record<Tone, string> = {
  info: "bg-ube-light text-ube border-ube/30",
  ok: "bg-ok-light text-ok border-ok/30",
  warn: "bg-warn-light text-warn border-warn/40",
  danger: "bg-danger-light text-danger border-danger/30",
};
const toneIcon: Record<Tone, string> = { info: "ℹ", ok: "✓", warn: "⚠", danger: "✕" };

/** Status message with an icon + text, never colour alone. */
export function Notice({ tone = "info", children, className = "" }: { tone?: Tone; children: ReactNode; className?: string }) {
  return (
    <div role={tone === "danger" ? "alert" : "status"} className={`flex items-start gap-2 rounded-xl border px-3 py-2 text-sm font-medium ${toneClass[tone]} ${className}`}>
      <span aria-hidden className="font-bold">{toneIcon[tone]}</span>
      <div className="min-w-0 flex-1">{children}</div>
    </div>
  );
}

export function Field({ label, htmlFor, hint, children }: { label: string; htmlFor: string; hint?: ReactNode; children: ReactNode }) {
  return (
    <div>
      <label htmlFor={htmlFor} className="label">{label}</label>
      {children}
      {hint && <p className="mt-1 text-xs text-ink-soft">{hint}</p>}
    </div>
  );
}

export function EmptyState({ children }: { children: ReactNode }) {
  return <div className="card p-8 text-center text-ink-soft">{children}</div>;
}

export function Spinner({ label = "Loading" }: { label?: string }) {
  return (
    <div role="status" className="flex items-center gap-2 p-4 text-ink-soft">
      <span aria-hidden className="h-5 w-5 animate-spin rounded-full border-2 border-crust-dark border-t-caramel" />
      {label}…
    </div>
  );
}

export function Logo({ className = "" }: { className?: string }) {
  return (
    <span className={`font-black tracking-tight ${className}`}>
      <span aria-hidden>🥐 </span>Crumb Club
    </span>
  );
}
