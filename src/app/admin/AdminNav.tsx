"use client";
import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { getSupabase } from "@/lib/supabase/client";
import { Logo } from "@/components/ui";

const links = [
  { href: "/admin/dashboard", label: "Dashboard", icon: "📊" },
  { href: "/admin/events", label: "Events", icon: "📅" },
  { href: "/admin/transactions", label: "Transactions", icon: "🧾" },
  { href: "/admin/products", label: "Products", icon: "🥐" },
  { href: "/admin/bundles", label: "Bundles", icon: "📦" },
  { href: "/admin/staff", label: "Staff", icon: "👥" },
];

export function AdminNav({ businessName, email }: { businessName: string; email: string }) {
  const pathname = usePathname();
  const router = useRouter();

  async function signOut() {
    await getSupabase().auth.signOut();
    router.replace("/login");
    router.refresh();
  }

  return (
    <nav aria-label="Owner" className="no-print border-b border-crust-dark bg-paper lg:sticky lg:top-0 lg:h-dvh lg:w-60 lg:shrink-0 lg:border-r lg:border-b-0">
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
                className={`flex min-h-11 items-center gap-2 whitespace-nowrap rounded-xl px-3 font-semibold ${
                  active ? "bg-caramel text-white" : "text-ink hover:bg-crust"
                }`}
              >
                <span aria-hidden>{l.icon}</span>
                {l.label}
              </Link>
            </li>
          );
        })}
      </ul>
      <div className="hidden space-y-2 px-4 pt-4 lg:block">
        <Link href="/pos/pair" className="btn-secondary w-full text-sm">Set up POS tablet</Link>
        <p className="truncate text-xs text-ink-soft" title={email}>{email}</p>
        <button onClick={signOut} className="btn-ghost w-full text-sm">Sign out</button>
      </div>
      <div className="flex gap-2 px-2 pb-2 lg:hidden">
        <Link href="/pos/pair" className="btn-secondary flex-1 text-sm">Set up POS tablet</Link>
        <button onClick={signOut} className="btn-ghost text-sm">Sign out</button>
      </div>
    </nav>
  );
}
