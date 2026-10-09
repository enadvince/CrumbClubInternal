import { KV, type DeviceInfo, type PosDatabase } from "./db";

/*
 * Order numbers: {DEVICE_CODE}-{YYMMDD}-{SEQ}, e.g. T1-261008-0042.
 *  - DEVICE_CODE is unique per business (claimed from pos_devices), so two tablets never collide.
 *  - YYMMDD is the Asia/Manila calendar day; SEQ restarts at local midnight.
 *  - The counter is kept per day, so a tablet whose clock jumps back to an earlier day carries on
 *    from that day's last number instead of starting again at 1.
 *  - The counter is bumped in the same IndexedDB transaction that saves the order, so a crash
 *    can never hand the same number out twice.
 */

export type OrderCounters = Record<string, number>;

const dayFmt = new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Manila", year: "2-digit", month: "2-digit", day: "2-digit" });

/** YYMMDD for the Asia/Manila calendar day of a moment. */
export function manilaDayCode(ts: number | Date): string {
  const parts = Object.fromEntries(dayFmt.formatToParts(new Date(ts)).map((p) => [p.type, p.value]));
  return `${parts.year}${parts.month}${parts.day}`;
}

export function formatOrderNumber(deviceCode: string, day: string, seq: number): string {
  return `${deviceCode}-${day}-${String(seq).padStart(4, "0")}`;
}

const ORDER_RE = /^(T\d{1,3})-(\d{6})-(\d{4,})$/;

export function parseOrderNumber(orderNumber: string): { deviceCode: string; day: string; seq: number } | null {
  const m = ORDER_RE.exec(orderNumber);
  return m ? { deviceCode: m[1], day: m[2], seq: Number(m[3]) } : null;
}

/** What staff call out at the counter: the last 3 digits of the sequence ("042"). */
export function shortOrderNumber(orderNumber: string | undefined | null): string {
  if (!orderNumber) return "";
  const parsed = parseOrderNumber(orderNumber);
  if (!parsed) return orderNumber;
  return String(parsed.seq % 1000).padStart(3, "0");
}

const DAY_MS = 24 * 60 * 60 * 1000;
const dayCodeToUtc = (code: string) => Date.UTC(2000 + Number(code.slice(0, 2)), Number(code.slice(2, 4)) - 1, Number(code.slice(4, 6)));

/** Keeps the highest sequence per day from both sides, and drops days older than `keepDays`. */
export function mergeCounters(local: OrderCounters, server: OrderCounters, todayCode: string, keepDays = 7): OrderCounters {
  const out: OrderCounters = {};
  const today = dayCodeToUtc(todayCode);
  for (const src of [local, server]) {
    for (const [day, seq] of Object.entries(src)) {
      if (!/^\d{6}$/.test(day) || !Number.isFinite(seq)) continue;
      if (today - dayCodeToUtc(day) > keepDays * DAY_MS) continue;
      out[day] = Math.max(out[day] ?? 0, Math.floor(seq));
    }
  }
  return out;
}

export class DeviceNotRegisteredError extends Error {
  constructor() {
    super("This tablet has no device code yet. Connect to the internet once to register it.");
    this.name = "DeviceNotRegisteredError";
  }
}

/**
 * Claims the next order number. MUST be called inside a Dexie "rw" transaction that
 * includes db.kv, together with the write that saves the order.
 */
export async function takeOrderNumber(db: PosDatabase, now: number): Promise<{ orderNumber: string; deviceId: string }> {
  const device = await db.getKv<DeviceInfo>(KV.device);
  if (!device?.deviceCode || !device.deviceId) throw new DeviceNotRegisteredError();
  const day = manilaDayCode(now);
  const counters = (await db.getKv<OrderCounters>(KV.orderCounters)) ?? {};
  const seq = (counters[day] ?? 0) + 1;
  await db.setKv<OrderCounters>(KV.orderCounters, mergeCounters({ ...counters, [day]: seq }, {}, day));
  return { orderNumber: formatOrderNumber(device.deviceCode, day, seq), deviceId: device.deviceId };
}

/** Applies the device code and the server's counters from a snapshot. */
export async function applyDeviceState(
  db: PosDatabase,
  device: { id: string; code: string; label: string | null; order_counters: OrderCounters } | null | undefined,
  now: number,
): Promise<void> {
  if (!device) return;
  await db.transaction("rw", db.kv, async () => {
    const current = (await db.getKv<DeviceInfo>(KV.device)) ?? { userId: "" };
    if (current.deviceId !== device.id || current.deviceCode !== device.code) {
      await db.setKv<DeviceInfo>(KV.device, { ...current, deviceId: device.id, deviceCode: device.code, label: device.label ?? undefined });
    }
    const local = (await db.getKv<OrderCounters>(KV.orderCounters)) ?? {};
    await db.setKv<OrderCounters>(KV.orderCounters, mergeCounters(local, device.order_counters ?? {}, manilaDayCode(now)));
  });
}
