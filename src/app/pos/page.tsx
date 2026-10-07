"use client";
import dynamic from "next/dynamic";
import { Spinner } from "@/components/ui";

// IndexedDB and the sync engine only exist in the browser.
const PosApp = dynamic(() => import("@/components/pos/PosApp").then((m) => m.PosApp), {
  ssr: false,
  loading: () => <main className="flex min-h-dvh items-center justify-center"><Spinner label="Starting POS" /></main>,
});

export default function PosPage() {
  return <PosApp />;
}
