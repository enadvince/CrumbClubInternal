import { describe, expect, it } from "vitest";
import * as edge from "./csv";
import * as app from "../../../src/lib/csv";
import { buildBackupFiles, isExpired, type BackupData } from "./files";

describe("backup CSVs follow the same rules as the app's exports", () => {
  it("formats identically", () => {
    const rows = [["a,b", 'q"q', null, 7], ["x", "y\nz", "", 0]];
    expect(edge.toCsv(["h1", "h2", "h3", "h4"], rows)).toBe(app.toCsv(["h1", "h2", "h3", "h4"], rows));
    for (const t of ["2026-10-07T16:30:00Z", "2026-12-31T15:59:59Z", "2026-03-01T00:00:00Z"]) expect(edge.csvDate(t)).toBe(app.csvDate(t));
    for (const c of [0, 5, 123450, -9500]) expect(edge.csvMoney(c)).toBe(app.csvMoney(c));
  });

  it("uses Manila calendar days for the backup window", () => {
    expect(edge.manilaDayWindow("2026-10-08")).toEqual({ from: "2026-10-07T16:00:00.000Z", to: "2026-10-08T16:00:00.000Z" });
    expect(edge.manilaToday(Date.parse("2026-10-08T15:30:00Z"))).toBe("2026-10-08"); // 23:30 Manila
  });
});

describe("backup files", () => {
  const data: BackupData = {
    orders: [{
      id: "o1", order_number: "T1-261008-0001", created_at: "2026-10-08T03:00:00Z", client_created_at: "2026-10-08T02:59:00Z", status: "completed",
      subtotal_centavos: 19000, discount_centavos: 0, discount_reason: null, total_centavos: 19000, refunded_centavos: 9500, payment_method: "cash",
      payment_status: "paid", qr_reference: null, cash_received_centavos: 20000, change_given_centavos: 1000, payment_verified_at: null,
      payment_photo_path: null, void_reason: null, voided_at: null, flags: [], shift_id: "s1", clock_offset_ms: 120, item_count: 2,
      events: { name: "Market" }, staff: { name: "Staff One" }, voided_by: null, device: { device_code: "T1" },
    }],
    lines: [{ id: "l1", transaction_id: "o1", position: 0, kind: "product", name_snapshot: "Butter Croissant", quantity: 2, unit_price_centavos: 9500, line_total_centavos: 19000 }],
    voids: [], refunds: [], shifts: [], drawer: [], audit: [],
  };

  it("writes one CSV per table with row counts and Manila ISO dates", () => {
    const files = buildBackupFiles(data);
    expect(files.map((f) => f.name)).toEqual([
      "orders.csv", "order_items.csv", "payments.csv", "refunds.csv", "voids.csv", "shifts.csv", "drawer_movements.csv", "audit_log.csv",
    ]);
    expect(Object.fromEntries(files.map((f) => [f.name, f.rows]))).toMatchObject({ "orders.csv": 1, "order_items.csv": 1, "refunds.csv": 0 });
    const orders = files[0].csv;
    expect(orders.startsWith("﻿client_order_id,order_number,server_time")).toBe(true);
    expect(orders).toContain("o1,T1-261008-0001,2026-10-08T11:00:00+08:00,2026-10-08T10:59:00+08:00,120,Market,T1,s1,Staff One,completed,2,190.00,0.00,,190.00,95.00,cash,paid,");
    expect(files[1].csv).toContain("o1,T1-261008-0001,l1,0,product,Butter Croissant,2,95.00,190.00");
    // Empty tables still get their header row.
    expect(files[3].csv.split("\r\n").filter(Boolean)).toHaveLength(1);
  });

  it("deletes folders only once they are older than the retention period", () => {
    expect(isExpired("2025-10-08", "2026-10-08", 365)).toBe(false);
    expect(isExpired("2025-10-07", "2026-10-08", 365)).toBe(true);
    expect(isExpired("2026-09-01", "2026-10-08", 30)).toBe(true);
  });
});
