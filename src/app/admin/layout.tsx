export const dynamic = "force-dynamic";

import { redirect } from "next/navigation";
import { getSessionContext } from "@/lib/supabase/server";
import { AdminNav } from "./AdminNav";
import { OwnerProvider } from "./OwnerContext";

export default async function AdminLayout({ children }: { children: React.ReactNode }) {
  const { user, membership } = await getSessionContext();
  if (!user) redirect("/login?next=/admin/dashboard");
  if (!membership) redirect("/setup");
  if (membership.role !== "owner") redirect("/pos");

  return (
    <OwnerProvider value={{ businessId: membership.business_id, businessName: membership.business_name, userId: user.id }}>
      <div className="min-h-dvh lg:flex">
        <AdminNav businessName={membership.business_name} email={user.email ?? ""} />
        <main id="main" className="min-w-0 flex-1 px-4 py-6 lg:px-8">{children}</main>
      </div>
    </OwnerProvider>
  );
}
