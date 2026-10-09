/** Shared by the Audit log page and the exports. */
export type AuditRow = {
  id: string;
  action: string;
  transaction_id: string | null;
  order_number: string | null;
  amount_centavos: number | null;
  reason: string | null;
  note: string | null;
  items: unknown;
  device_time: string | null;
  server_time: string;
  cashier: { name: string } | null;
  manager: { name: string } | null;
  device: { device_code: string; label: string | null } | null;
};

export const AUDIT_SELECT =
  "id, action, transaction_id, order_number, amount_centavos, reason, note, items, device_time, server_time, " +
  "cashier:staff!audit_log_cashier_staff_id_fkey(name), manager:staff!audit_log_manager_staff_id_fkey(name), device:pos_devices(device_code, label)";

export const AUDIT_ACTION_LABEL: Record<string, string> = {
  void: "Void", void_line: "Item void", refund: "Refund", pin_override: "Owner PIN override", cash_in: "Cash in",
  cash_out: "Cash out", shift_close_variance: "Shift closed over variance", reports_access: "Opened reports",
  export: "Export", emergency_export: "Emergency export", device_register: "Tablet registered",
  pin_lockout: "Owner PIN locked out", payment_verified: "Payment verified",
};

