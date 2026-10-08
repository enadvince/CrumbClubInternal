// Same CSV rules as src/lib/csv.ts (a test checks they match):
// UTF-8 BOM, one header row, CRLF, ISO dates in Asia/Manila, amounts as plain 2-decimal numbers.
export const BOM = "﻿";

export function toCsv(headers: readonly string[], rows: readonly (readonly unknown[])[]): string {
  const esc = (v: unknown) => {
    if (v === null || v === undefined) return "";
    const s = String(v);
    return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  return BOM + [headers, ...rows].map((r) => r.map(esc).join(",")).join("\r\n") + "\r\n";
}

/** Manila is UTC+8 all year, so shifting by 8 hours gives exact local wall-clock time. */
export function csvDate(ts: string | number | Date | null | undefined): string {
  if (ts === null || ts === undefined || ts === "") return "";
  const d = new Date(new Date(ts).getTime() + 8 * 3600_000);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}T${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}:${pad(d.getUTCSeconds())}+08:00`;
}

export function csvMoney(centavos: number | string | null | undefined): string {
  if (centavos === null || centavos === undefined || centavos === "") return "";
  const n = typeof centavos === "string" ? Number(centavos) : centavos;
  const abs = Math.abs(n);
  return `${n < 0 ? "-" : ""}${Math.floor(abs / 100)}.${String(abs % 100).padStart(2, "0")}`;
}

/** Start and end (exclusive) of a Manila calendar day, as UTC ISO strings. */
export function manilaDayWindow(date: string): { from: string; to: string } {
  const start = Date.parse(`${date}T00:00:00+08:00`);
  return { from: new Date(start).toISOString(), to: new Date(start + 24 * 3600_000).toISOString() };
}

/** Today's date in Manila, YYYY-MM-DD. */
export function manilaToday(now = Date.now()): string {
  return new Date(now + 8 * 3600_000).toISOString().slice(0, 10);
}
