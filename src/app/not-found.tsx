import Link from "next/link";
import { Logo } from "@/components/ui";
import { ContactButton } from "@/components/ContactButton";

export default function NotFound() {
  return (
    <main id="main" className="flex min-h-dvh flex-col items-center justify-center gap-4 p-6 text-center">
      <Logo className="text-3xl text-caramel" />
      <p className="text-7xl font-black text-crust-dark" aria-hidden>404</p>
      <h1 className="text-2xl font-bold">This page crumbled</h1>
      <p className="max-w-md text-ink-soft">We couldn&apos;t find that page. The POS and your orders are fine.</p>
      <div className="flex flex-wrap justify-center gap-2">
        <Link href="/pos" className="btn-primary">Back to the POS</Link>
        <Link href="/help" className="btn-secondary">Help</Link>
      </div>
      <ContactButton page="404" />
    </main>
  );
}
