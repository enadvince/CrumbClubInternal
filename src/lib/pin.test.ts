import { describe, expect, it } from "vitest";
import bcrypt from "bcryptjs";
import { findStaffByPin, orderByRecent, pushRecent } from "./pin";

// Produced by Postgres: select crypt('1234', gen_salt('bf', 8));
const PGCRYPTO_1234 = "$2a$08$bQSerkhTUtUTafQVF/cAyecj4Q0.ahiTPzC73.GU86IOnrB/YxOw6";

describe("findStaffByPin", () => {
  const staff = [
    { id: "owner", name: "Owner", role: "owner" as const, pin_hash: PGCRYPTO_1234 },
    { id: "s1", name: "Staff One", role: "staff" as const, pin_hash: bcrypt.hashSync("1111", 4) },
  ];

  it("verifies pgcrypto-generated hashes", async () => {
    expect((await findStaffByPin("1234", staff))?.id).toBe("owner");
  });
  it("matches the right staff member", async () => {
    expect((await findStaffByPin("1111", staff))?.id).toBe("s1");
  });
  it("rejects wrong or malformed PINs", async () => {
    expect(await findStaffByPin("9999", staff)).toBeNull();
    expect(await findStaffByPin("12345", staff)).toBeNull();
    expect(await findStaffByPin("12a4", staff)).toBeNull();
  });
});

describe("orderByRecent", () => {
  const staff = [{ id: "a" }, { id: "b" }, { id: "c" }, { id: "d" }];
  it("puts recent staff first, newest first, and keeps the rest in order", () => {
    expect(orderByRecent(staff, ["c", "a"]).map((s) => s.id)).toEqual(["c", "a", "b", "d"]);
  });
  it("ignores ids that are no longer on staff", () => {
    expect(orderByRecent(staff, ["gone", "d"]).map((s) => s.id)).toEqual(["d", "a", "b", "c"]);
  });
});

describe("pushRecent", () => {
  it("moves the id to the front without duplicates and caps the list", () => {
    expect(pushRecent(["a", "b", "c"], "b")).toEqual(["b", "a", "c"]);
    expect(pushRecent(["a", "b"], "c", 2)).toEqual(["c", "a"]);
  });
});
