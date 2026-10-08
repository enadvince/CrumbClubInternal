/**
 * UUID version 7 (RFC 9562): 48-bit Unix ms timestamp, then random bits.
 * Sorts by creation time and is unique without coordination, so the tablet
 * can mint ids offline. Used as client_order_id, the sync idempotency key.
 */
export function uuidv7(now: number = Date.now(), random: (bytes: Uint8Array) => Uint8Array = (b) => crypto.getRandomValues(b)): string {
  const b = random(new Uint8Array(16));
  const ms = Math.max(0, Math.floor(now));
  // 48-bit big-endian timestamp. Division keeps it exact beyond 32 bits.
  const high = Math.floor(ms / 2 ** 16);
  b[0] = (high >>> 24) & 0xff;
  b[1] = (high >>> 16) & 0xff;
  b[2] = (high >>> 8) & 0xff;
  b[3] = high & 0xff;
  b[4] = (ms >>> 8) & 0xff;
  b[5] = ms & 0xff;
  b[6] = (b[6] & 0x0f) | 0x70; // version 7
  b[8] = (b[8] & 0x3f) | 0x80; // RFC 4122 variant
  const hex = [...b].map((x) => x.toString(16).padStart(2, "0")).join("");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

/** Milliseconds encoded in a v7 UUID. */
export function uuidv7Time(id: string): number {
  return parseInt(id.replace(/-/g, "").slice(0, 12), 16);
}
