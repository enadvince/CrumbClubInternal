"use client";
import { useEffect, useState } from "react";
import { Modal } from "@/components/Modal";
import { MoneyInput } from "@/components/MoneyInput";
import { formatPeso, parsePercent } from "@/lib/money";
import { discountAmount } from "@/lib/pos/cart";
import type { Discount, DiscountOption } from "@/lib/pos/types";

const REASONS = ["Friends & family", "Promo", "Damaged item", "Loyal customer", "Staff purchase"];

/** Short label for a preset: "20% off" or "₱50.00 off". */
export function describeDiscountOption(o: Pick<DiscountOption, "type" | "value">): string {
  return o.type === "percent" ? `${o.value / 100}% off` : `${formatPeso(o.value)} off`;
}

export function DiscountModal({ open, subtotal, options = [], onClose, onApply }: {
  open: boolean; subtotal: number; options?: DiscountOption[]; onClose: () => void; onApply: (d: Discount) => void;
}) {
  const [type, setType] = useState<"fixed" | "percent">("percent");
  const [fixed, setFixed] = useState<number | null>(null);
  const [percentText, setPercentText] = useState("10");
  const [reason, setReason] = useState("");

  useEffect(() => {
    if (open) { setType("percent"); setFixed(null); setPercentText("10"); setReason(""); }
  }, [open]);

  const bp = parsePercent(percentText);
  const discount: Discount | null =
    type === "fixed" ? (fixed != null && fixed > 0 ? { type, value: fixed, reason } : null)
      : bp != null && bp > 0 ? { type, value: bp, reason } : null;
  const amount = discountAmount(subtotal, discount);
  const valid = discount && reason.trim().length > 0;

  return (
    <Modal open={open} onClose={onClose} title="Add discount">
      <div className="space-y-4">
        {options.length > 0 && (
          <div>
            <span className="label">Discount options</span>
            <div className="grid grid-cols-2 gap-2">
              {options.map((o) => {
                const preset: Discount = { type: o.type, value: o.value, reason: o.name } as Discount;
                return (
                  <button key={o.id} type="button" onClick={() => onApply(preset)}
                    className="btn min-h-16 flex-col border-2 border-ube bg-ube-light text-ube">
                    <span className="font-bold">{o.name}</span>
                    <span className="text-sm">{describeDiscountOption(o)} · −{formatPeso(discountAmount(subtotal, preset))}</span>
                  </button>
                );
              })}
            </div>
            <p className="mt-3 text-sm font-semibold text-ink-soft">Or enter a custom discount:</p>
          </div>
        )}
        <div className="grid grid-cols-2 gap-2" role="radiogroup" aria-label="Discount type">
          {([["percent", "% off"], ["fixed", "₱ off"]] as const).map(([t, label]) => (
            <button key={t} role="radio" aria-checked={type === t} onClick={() => setType(t)}
              className={`btn h-14 border-2 ${type === t ? "border-caramel bg-crust" : "border-crust-dark bg-paper"}`}>
              {type === t ? "● " : "○ "}{label}
            </button>
          ))}
        </div>
        {type === "percent" ? (
          <label className="block">
            <span className="label">Percent</span>
            <input className="input h-14 text-2xl" inputMode="decimal" value={percentText} onChange={(e) => setPercentText(e.target.value)} />
          </label>
        ) : (
          <div>
            <span className="label">Amount</span>
            <MoneyInput id="disc-fixed" value={fixed} onChange={setFixed} />
          </div>
        )}
        <div>
          <span className="label">Reason (required)</span>
          <div className="mb-2 flex flex-wrap gap-2">
            {REASONS.map((r) => (
              <button key={r} type="button" onClick={() => setReason(r)}
                className={`btn min-h-11 border-2 text-sm ${reason === r ? "border-caramel bg-crust" : "border-crust-dark bg-paper"}`}>{r}</button>
            ))}
          </div>
          <input className="input" aria-label="Discount reason" placeholder="Or type a reason" value={reason} onChange={(e) => setReason(e.target.value)} />
        </div>
        <p className="text-lg font-bold">Discount: −{formatPeso(amount)} · New total {formatPeso(subtotal - amount)}</p>
        <button className="btn-primary h-14 w-full" disabled={!valid} onClick={() => discount && onApply({ ...discount, reason: reason.trim() })}>
          Apply discount
        </button>
      </div>
    </Modal>
  );
}
