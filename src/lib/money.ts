/**
 * Money is always an integer number of centavos (₱1 = 100). Never use floats
 * for amounts; these helpers are the only place pesos ↔ centavos conversion happens.
 */

export type Centavos = number;

export function assertCentavos(value: number, label = "amount"): Centavos {
  if (!Number.isSafeInteger(value)) {
    throw new Error(`${label} must be a whole number of centavos, got ${value}`);
  }
  return value;
}

const grouping = new Intl.NumberFormat("en-PH", { maximumFractionDigits: 0 });

/** ₱1,234.50. With `trimZeros`, whole-peso amounts drop the ".00" (₱95). */
export function formatPeso(centavos: Centavos, opts: { trimZeros?: boolean; sign?: boolean } = {}): string {
  assertCentavos(centavos);
  const negative = centavos < 0;
  const abs = Math.abs(centavos);
  const pesos = Math.floor(abs / 100);
  const cents = abs % 100;
  const body =
    opts.trimZeros && cents === 0
      ? grouping.format(pesos)
      : `${grouping.format(pesos)}.${String(cents).padStart(2, "0")}`;
  const prefix = negative ? "−" : opts.sign && centavos > 0 ? "+" : "";
  return `${prefix}₱${body}`;
}

/** Plain number string for CSV exports: 1234.50 */
export function centavosToDecimalString(centavos: Centavos): string {
  assertCentavos(centavos);
  const negative = centavos < 0;
  const abs = Math.abs(centavos);
  return `${negative ? "-" : ""}${Math.floor(abs / 100)}.${String(abs % 100).padStart(2, "0")}`;
}

/**
 * Parses what a person types ("1,234.5", "₱100", "95") into centavos using
 * string arithmetic only. Returns null for anything that isn't a valid amount
 * or has more than 2 decimal places.
 */
export function parsePeso(input: string): Centavos | null {
  const cleaned = input.replace(/[₱,\s]/g, "");
  if (cleaned === "") return null;
  const match = /^(\d+)(?:\.(\d{0,2}))?$/.exec(cleaned);
  if (!match) return null;
  const whole = Number(match[1]);
  const frac = Number((match[2] ?? "").padEnd(2, "0"));
  const result = whole * 100 + frac;
  return Number.isSafeInteger(result) ? result : null;
}

/** Pesos (whole) → centavos, for literal constants such as quick-cash buttons. */
export function pesos(amount: number): Centavos {
  if (!Number.isInteger(amount)) throw new Error("pesos() takes whole pesos");
  return amount * 100;
}

/** amount × basisPoints / 10000, rounded half-up, in integer arithmetic. 1050 bp = 10.5%. */
export function percentOf(amount: Centavos, basisPoints: number): Centavos {
  assertCentavos(amount);
  if (!Number.isInteger(basisPoints) || basisPoints < 0) throw new Error("basis points must be a non-negative integer");
  return Math.floor((amount * basisPoints + 5000) / 10000);
}

/** Parses "10" or "12.5" percent into basis points. */
export function parsePercent(input: string): number | null {
  const match = /^(\d{1,3})(?:\.(\d{1,2}))?$/.exec(input.trim().replace(/%$/, ""));
  if (!match) return null;
  const bp = Number(match[1]) * 100 + Number((match[2] ?? "").padEnd(2, "0"));
  return bp <= 10000 ? bp : null;
}

export function formatPercent(basisPointsOrRatio: number, digits = 1): string {
  return `${basisPointsOrRatio.toFixed(digits)}%`;
}

export function sumCentavos(values: readonly Centavos[]): Centavos {
  let total = 0;
  for (const v of values) total += assertCentavos(v);
  return assertCentavos(total, "sum");
}

/** Margin percentage (0–100) for display; returns null when price is 0. */
export function marginPercent(price: Centavos, cost: Centavos): number | null {
  if (price <= 0) return null;
  return ((price - cost) / price) * 100;
}
