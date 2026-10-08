import bcrypt from "bcryptjs";
import { sampleSnapshot } from "../pos/fixtures";
import type { SalePayload, Snapshot } from "../pos/types";
import { SyncError, type SyncTransport } from "./sync";

/**
 * DEV/TEST ONLY (NEXT_PUBLIC_POS_DEMO=1): a fake "server" kept in localStorage
 * so the POS can be exercised without Supabase. It follows navigator.onLine,
 * so DevTools' offline toggle (or Playwright's setOffline) simulates outages.
 * PINs: 1234 (Owner), 1111 (Staff One), 2222 (Staff Two).
 */
const KEY = "crumbclub-demo-server";

type DemoRefund = { components: { event_product_id: string; quantity: number }[] };
type DemoState = {
  refunds?: Record<string, DemoRefund>;
  sales: Record<string, { lines: SalePayload["lines"]; status: "completed" | "voided"; qr: string | null; orderNumber?: string }>;
  adjustments: Record<string, { event_product_id: string; quantity_change: number }>;
  availability: Record<string, boolean>;
};

const load = (): DemoState => {
  try {
    return JSON.parse(localStorage.getItem(KEY) ?? "") as DemoState;
  } catch {
    return { sales: {}, adjustments: {}, availability: {} };
  }
};
const save = (s: DemoState) => localStorage.setItem(KEY, JSON.stringify(s));

let staffCache: Snapshot["staff"] | null = null;
function staff(): Snapshot["staff"] {
  staffCache ??= [
    { id: "staff-owner", name: "Owner", role: "owner", pin_hash: bcrypt.hashSync("1234", 4) },
    { id: "staff-1", name: "Staff One", role: "staff", pin_hash: bcrypt.hashSync("1111", 4) },
    { id: "staff-2", name: "Staff Two", role: "staff", pin_hash: bcrypt.hashSync("2222", 4) },
  ];
  return staffCache;
}

/** Highest order sequence per day the demo server has seen, like the real snapshot sends. */
function counters(s: DemoState): Record<string, number> {
  const out: Record<string, number> = {};
  for (const sale of Object.values(s.sales)) {
    const m = /^T\d+-(\d{6})-(\d+)$/.exec(sale.orderNumber ?? "");
    if (m) out[m[1]] = Math.max(out[m[1]] ?? 0, Number(m[2]));
  }
  return out;
}

export function demoTransport(): SyncTransport {
  const guard = async () => {
    await new Promise((r) => setTimeout(r, 120));
    if (!navigator.onLine) throw new SyncError("Failed to fetch", false);
  };
  return {
    async recordSale(sale) {
      await guard();
      const s = load();
      s.sales[sale.id] ??= { lines: sale.lines, status: "completed", qr: sale.qr_reference, orderNumber: sale.order_number };
      save(s);
    },
    async voidSale(a) {
      await guard();
      const s = load();
      if (!s.sales[a.transaction_id]) throw new SyncError("transaction not found", true);
      s.sales[a.transaction_id].status = "voided";
      save(s);
    },
    async adjustStock(p) {
      await guard();
      const s = load();
      s.adjustments[p.id as string] ??= p as never;
      save(s);
    },
    async setAvailability(a) {
      await guard();
      const s = load();
      s.availability[a.event_product_id] = a.available;
      save(s);
    },
    async logPinUse() {
      await guard();
    },
    async fetchSnapshot() {
      await guard();
      const s = load();
      const snap = sampleSnapshot();
      snap.staff = staff();
      snap.products = snap.products!.map((p) => {
        let stock = p.stock;
        for (const sale of Object.values(s.sales)) {
          if (sale.status !== "completed") continue;
          for (const l of sale.lines) for (const c of l.components) if (c.event_product_id === p.event_product_id) stock -= c.quantity;
        }
        for (const a of Object.values(s.adjustments)) if (a.event_product_id === p.event_product_id) stock += a.quantity_change;
        for (const r of Object.values(s.refunds ?? {})) for (const c of r.components) if (c.event_product_id === p.event_product_id) stock += c.quantity;
        return { ...p, stock, is_available: s.availability[p.event_product_id] ?? p.is_available };
      });
      snap.voided_transaction_ids = Object.entries(s.sales).filter(([, v]) => v.status === "voided").map(([k]) => k);
      snap.recent_qr_refs = Object.values(s.sales).map((v) => v.qr).filter((r): r is string => !!r);
      snap.device = { id: "demo-device", code: "T1", label: "Demo tablet", order_counters: counters(s) };
      return snap;
    },
    async heartbeat() {},
    async voidOrder(p) {
      await guard();
      const s = load();
      const sale = s.sales[p.transaction_id as string];
      if (!sale) throw new SyncError("order not found; it must sync before it can be voided", true);
      sale.status = "voided";
      save(s);
    },
    async refundOrder(p) {
      await guard();
      const s = load();
      const sale = s.sales[p.transaction_id as string];
      if (!sale) throw new SyncError("order not found; it must sync before it can be refunded", true);
      s.refunds ??= {};
      if (!s.refunds[p.id as string]) {
        const components: DemoRefund["components"] = [];
        for (const rl of p.lines as { transaction_line_id: string; quantity: number }[]) {
          const line = sale.lines.find((l) => l.id === rl.transaction_line_id);
          for (const c of line?.components ?? []) components.push({ event_product_id: c.event_product_id, quantity: Math.floor((c.quantity * rl.quantity) / line!.quantity) });
        }
        s.refunds[p.id as string] = { components };
      }
      save(s);
    },
    async logAudit() {
      await guard();
    },
    async uploadPaymentPhoto() {
      await guard();
    },
    async claimDeviceCode() {
      await guard();
      return { device_id: "demo-device", device_code: "T1", label: "Demo tablet" };
    },
    async ping() {
      await guard();
      return { server_time: new Date().toISOString() };
    },
  };
}

export const isPosDemo = () => process.env.NEXT_PUBLIC_POS_DEMO === "1";
