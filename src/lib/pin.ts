import bcrypt from "bcryptjs";

export type PinStaff = { id: string; name: string; role: "owner" | "staff"; pin_hash: string };

/** Staff ordered with the most recently signed-in first (recentIds is newest first); the rest keep their order. */
export function orderByRecent<T extends { id: string }>(staff: readonly T[], recentIds: readonly string[]): T[] {
  const rank = new Map(recentIds.map((id, i) => [id, i]));
  return staff
    .map((member, i) => ({ member, key: rank.get(member.id) ?? recentIds.length + i }))
    .sort((a, b) => a.key - b.key)
    .map((x) => x.member);
}

/** recentIds with id moved to the front, capped. */
export function pushRecent(recentIds: readonly string[], id: string, max = 20): string[] {
  return [id, ...recentIds.filter((x) => x !== id)].slice(0, max);
}

/**
 * Finds the active staff member whose PIN matches. Runs entirely on the device
 * against the bcrypt hashes cached in the POS snapshot, so it works offline.
 * PINs are unique per business (enforced by set_staff_pin), so at most one matches.
 * Each check costs a bcrypt round, so recently signed-in staff (recentIds) are tried first.
 */
export async function findStaffByPin<T extends PinStaff>(pin: string, staff: readonly T[], recentIds: readonly string[] = []): Promise<T | null> {
  if (!/^\d{4}$/.test(pin)) return null;
  for (const member of orderByRecent(staff, recentIds)) {
    if (member.pin_hash && (await bcrypt.compare(pin, member.pin_hash))) return member;
  }
  return null;
}
