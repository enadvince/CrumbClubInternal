"use client";
import { useEffect, useState } from "react";
import { Modal } from "@/components/Modal";
import { formatPeso, pesos } from "@/lib/money";
import type { PaymentDetails, PaymentPhoto } from "@/lib/pos/types";
import { compressPhoto } from "@/lib/pos/photo";
import { tapFeedback } from "./feedback";

const QUICK = [100, 200, 500, 1000];
const KEYS = ["1", "2", "3", "4", "5", "6", "7", "8", "9", "00", "0", "back"] as const;

export function CheckoutModal({
  open, total, onClose, onComplete, checkQrDuplicate,
}: {
  open: boolean;
  total: number;
  onClose: () => void;
  onComplete: (payment: PaymentDetails) => Promise<void>;
  checkQrDuplicate: (ref: string) => Promise<boolean>;
}) {
  const [method, setMethod] = useState<"cash" | "qr_ph">("cash");
  const [received, setReceived] = useState<number | null>(null);
  const [typed, setTyped] = useState("");
  const [reference, setReference] = useState("");
  const [qrConfirmed, setQrConfirmed] = useState(false);
  const [duplicate, setDuplicate] = useState(false);
  const [photo, setPhoto] = useState<{ data: PaymentPhoto; url: string } | null>(null);
  const [photoBusy, setPhotoBusy] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (open) {
      setMethod("cash"); setReceived(null); setTyped(""); setReference(""); setQrConfirmed(false);
      setDuplicate(false); setBusy(false); setError(null);
      setPhoto((p) => { if (p) URL.revokeObjectURL(p.url); return null; });
    }
  }, [open]);

  async function takePhoto(file: File | undefined) {
    if (!file) return;
    setPhotoBusy(true);
    try {
      const data = await compressPhoto(file);
      const url = URL.createObjectURL(new Blob([data.bytes], { type: data.mime }));
      setPhoto((p) => { if (p) URL.revokeObjectURL(p.url); return { data, url }; });
    } catch (e) {
      setError(e instanceof Error ? e.message : "Couldn't use that photo");
    } finally {
      setPhotoBusy(false);
    }
  }

  useEffect(() => {
    let cancelled = false;
    const ref = reference.trim();
    if (!ref) { setDuplicate(false); return; }
    const t = setTimeout(async () => {
      const dup = await checkQrDuplicate(ref);
      if (!cancelled) setDuplicate(dup);
    }, 250);
    return () => { cancelled = true; clearTimeout(t); };
  }, [reference, checkQrDuplicate]);

  function key(k: (typeof KEYS)[number]) {
    tapFeedback();
    const next = k === "back" ? typed.slice(0, -1) : (typed + k).replace(/^0+(?=\d)/, "").slice(0, 6);
    setTyped(next);
    setReceived(next ? pesos(Number(next)) : null);
  }
  function quick(amount: number | "exact") {
    tapFeedback();
    setTyped("");
    setReceived(amount === "exact" ? total : pesos(amount));
  }

  const change = received != null ? received - total : null;
  const cashOk = received != null && received >= total;
  const qrOk = reference.trim().length > 0 && qrConfirmed;

  async function complete() {
    setBusy(true);
    setError(null);
    try {
      await onComplete(method === "cash"
        ? { method: "cash", cashReceived: received! }
        : { method: "qr_ph", reference: reference.trim(), photo: photo?.data ?? null });
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not save the sale");
      setBusy(false);
    }
  }

  return (
    <Modal open={open} onClose={busy ? () => {} : onClose} title="Checkout" wide>
      <div className="space-y-4">
        <div className="flex items-end justify-between">
          <span className="text-lg font-bold">Total due</span>
          <span className="text-4xl font-black tabular-nums">{formatPeso(total)}</span>
        </div>

        <div className="grid grid-cols-2 gap-3" role="radiogroup" aria-label="Payment method">
          {([["cash", "💵 Cash"], ["qr_ph", "📱 QR Ph (GCash)"]] as const).map(([m, label]) => (
            <button
              key={m}
              role="radio"
              aria-checked={method === m}
              onClick={() => { tapFeedback(); setMethod(m); }}
              className={`btn h-16 border-2 text-lg ${method === m ? "border-caramel bg-caramel text-white" : "border-crust-dark bg-paper text-ink"}`}
            >
              {method === m ? "● " : "○ "}{label}
            </button>
          ))}
        </div>

        {method === "cash" ? (
          <div className="grid gap-4 md:grid-cols-2">
            <div className="space-y-3">
              <div className="rounded-xl bg-cream p-3">
                <p className="text-sm text-ink-soft">Cash received</p>
                <p className="text-3xl font-black tabular-nums" aria-live="polite">{received == null ? "-" : formatPeso(received)}</p>
              </div>
              <div className="grid grid-cols-3 gap-2">
                <button className="btn-secondary h-14 text-lg" onClick={() => quick("exact")}>Exact</button>
                {QUICK.map((q) => (
                  <button key={q} className="btn-secondary h-14 text-lg" onClick={() => quick(q)}>₱{q.toLocaleString("en-PH")}</button>
                ))}
              </div>
              <div className={`rounded-xl p-3 ${change == null ? "bg-cream" : change < 0 ? "bg-danger-light text-danger" : "bg-ok-light text-ok"}`} aria-live="polite">
                <p className="text-sm font-semibold">{change != null && change < 0 ? "⚠ Not enough cash. Short by" : "Change due"}</p>
                <p className="text-4xl font-black tabular-nums">{change == null ? "-" : formatPeso(Math.abs(change))}</p>
              </div>
            </div>
            <div className="grid grid-cols-3 gap-2">
              {KEYS.map((k) => (
                <button key={k} className="btn h-14 border-2 border-crust-dark bg-paper text-xl text-ink" onClick={() => key(k)} aria-label={k === "back" ? "Delete digit" : `${k}`}>
                  {k === "back" ? "⌫" : k}
                </button>
              ))}
              <p className="col-span-3 text-center text-xs text-ink-soft">Keypad enters whole pesos</p>
            </div>
          </div>
        ) : (
          <div className="space-y-3">
            <ol className="list-decimal space-y-1 rounded-xl bg-cream p-3 pl-8 text-sm">
              <li>Customer scans the Crumb Club QR Ph code and pays <strong>{formatPeso(total)}</strong>.</li>
              <li>Check the <strong>GCash merchant notification</strong> shows the payment received.</li>
              <li>Enter the reference number from that notification.</li>
            </ol>
            <label className="block">
              <span className="label">Reference number (required)</span>
              <input
                className="input h-16 text-2xl tracking-wider"
                inputMode="numeric"
                autoComplete="off"
                value={reference}
                onChange={(e) => setReference(e.target.value.replace(/\s/g, ""))}
                placeholder="e.g. 5012345678901"
              />
            </label>
            {duplicate && (
              <p role="alert" className="rounded-xl border border-warn/40 bg-warn-light p-3 font-semibold text-warn">
                ⚠ This reference number was already used for another sale. Double-check the GCash notification before continuing.
              </p>
            )}
            <label className="flex min-h-14 items-center gap-3 rounded-xl border-2 border-crust-dark px-3">
              <input type="checkbox" className="h-6 w-6 accent-caramel" checked={qrConfirmed} onChange={(e) => setQrConfirmed(e.target.checked)} />
              <span className="font-semibold">I saw the payment of {formatPeso(total)} in the GCash merchant notification</span>
            </label>
            <div className="flex flex-wrap items-center gap-3 rounded-xl bg-cream p-3">
              {photo ? (
                // eslint-disable-next-line @next/next/no-img-element
                <img src={photo.url} alt="Payment confirmation photo" className="h-16 w-16 rounded-lg object-cover" />
              ) : null}
              <label className="btn-secondary min-h-12 cursor-pointer">
                <input type="file" accept="image/*" capture="environment" className="sr-only" onChange={(e) => { void takePhoto(e.target.files?.[0]); e.target.value = ""; }} />
                {photoBusy ? "Processing..." : photo ? "📷 Retake photo" : "📷 Photo of payment (optional)"}
              </label>
              {photo && <button className="btn-ghost min-h-12" onClick={() => setPhoto((p) => { if (p) URL.revokeObjectURL(p.url); return null; })}>Remove</button>}
              <p className="w-full text-xs text-ink-soft">QR payments are saved as awaiting verification. An owner confirms them against the GCash history.</p>
            </div>
          </div>
        )}

        {error && <p role="alert" className="font-semibold text-danger">✕ {error}</p>}
        <button
          className="btn-primary h-16 w-full text-xl"
          disabled={busy || (method === "cash" ? !cashOk : !qrOk)}
          onClick={complete}
        >
          {busy ? "Saving…" : method === "cash" && change != null && change > 0 ? `Complete sale · give ${formatPeso(change)} change` : "Complete sale"}
        </button>
      </div>
    </Modal>
  );
}
