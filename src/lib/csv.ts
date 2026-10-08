import { centavosToDecimalString } from "./money";

/*
 * CSV rules for every export and backup (Excel-friendly):
 *  - UTF-8 with a byte order mark, so Excel reads ₱ and ñ correctly
 *  - one header row, CRLF line endings, RFC 4180 quoting
 *  - dates as ISO 8601 in Asia/Manila time, e.g. 2026-10-08T14:05:09+08:00
 *  - amounts as plain numbers with 2 decimals, e.g. 1234.50 (no ₱, no thousands separator)
 * supabase/functions/daily-backup/csv.ts follows the same rules (tested to match).
 */
export const BOM = "﻿";

export function toCsv(headers: readonly string[], rows: readonly (readonly unknown[])[]): string {
  const esc = (v: unknown) => {
    if (v === null || v === undefined) return "";
    const s = String(v);
    return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  return BOM + [headers, ...rows].map((r) => r.map(esc).join(",")).join("\r\n") + "\r\n";
}

const manilaParts = new Intl.DateTimeFormat("en-CA", {
  timeZone: "Asia/Manila", year: "numeric", month: "2-digit", day: "2-digit",
  hour: "2-digit", minute: "2-digit", second: "2-digit", hourCycle: "h23",
});

/** ISO 8601 in Asia/Manila (UTC+8, no daylight saving): 2026-10-08T14:05:09+08:00. Empty for null. */
export function csvDate(ts: string | number | Date | null | undefined): string {
  if (ts === null || ts === undefined || ts === "") return "";
  const p = Object.fromEntries(manilaParts.formatToParts(new Date(ts)).map((x) => [x.type, x.value]));
  return `${p.year}-${p.month}-${p.day}T${p.hour}:${p.minute}:${p.second}+08:00`;
}

/** 1234.50 for 123450 centavos. Empty for null. */
export function csvMoney(centavos: number | null | undefined): string {
  return centavos === null || centavos === undefined ? "" : centavosToDecimalString(centavos);
}

/** Triggers a browser download of text content. */
export function downloadText(filename: string, content: string, type = "text/csv") {
  const blob = new Blob([content], { type: `${type};charset=utf-8` });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
