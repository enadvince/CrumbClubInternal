/** Reasons picked when voiding or refunding. Must match void_order() on the server. */
export type VoidReasonCode = "wrong_item" | "changed_mind" | "duplicate" | "other";

export const VOID_REASONS: { code: VoidReasonCode; label: string }[] = [
  { code: "wrong_item", label: "Wrong item" },
  { code: "changed_mind", label: "Customer changed mind" },
  { code: "duplicate", label: "Duplicate" },
  { code: "other", label: "Other" },
];
