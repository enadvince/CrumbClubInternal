import { describe, expect, it } from "vitest";
import { isPermanentFailure } from "./transport";

describe("which failures are retried", () => {
  it("retries network errors, timeouts, 5xx, 429 and auth refreshes", () => {
    for (const status of [0, undefined, 500, 502, 503, 504, 429, 408, 401, 404]) {
      expect(isPermanentFailure(status, undefined)).toBe(false);
    }
  });
  it("stops on validation errors and other 4xx, keeping them for review", () => {
    expect(isPermanentFailure(400, "P0001")).toBe(true); // raise exception in an RPC
    expect(isPermanentFailure(400, "23505")).toBe(true); // unique violation
    expect(isPermanentFailure(400, "22P02")).toBe(true); // bad input
    expect(isPermanentFailure(403, "42501")).toBe(true); // wrong device
    expect(isPermanentFailure(400, "PGRST100")).toBe(true);
    expect(isPermanentFailure(503, "PGRST000")).toBe(false);
  });
});
