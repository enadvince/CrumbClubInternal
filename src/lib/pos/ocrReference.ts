/**
 * Finds the payment reference number in text read (by OCR) from a photo of a GCash, Maya or
 * bank payment confirmation. Pure, so it is unit tested without running OCR.
 *
 * GCash shows "Ref No. 1234 567 890123" (13 digits, spaced); Maya and banks use "Reference
 * ID", "Reference No.", "Trace No." and so on, sometimes with letters. The number may sit on
 * the same line as the label or on the next one. Returns null rather than guess.
 */
const LABEL = /\b(?:ref(?:erence)?\.?\s*(?:no|number|num|id|code|#)?|trace\s*(?:no|number)|transaction\s*(?:id|no|number))\b\.?\s*[:#.]?/i;
const MONTH = /^(?:JAN|FEB|MAR|APR|MAY|JUN|JUL|AUG|SEP|SEPT|OCT|NOV|DEC)/i;
const MIN_LEN = 6;
const MAX_LEN = 24;

/** In a mostly-digit token, fix the letters OCR commonly mistakes for digits. */
function fixDigits(token: string): string {
  const digits = token.replace(/\D/g, "").length;
  if (digits / token.length < 0.6) return token;
  return token.replace(/[Oo]/g, "0").replace(/[Il|]/g, "1").replace(/S/g, "5").replace(/B/g, "8").replace(/Z/g, "2");
}

/** Reads the reference from the text after a label: uppercase/digit tokens until something else starts. */
function referenceAfter(text: string): string | null {
  const parts: string[] = [];
  for (const raw of text.trim().split(/\s+/)) {
    const token = fixDigits(raw.replace(/[.,:;]+$/, ""));
    if (!token || MONTH.test(token) || !/^[A-Z0-9-]+$/.test(token)) break;
    parts.push(token);
    if (parts.join("").length >= MAX_LEN) break;
  }
  const ref = parts.join("").replace(/-/g, "");
  return isPlausible(ref) ? ref : null;
}

function isPlausible(ref: string): boolean {
  return ref.length >= MIN_LEN && ref.length <= MAX_LEN && (ref.match(/\d/g)?.length ?? 0) >= 4;
}

/** A Philippine mobile number (09xx… or 639xx…) is never the reference. */
function isPhone(digits: string): boolean {
  return /^09\d{9}$/.test(digits) || /^639\d{9}$/.test(digits);
}

export function extractReference(ocrText: string): string | null {
  const lines = ocrText.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);

  // 1. A labelled reference, on the label's line or the next one.
  for (let i = 0; i < lines.length; i++) {
    const m = LABEL.exec(lines[i]);
    if (!m) continue;
    const found = referenceAfter(lines[i].slice(m.index + m[0].length)) ?? (i + 1 < lines.length ? referenceAfter(lines[i + 1]) : null);
    if (found) return found;
  }

  // 2. No label read: a single 12 or 13 digit number (GCash length), allowing GCash's spacing.
  const candidates = new Set<string>();
  for (const line of lines) {
    for (const m of line.matchAll(/\d[\d ]{10,16}\d/g)) {
      const digits = m[0].replace(/ /g, "");
      if ((digits.length === 12 || digits.length === 13) && !isPhone(digits)) candidates.add(digits);
    }
  }
  return candidates.size === 1 ? [...candidates][0] : null;
}
