"use client";
import { useState } from "react";
import { formatPeso } from "@/lib/money";
import type { ItemState } from "@/lib/pos/cart";
import { tapFeedback } from "./feedback";

const statusLabel: Record<ItemState["status"], string | null> = {
  ok: null,
  low: "Low",
  sold_out: "Sold out",
  unavailable: "Unavailable",
  in_cart: "All in cart",
};

export function ItemCard({
  name, price, photoUrl, detail, state, stockLabel, inCart, onTap, accent = "caramel",
}: {
  name: string;
  price: number;
  photoUrl: string | null;
  detail?: string;
  state: ItemState;
  stockLabel: string;
  inCart: number;
  onTap: () => void;
  accent?: "caramel" | "ube";
}) {
  const [flash, setFlash] = useState(0);
  const disabled = !state.canAdd;
  const label = statusLabel[state.status];

  return (
    <button
      type="button"
      disabled={disabled}
      onClick={() => {
        tapFeedback();
        setFlash((f) => f + 1);
        onTap();
      }}
      aria-label={`${name}, ${formatPeso(price)}, ${stockLabel}${label ? `, ${label}` : ""}${inCart ? `, ${inCart} in cart` : ""}`}
      className={`relative flex min-h-36 flex-col overflow-hidden rounded-2xl border-2 bg-paper text-left transition-transform duration-75 select-none
        active:scale-[0.96] disabled:cursor-not-allowed
        ${disabled ? "border-crust-dark opacity-55 grayscale" : inCart ? (accent === "ube" ? "border-ube" : "border-caramel") : "border-crust-dark hover:border-caramel"}`}
    >
      {flash > 0 && <span key={flash} aria-hidden className="pointer-events-none absolute inset-0 animate-[tapflash_350ms_ease-out_forwards] bg-caramel/25" />}
      <div className="relative h-20 w-full shrink-0 bg-crust">
        {photoUrl ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img src={photoUrl} alt="" className="h-full w-full object-cover" />
        ) : (
          <span aria-hidden className={`flex h-full w-full items-center justify-center text-3xl font-black ${accent === "ube" ? "text-ube" : "text-caramel"}`}>
            {name.charAt(0)}
          </span>
        )}
        {inCart > 0 && (
          <span className={`absolute top-1.5 right-1.5 flex h-8 min-w-8 items-center justify-center rounded-full px-2 text-base font-black text-white ${accent === "ube" ? "bg-ube" : "bg-caramel"}`}>
            ×{inCart}
          </span>
        )}
        {label && (
          <span className={`absolute bottom-1.5 left-1.5 rounded-md px-2 py-0.5 text-xs font-black uppercase tracking-wide
            ${state.status === "low" ? "bg-warn-light text-warn" : state.status === "in_cart" ? "bg-paper text-ink" : "bg-ink text-white"}`}>
            {state.status === "low" ? "⚠ " : state.status === "sold_out" ? "✕ " : ""}{label}
          </span>
        )}
      </div>
      <div className="flex flex-1 flex-col gap-0.5 p-2.5">
        <span className="line-clamp-2 leading-tight font-bold">{name}</span>
        {detail && <span className="line-clamp-1 text-xs text-ink-soft">{detail}</span>}
        <span className="mt-auto flex items-end justify-between gap-2">
          <span className="text-lg font-black tabular-nums">{formatPeso(price, { trimZeros: true })}</span>
          <span className={`text-xs font-semibold ${state.status === "low" ? "text-warn" : "text-ink-soft"}`}>{stockLabel}</span>
        </span>
      </div>
    </button>
  );
}
