"use client";
import { useState } from "react";
import { formatPeso } from "@/lib/money";
import type { ItemState } from "@/lib/pos/cart";
import { tapFeedback } from "./feedback";

/** Badge on the tile: amber "Low: 3 left", red "Out of stock", grey "Unavailable". */
export function stockBadge(state: ItemState): { text: string; tone: "low" | "out" | "unavailable" } | null {
  if (state.status === "low") return { text: `Low: ${state.remaining} left`, tone: "low" };
  if (state.status === "out") return { text: "Out of stock", tone: "out" };
  if (state.status === "unavailable") return { text: "Unavailable", tone: "unavailable" };
  return null;
}

const BADGE_CLASS = { low: "bg-warn-light text-warn", out: "bg-danger text-white", unavailable: "bg-ink text-paper" } as const;

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
  const badge = stockBadge(state);

  return (
    <button
      type="button"
      disabled={disabled}
      onClick={() => {
        tapFeedback();
        setFlash((f) => f + 1);
        onTap();
      }}
      aria-label={`${name}, ${formatPeso(price)}${stockLabel ? `, ${stockLabel}` : ""}${badge ? `, ${badge.text}` : ""}${inCart ? `, ${inCart} in cart` : ""}`}
      className={`relative flex min-h-36 flex-col overflow-hidden rounded-2xl border-2 bg-paper text-left transition-transform duration-75 select-none
        active:scale-[0.96] disabled:cursor-not-allowed
        ${disabled ? "border-crust-dark opacity-55 grayscale" : state.status === "out" ? "border-danger/60 hover:border-danger" : inCart ? (accent === "ube" ? "border-ube" : "border-caramel") : "border-crust-dark hover:border-caramel"}`}
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
        {badge && (
          <span data-testid="stock-badge" className={`absolute bottom-1.5 left-1.5 rounded-md px-2 py-0.5 text-xs font-black tracking-wide ${BADGE_CLASS[badge.tone]}`}>
            {badge.tone === "low" ? "⚠ " : "✕ "}{badge.text}
          </span>
        )}
      </div>
      <div className="flex flex-1 flex-col gap-0.5 p-2.5">
        <span className="line-clamp-2 leading-tight font-bold">{name}</span>
        {detail && <span className="line-clamp-1 text-xs text-ink-soft">{detail}</span>}
        <span className="mt-auto flex items-end justify-between gap-2">
          <span className="text-lg font-black tabular-nums">{formatPeso(price, { trimZeros: true })}</span>
          <span className={`text-xs font-semibold ${state.status === "low" ? "text-warn" : state.status === "out" ? "text-danger" : "text-ink-soft"}`}>{stockLabel}</span>
        </span>
      </div>
    </button>
  );
}
