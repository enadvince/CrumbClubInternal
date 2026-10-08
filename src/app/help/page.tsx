import type { Metadata } from "next";
import { ContactButton } from "@/components/ContactButton";
import { ScrollProgress } from "@/components/ScrollAids";
import Link from "next/link";
import { Logo } from "@/components/ui";
import { formatDate } from "@/lib/time";

export const metadata: Metadata = { title: "Help | Crumb Club POS", description: "How the Crumb Club POS works offline and what to do when something doesn't sync." };

/** Bump when the content below changes. Shown as "Last updated". */
const LAST_UPDATED = "2026-10-08";

const FAQ: { q: string; a: React.ReactNode }[] = [
  {
    q: "Can I keep selling when the Wi-Fi drops?",
    a: (
      <>
        Yes. Every order is saved on the tablet first and uploaded in the background. The status pill at the top shows
        <strong> Offline: orders saved on this device</strong>. Keep selling as normal. Cash and QR Ph both work offline.
      </>
    ),
  },
  {
    q: "What do the colours of the status pill mean?",
    a: (
      <ul className="list-disc space-y-1 pl-5">
        <li><strong>Green, All synced:</strong> everything is on the server.</li>
        <li><strong>Amber, 3 orders pending sync:</strong> saved on the tablet, waiting to upload.</li>
        <li><strong>Blue, Syncing:</strong> uploading right now.</li>
        <li><strong>Grey, Offline:</strong> no connection. Orders are safe on the tablet.</li>
        <li><strong>Red, orders need attention:</strong> the server rejected something. See below.</li>
      </ul>
    ),
  },
  {
    q: "How do order numbers work?",
    a: (
      <>
        Each tablet has a short code (T1, T2 and so on). Order numbers look like <strong>T1-261008-0042</strong>: tablet, date
        (YYMMDD) and a counter that restarts at midnight. Call out the last three digits (042). Two tablets can never
        produce the same number, even offline.
      </>
    ),
  },
  {
    q: "An order says it needs attention. What do I do?",
    a: (
      <ol className="list-decimal space-y-1 pl-5">
        <li>Tap the red pill to open the sync panel. Each problem shows the order number and the reason.</li>
        <li>If the reason looks temporary, tap <strong>Retry now</strong>.</li>
        <li>If it keeps failing, don&apos;t clear the browser or reset the tablet. Ask an owner to download an
          <strong> Emergency export</strong> from the owner menu and contact support.</li>
      </ol>
    ),
  },
  {
    q: "Can I close my shift while offline?",
    a: (
      <>
        Yes. The shift report is marked <strong>Provisional</strong> until every order from the shift has synced, then it
        becomes final automatically. Count the drawer first: the expected amount only shows after you enter your count.
      </>
    ),
  },
  {
    q: "Why can't I update the app?",
    a: (
      <>
        Updates wait until the cart is empty and every order has synced, so nothing is lost mid-sale. Finish the sale,
        connect to the internet, wait for <strong>All synced</strong>, then tap <strong>Update now</strong>.
      </>
    ),
  },
  {
    q: "What must I never do with the tablet?",
    a: (
      <ul className="list-disc space-y-1 pl-5">
        <li>Clear the browser data or uninstall the app while orders are pending.</li>
        <li>Let it run out of battery with unsynced orders. Plug it in.</li>
        <li>Change the tablet&apos;s date or time. The server keeps its own clock, but staff reports read easier with the right time.</li>
      </ul>
    ),
  },
];

export default function HelpPage() {
  return (
    <main id="main" className="mx-auto max-w-3xl space-y-6 px-4 py-8">
      <ScrollProgress />
      <header className="space-y-2">
        <Logo className="text-2xl text-caramel" />
        <h1 className="text-3xl font-bold">Help</h1>
        <p className="text-ink-soft">How the POS works offline, how syncing works, and what to do when an order fails.</p>
        <p className="text-sm text-ink-soft">Last updated: <time dateTime={LAST_UPDATED}>{formatDate(LAST_UPDATED)}</time></p>
      </header>
      <section aria-labelledby="faq-h" className="space-y-3">
        <h2 id="faq-h" className="text-xl font-bold">Frequently asked questions</h2>
        {FAQ.map((item) => (
          <details key={item.q} className="card group p-0">
            <summary className="flex min-h-14 cursor-pointer list-none items-center justify-between gap-3 rounded-2xl px-4 py-3 font-semibold hover:bg-crust active:bg-crust-dark">
              {item.q}
              <span aria-hidden className="transition-transform group-open:rotate-180 motion-reduce:transition-none">▾</span>
            </summary>
            <div className="px-4 pb-4 text-ink">{item.a}</div>
          </details>
        ))}
      </section>
      <div className="flex flex-wrap gap-2">
        <Link href="/pos" className="btn-primary">Back to the POS</Link>
      </div>
      <ContactButton page="help" />
    </main>
  );
}
