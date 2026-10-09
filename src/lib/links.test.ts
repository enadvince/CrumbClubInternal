import { describe, expect, it } from "vitest";
import { withUtm } from "./links";

describe("outbound links", () => {
  it("adds UTM tags without clobbering existing ones", () => {
    expect(withUtm("https://waddlelabs.com/contact", { content: "login" }))
      .toBe("https://waddlelabs.com/contact?utm_source=crumb-club-pos&utm_medium=referral&utm_campaign=app&utm_content=login");
    expect(withUtm("https://x.test/?utm_source=keep")).toContain("utm_source=keep");
  });
  it("leaves non-web links alone", () => {
    expect(withUtm("mailto:help@x.test")).toBe("mailto:help@x.test");
    expect(withUtm("/help")).toBe("/help");
  });
});
