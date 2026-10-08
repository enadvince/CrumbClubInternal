import type { Metadata } from "next";
import Link from "next/link";
import { Logo } from "@/components/ui";

export const metadata: Metadata = { title: "Offline | Crumb Club POS" };

/** Shown by the service worker for any page that isn't available offline. */
export default function OfflinePage() {
  return (
    <main id="main" className="flex min-h-dvh flex-col items-center justify-center gap-4 p-6 text-center">
      <Logo className="text-3xl text-caramel" />
      <h1 className="text-2xl font-bold">You&apos;re offline</h1>
      <p className="max-w-md text-ink-soft">
        This page needs the internet. The POS works without it: sales are saved on the tablet and sync when the connection is back.
      </p>
      <div className="flex flex-wrap justify-center gap-2">
        <Link href="/pos" className="btn-primary">Open the POS</Link>
        <Link href="/help" className="btn-secondary">Help</Link>
      </div>
    </main>
  );
}
