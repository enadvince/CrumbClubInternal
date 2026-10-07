/** All reporting is in Asia/Manila (UTC+8, no daylight saving). */
export const TZ = "Asia/Manila";
const OFFSET = "+08:00";

const dateFmt = new Intl.DateTimeFormat("en-PH", { timeZone: TZ, month: "short", day: "numeric", year: "numeric" });
const timeFmt = new Intl.DateTimeFormat("en-PH", { timeZone: TZ, hour: "numeric", minute: "2-digit" });
const dateTimeFmt = new Intl.DateTimeFormat("en-PH", { timeZone: TZ, month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
const isoDateFmt = new Intl.DateTimeFormat("en-CA", { timeZone: TZ, year: "numeric", month: "2-digit", day: "2-digit" });

/** "2026-10-07" (a Postgres date) → "Oct 7, 2026" */
export function formatDate(isoDate: string): string {
  return dateFmt.format(new Date(`${isoDate}T12:00:00${OFFSET}`));
}

export function formatDateRange(start: string, end: string): string {
  return start === end ? formatDate(start) : `${formatDate(start)} – ${formatDate(end)}`;
}

export function formatTime(ts: string | number | Date): string {
  return timeFmt.format(new Date(ts));
}

export function formatDateTime(ts: string | number | Date): string {
  return dateTimeFmt.format(new Date(ts));
}

/** The calendar date in Manila for a moment, as YYYY-MM-DD. */
export function manilaDate(ts: string | number | Date = Date.now()): string {
  return isoDateFmt.format(new Date(ts));
}

/** Start of a Manila calendar day as an ISO timestamp. */
export function manilaDayStart(isoDate: string): string {
  return new Date(`${isoDate}T00:00:00${OFFSET}`).toISOString();
}

export function addDays(isoDate: string, days: number): string {
  const d = new Date(`${isoDate}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

/** Relative "5 min ago" style label. */
export function timeAgo(ts: string | number | Date, now = Date.now()): string {
  const sec = Math.max(0, Math.round((now - new Date(ts).getTime()) / 1000));
  if (sec < 45) return "just now";
  const min = Math.round(sec / 60);
  if (min < 60) return `${min} min ago`;
  const hr = Math.round(min / 60);
  if (hr < 24) return `${hr} hr ago`;
  return formatDateTime(ts);
}
