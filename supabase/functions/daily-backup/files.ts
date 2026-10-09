import { csvDate, csvMoney, toCsv } from "./csv.ts";

// Row shapes as selected by index.ts (joins already resolved to names).
type Named = { name: string } | null;
export type OrderRow = {
  id: string; order_number: string; created_at: string; client_created_at: string; status: string; subtotal_centavos: number;
  discount_centavos: number; discount_reason: string | null; total_centavos: number; refunded_centavos: number; payment_method: string;
  payment_status: string; qr_reference: string | null; cash_received_centavos: number | null; change_given_centavos: number | null;
  payment_verified_at: string | null; payment_photo_path: string | null; void_reason: string | null; voided_at: string | null;
  flags: string[]; shift_id: string | null; clock_offset_ms: number | null; item_count: number;
  events: Named; staff: Named; voided_by: Named; device: { device_code: string } | null;
};
export type LineRow = { id: string; transaction_id: string; position: number; kind: string; name_snapshot: string; quantity: number; unit_price_centavos: number; line_total_centavos: number };
export type RefundRow = {
  id: string; transaction_id: string; kind: string; method: string; amount_centavos: number; reason_code: string; note: string | null;
  shift_id: string | null; created_at_device: string; created_at: string; staff: Named; approver: Named;
  order: { order_number: string } | null; refund_lines: { transaction_line_id: string; quantity: number; amount_centavos: number }[];
};
export type ShiftRow = {
  id: string; status: string; opened_at: string; closed_at: string | null; opening_float_centavos: number; counted_cash_centavos: number | null;
  expected_cash_centavos: number | null; expected_cash_device_centavos: number | null; variance_centavos: number | null; variance_note: string | null;
  close_note: string | null; created_at: string; device: { device_code: string } | null; opener: Named; closer: Named; approver: Named; events: Named;
};
export type DrawerRow = { id: string; shift_id: string; kind: string; amount_centavos: number; reason: string; created_at_device: string; created_at: string; staff: Named; approver: Named };
export type AuditRow = {
  id: string; action: string; order_number: string | null; transaction_id: string | null; refund_id: string | null; shift_id: string | null;
  amount_centavos: number | null; reason: string | null; note: string | null; items: unknown; device_time: string | null; server_time: string;
  cashier: Named; manager: Named; device: { device_code: string } | null;
};

export type BackupData = {
  orders: OrderRow[]; lines: LineRow[]; voids: OrderRow[]; refunds: RefundRow[]; shifts: ShiftRow[]; drawer: DrawerRow[]; audit: AuditRow[];
};
export type BackupFile = { name: string; csv: string; rows: number };

/** Every CSV for one business and one day. Pure, so it is unit-tested outside Deno. */
export function buildBackupFiles(d: BackupData): BackupFile[] {
  const orderNo = new Map(d.orders.map((o) => [o.id, o.order_number]));
  const file = (name: string, headers: string[], rows: unknown[][]): BackupFile => ({ name, csv: toCsv(headers, rows), rows: rows.length });
  return [
    file("orders.csv",
      ["client_order_id", "order_number", "server_time", "device_time", "clock_offset_ms", "event", "device", "shift_id", "cashier", "status",
        "items", "subtotal", "discount", "discount_reason", "total", "refunded", "payment_method", "payment_status", "flags"],
      d.orders.map((o) => [o.id, o.order_number, csvDate(o.created_at), csvDate(o.client_created_at), o.clock_offset_ms ?? "", o.events?.name ?? "",
        o.device?.device_code ?? "", o.shift_id ?? "", o.staff?.name ?? "", o.status, o.item_count, csvMoney(o.subtotal_centavos),
        csvMoney(o.discount_centavos), o.discount_reason ?? "", csvMoney(o.total_centavos), csvMoney(o.refunded_centavos),
        o.payment_method, o.payment_status, (o.flags ?? []).join(" ")])),
    file("order_items.csv",
      ["client_order_id", "order_number", "line_id", "position", "kind", "name", "quantity", "unit_price", "line_total"],
      d.lines.map((l) => [l.transaction_id, orderNo.get(l.transaction_id) ?? "", l.id, l.position, l.kind, l.name_snapshot, l.quantity,
        csvMoney(l.unit_price_centavos), csvMoney(l.line_total_centavos)])),
    file("payments.csv",
      ["client_order_id", "order_number", "method", "status", "total", "cash_received", "change_given", "qr_reference", "verified_at", "photo_path"],
      d.orders.map((o) => [o.id, o.order_number, o.payment_method, o.payment_status, csvMoney(o.total_centavos), csvMoney(o.cash_received_centavos),
        csvMoney(o.change_given_centavos), o.qr_reference ?? "", csvDate(o.payment_verified_at), o.payment_photo_path ?? ""])),
    file("refunds.csv",
      ["refund_id", "order_number", "kind", "method", "amount", "reason", "note", "items", "cashier", "approved_by", "shift_id", "device_time", "server_time"],
      d.refunds.map((r) => [r.id, r.order?.order_number ?? "", r.kind, r.method, csvMoney(r.amount_centavos), r.reason_code, r.note ?? "",
        r.refund_lines.map((l) => `${l.quantity}x ${l.transaction_line_id} ${csvMoney(l.amount_centavos)}`).join("; "),
        r.staff?.name ?? "", r.approver?.name ?? "", r.shift_id ?? "", csvDate(r.created_at_device), csvDate(r.created_at)])),
    file("voids.csv",
      ["client_order_id", "order_number", "voided_at", "reason", "voided_by", "total"],
      d.voids.map((o) => [o.id, o.order_number, csvDate(o.voided_at), o.void_reason ?? "", o.voided_by?.name ?? "", csvMoney(o.total_centavos)])),
    file("shifts.csv",
      ["shift_id", "device", "event", "status", "opened_at", "opened_by", "opening_float", "closed_at", "closed_by", "expected_cash",
        "expected_cash_on_tablet", "counted_cash", "variance", "variance_note", "approved_by", "note"],
      d.shifts.map((s) => [s.id, s.device?.device_code ?? "", s.events?.name ?? "", s.status, csvDate(s.opened_at), s.opener?.name ?? "",
        csvMoney(s.opening_float_centavos), csvDate(s.closed_at), s.closer?.name ?? "", csvMoney(s.expected_cash_centavos),
        csvMoney(s.expected_cash_device_centavos), csvMoney(s.counted_cash_centavos), csvMoney(s.variance_centavos), s.variance_note ?? "",
        s.approver?.name ?? "", s.close_note ?? ""])),
    file("drawer_movements.csv",
      ["movement_id", "shift_id", "kind", "amount", "reason", "staff", "approved_by", "device_time", "server_time"],
      d.drawer.map((m) => [m.id, m.shift_id, m.kind, csvMoney(m.amount_centavos), m.reason, m.staff?.name ?? "", m.approver?.name ?? "",
        csvDate(m.created_at_device), csvDate(m.created_at)])),
    file("audit_log.csv",
      ["audit_id", "action", "order_number", "amount", "reason", "note", "cashier", "approved_by", "device", "shift_id", "refund_id", "items",
        "device_time", "server_time"],
      d.audit.map((a) => [a.id, a.action, a.order_number ?? "", csvMoney(a.amount_centavos), a.reason ?? "", a.note ?? "", a.cashier?.name ?? "",
        a.manager?.name ?? "", a.device?.device_code ?? "", a.shift_id ?? "", a.refund_id ?? "", a.items ? JSON.stringify(a.items) : "",
        csvDate(a.device_time), csvDate(a.server_time)])),
  ];
}

/** YYYY/MM/DD folders older than the retention period (date < today - retentionDays). */
export function isExpired(folderDate: string, today: string, retentionDays: number): boolean {
  const age = (Date.parse(`${today}T00:00:00Z`) - Date.parse(`${folderDate}T00:00:00Z`)) / 86_400_000;
  return age > retentionDays;
}
