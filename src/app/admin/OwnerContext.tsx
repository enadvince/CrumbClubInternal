"use client";
import { createContext, useContext } from "react";

export type OwnerContextValue = { businessId: string; businessName: string; userId: string };
const Ctx = createContext<OwnerContextValue | null>(null);

export function OwnerProvider({ value, children }: { value: OwnerContextValue; children: React.ReactNode }) {
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function useOwner(): OwnerContextValue {
  const v = useContext(Ctx);
  if (!v) throw new Error("useOwner must be used inside the admin layout");
  return v;
}
