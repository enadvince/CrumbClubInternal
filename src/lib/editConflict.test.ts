import { describe, expect, it } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import { deleteIfUnchanged, EditConflictError, updateIfUnchanged } from "./editConflict";

/** A tiny stand-in for one table: rows match only when every .eq() filter matches. */
function fakeTable(rows: Record<string, unknown>[]) {
  const calls: { op: string; filters: Record<string, unknown>; changes?: Record<string, unknown> }[] = [];
  const builder = (op: string, changes?: Record<string, unknown>) => {
    const filters: Record<string, unknown> = {};
    const q = {
      eq(col: string, val: unknown) { filters[col] = val; return q; },
      async select() {
        calls.push({ op, filters, changes });
        const hit = rows.filter((r) => Object.entries(filters).every(([k, v]) => r[k] === v));
        if (op === "update") hit.forEach((r) => Object.assign(r, changes, { updated_at: "later" }));
        return { data: hit.map((r) => ({ id: r.id })), error: null };
      },
    };
    return q;
  };
  const client = { from: () => ({ update: (c: Record<string, unknown>) => builder("update", c), delete: () => builder("delete") }) };
  return { client: client as unknown as SupabaseClient, calls, rows };
}

describe("updateIfUnchanged", () => {
  it("saves when the row is as the person saw it", async () => {
    const t = fakeTable([{ id: "p1", updated_at: "t1", price: 100 }]);
    await updateIfUnchanged(t.client, "products", { id: "p1", updated_at: "t1" }, { price: 120 }, "This product");
    expect(t.rows[0].price).toBe(120);
    expect(t.calls[0].filters).toEqual({ id: "p1", updated_at: "t1" });
  });

  it("refuses to overwrite a row someone else changed since", async () => {
    const t = fakeTable([{ id: "p1", updated_at: "t2", price: 150 }]);
    await expect(updateIfUnchanged(t.client, "products", { id: "p1", updated_at: "t1" }, { price: 120 }, "This product"))
      .rejects.toThrow(EditConflictError);
    expect(t.rows[0].price).toBe(150);
  });

  it("names the item in the message", async () => {
    const t = fakeTable([]);
    await expect(updateIfUnchanged(t.client, "products", { id: "p1", updated_at: "t1" }, {}, "Ube Croissant"))
      .rejects.toThrow(/^Ube Croissant was changed by someone else/);
  });
});

describe("deleteIfUnchanged", () => {
  it("refuses to delete a row someone else changed since", async () => {
    const t = fakeTable([{ id: "d1", updated_at: "t2" }]);
    await expect(deleteIfUnchanged(t.client, "discount_options", { id: "d1", updated_at: "t1" }, "This discount")).rejects.toThrow(EditConflictError);
  });
});
