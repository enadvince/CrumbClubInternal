"use client";
import { useState } from "react";
import { getSupabase } from "@/lib/supabase/client";
import { errorMessage } from "@/lib/errors";

/** Uploads to the public "photos" bucket under <businessId>/ and returns the public URL. */
export function PhotoInput({ businessId, value, onChange }: { businessId: string; value: string | null; onChange: (url: string | null) => void }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function upload(file: File) {
    setBusy(true);
    setError(null);
    try {
      const ext = (file.name.split(".").pop() ?? "jpg").toLowerCase().replace(/[^a-z0-9]/g, "");
      const path = `${businessId}/${crypto.randomUUID()}.${ext}`;
      const storage = getSupabase().storage.from("photos");
      const { error } = await storage.upload(path, file, { cacheControl: "31536000", upsert: false });
      if (error) throw error;
      onChange(storage.getPublicUrl(path).data.publicUrl);
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="flex items-center gap-3">
      <Thumb url={value} name="" size="lg" />
      <div className="space-y-1">
        <label className="btn-secondary cursor-pointer text-sm">
          {busy ? "Uploading…" : value ? "Change photo" : "Add photo"}
          <input type="file" accept="image/*" className="sr-only" disabled={busy}
            onChange={(e) => { const f = e.target.files?.[0]; if (f) upload(f); }} />
        </label>
        {value && <button type="button" className="btn-ghost text-sm" onClick={() => onChange(null)}>Remove</button>}
        {error && <p role="alert" className="text-sm text-danger">{error}</p>}
      </div>
    </div>
  );
}

const sizes = { sm: "h-10 w-10 text-lg", md: "h-14 w-14 text-2xl", lg: "h-20 w-20 text-3xl" };

export function Thumb({ url, name, size = "md" }: { url: string | null | undefined; name: string; size?: keyof typeof sizes }) {
  if (url) {
    // eslint-disable-next-line @next/next/no-img-element
    return <img src={url} alt="" className={`${sizes[size]} shrink-0 rounded-xl object-cover`} loading="lazy" />;
  }
  return (
    <span aria-hidden className={`${sizes[size]} flex shrink-0 items-center justify-center rounded-xl bg-crust font-bold text-caramel`}>
      {name ? name.trim().charAt(0).toUpperCase() : "🥐"}
    </span>
  );
}
