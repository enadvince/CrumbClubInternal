import { describe, expect, it } from "vitest";
import bcrypt from "bcryptjs";
import { findStaffByPin } from "./pin";

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
