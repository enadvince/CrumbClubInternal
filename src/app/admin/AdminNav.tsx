"use client";
import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { getSupabase } from "@/lib/supabase/client";
import { Logo } from "@/components/ui";
import { isTabletOwnerView, OWNER_VIEW_IDLE_MS, restoreDeviceSession } from "@/lib/ownerView";

const links = [
  { href: "/admin/dashboard", label: "Dashboard", icon: "📊" },
  { href: "/admin/events", label: "Events", icon: "📅" },
  { href: "/admin/transactions", label: "Transactions", icon: "🧾" },
  { href: "/admin/products", label: "Products", icon: "🥐" },
  { href: "/admin/bundles", label: "Bundles", icon: "📦" },
  { href: "/admin/discounts", label: "Discounts", icon: "🏷️" },
  { href: "/admin/personnel", label: "Personnel", icon: "👥" },
  { href: "/admin/pin-log", label: "PIN log", icon: "🔑" },
];

export function AdminNav({ businessName, email }: { businessName: string; email: string }) {
  const pathname = usePathname();
  const router = useRouter();
  // Owner view opened from the POS tablet with an owner PIN.
  const [onTablet, setOnTablet] = useState(false);

  useEffect(() => {
    isTabletOwnerView().then(setOnTablet).catch(() => {});
  }, []);

  const backToPos = useCallback(async () => {
    await restoreDeviceSession().catch(() => false);
    // The POS retries the restore on load if it didn't finish here (e.g. offline).
    window.location.href = "/pos";
  }, []);

  // Don't leave the owner signed in on a shared tablet: go back to the POS when idle.
  useEffect(() => {
    if (!onTablet) return;
    let timer = setTimeout(backToPos, OWNER_VIEW_IDLE_MS);
    const reset = () => { clearTimeout(timer); timer = setTimeout(backToPos, OWNER_VIEW_IDLE_MS); };
    const events = ["pointerdown", "keydown", "scroll"] as const;
    for (const e of events) window.addEventListener(e, reset, { passive: true });
    return () => {
      clearTimeout(timer);
      for (const e of events) window.removeEventListener(e, reset);
    };
  }, [onTablet, backToPos]);

  async function signOut() {
    await getSupabase().auth.signOut();
    router.replace("/login");
    router.refresh();
  }

  return (
    <nav aria-label="Owner" className="no-print border-b border-crust bg-paper lg:sticky lg:top-0 lg:h-dvh lg:w-60 lg:shrink-0 lg:overflow-y-auto lg:border-r lg:border-b-0">
      <div className="flex items-center justify-between px-4 py-3 lg:block lg:py-5">
        <div>
          <Logo className="text-xl text-caramel" />
          <p className="text-xs text-ink-soft">{businessName}</p>
        </div>
      </div>
      <ul className="flex gap-1 overflow-x-auto px-2 pb-2 lg:flex-col lg:overflow-visible">
        {links.map((l) => {
          const active = pathname.startsWith(l.href);
          return (
            <li key={l.href}>
              <Link
                href={l.href}
                aria-current={active ? "page" : undefined}
                className={`relative flex min-h-11 items-center gap-2 whitespace-nowrap rounded-xl px-3 font-semibold transition-colors ${
                  active
                    ? "bg-crust text-caramel-dark before:absolute before:inset-x-3 before:bottom-0 before:h-0.5 before:rounded-full before:bg-caramel lg:before:inset-x-auto lg:before:inset-y-2 lg:before:left-0 lg:before:h-auto lg:before:w-1"
                    : "text-ink-soft hover:bg-cream hover:text-ink"
                }`}
              >
                <span aria-hidden>{l.icon}</span>
                {l.label}
              </Link>
            </li>
          );
        })}
      </ul>
      {onTablet && (
        <div className="mx-2 mb-2 rounded-xl bg-ube-light p-3 text-sm text-ube lg:mx-4">
          <p className="font-semibold">Owner view on the POS tablet</p>
          <p className="mb-2">Returns to the POS after 5 minutes without a tap.</p>
          <button onClick={backToPos} className="btn-primary w-full">← Back to POS</button>
        </div>
      )}
      {!onTablet && (<>
      <div className="hidden space-y-2 px-4 pt-4 lg:block">
        <Link href="/pos/pair" className="btn-secondary w-full text-sm">Set up POS tablet</Link>
        <p className="truncate text-xs text-ink-soft" title={email}>{email}</p>
        <button onClick={signOut} className="btn-ghost w-full text-sm">Sign out</button>
      </div>
      <div className="flex gap-2 px-2 pb-2 lg:hidden">
        <Link href="/pos/pair" className="btn-secondary flex-1 text-sm">Set up POS tablet</Link>
        <button onClick={signOut} className="btn-ghost text-sm">Sign out</button>
      </div>
      </>)}
    </nav>
  );
}
