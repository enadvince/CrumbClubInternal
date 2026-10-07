import bcrypt from "bcryptjs";

export type PinStaff = { id: string; name: string; role: "owner" | "staff"; pin_hash: string };

/**
 * Finds the active staff member whose PIN matches. Runs entirely on the device
 * against the bcrypt hashes cached in the POS snapshot, so it works offline.
 * PINs are unique per business (enforced by set_staff_pin), so at most one matches.
 */
export async function findStaffByPin<T extends PinStaff>(pin: string, staff: readonly T[]): Promise<T | null> {
  if (!/^\d{4}$/.test(pin)) return null;
  for (const member of staff) {
    if (member.pin_hash && (await bcrypt.compare(pin, member.pin_hash))) return member;
  }
  return null;
}
