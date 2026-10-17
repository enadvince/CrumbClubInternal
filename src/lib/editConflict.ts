import type { SupabaseClient } from "@supabase/supabase-js";

/** Thrown when a row changed (or was removed) after the person opened it, so their save would overwrite it. */
export class EditConflictError extends Error {
  constructor(what: string) {
    super(`${what} was changed by someone else after you opened it, so your changes weren't saved. Close this, open it again to see their changes, then make yours.`);
    this.name = "EditConflictError";
  }
}

type Seen = { id: string; updated_at: string };

/**
 * Saves `changes` only if the row still has the `updated_at` the person saw when they opened it
 * (each table bumps updated_at on owner edits). Otherwise throws EditConflictError instead of
 * silently overwriting someone else's edit.
 */
export async function updateIfUnchanged(supabase: SupabaseClient, table: string, seen: Seen, changes: Record<string, unknown>, what: string) {
  const { data, error } = await supabase.from(table).update(changes).eq("id", seen.id).eq("updated_at", seen.updated_at).select("id");
  if (error) throw error;
  if (!data?.length) throw new EditConflictError(what);
}

/** Deletes the row only if nobody changed it since it was opened (see updateIfUnchanged). */
export async function deleteIfUnchanged(supabase: SupabaseClient, table: string, seen: Seen, what: string) {
  const { data, error } = await supabase.from(table).delete().eq("id", seen.id).eq("updated_at", seen.updated_at).select("id");
  if (error) throw error;
  if (!data?.length) throw new EditConflictError(what);
}
