export const dynamic = "force-dynamic";

import { redirect } from "next/navigation";
import { getSessionContext } from "@/lib/supabase/server";
import { Logo, Notice } from "@/components/ui";
import { AdminNav } from "./AdminNav";
import { OwnerProvider } from "./OwnerContext";

export default async function AdminLayout({ children }: { children: React.ReactNode }) {
  const { supabase, user, membership } = await getSessionContext();
  if (!user) redirect("/login?next=/admin/dashboard");
  if (!membership) redirect("/setup");
  if (membership.role !== "owner") redirect("/pos");
  // A deactivated co-owner keeps their login but has no owner access.
  const { data: isOwner } = await supabase.rpc("is_owner", { p_business: membership.business_id });
  if (!isOwner) {
    return (
      <main className="mx-auto max-w-md space-y-4 px-4 py-16">
        <Logo className="text-2xl text-caramel" />
        <Notice tone="warn">Your access is turned off. Ask the owner to reactivate you.</Notice>
        <a href="/login" className="btn-secondary w-full">Sign in as someone else</a>
      </main>
    );
  }

  return (
    <OwnerProvider value={{ businessId: membership.business_id, businessName: membership.business_name, userId: user.id }}>
      <div className="min-h-dvh lg:flex">
        <AdminNav businessName={membership.business_name} email={user.email ?? ""} />
        <main className="min-w-0 flex-1 px-4 py-6 lg:px-10 lg:py-8"><div className="mx-auto max-w-7xl">{children}</div></main>
      </div>
    </OwnerProvider>
  );
}
