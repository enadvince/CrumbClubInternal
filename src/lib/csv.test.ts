import { describe, expect, it } from "vitest";
import { toCsv } from "./csv";

describe("toCsv", () => {
  it("escapes commas, quotes and newlines", () => {
    expect(toCsv(["a", "b"], [["x,y", 'say "hi"'], [null, "line\nbreak"]])).toBe('a,b\r\n"x,y","say ""hi"""\r\n,"line\nbreak"\r\n');
  });
});
