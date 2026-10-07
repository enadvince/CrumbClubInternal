/** Turns a Supabase/PostgREST error into a short human message. */
export function errorMessage(err: unknown): string {
  if (!err) return "Something went wrong";
  if (typeof err === "string") return err;
  if (typeof err === "object" && err && "message" in err && typeof err.message === "string") return err.message;
  return "Something went wrong";
}
