import { describe, expect, it, vi } from "vitest";
import { withReadTimeout } from "./client";

const ok = () => new Response("ok");
/** A fetch that never answers until its signal aborts. */
const hang = (_: RequestInfo | URL, init?: RequestInit) =>
  new Promise<Response>((_, reject) => init?.signal?.addEventListener("abort", () => reject(init.signal!.reason)));

describe("withReadTimeout", () => {
  it("retries a stalled read once with a fresh request", async () => {
    const base = vi.fn<typeof fetch>().mockImplementationOnce(hang).mockResolvedValueOnce(ok());
    const res = await withReadTimeout(base, 20)("https://x/rest/v1/events");
    expect(await res.text()).toBe("ok");
    expect(base).toHaveBeenCalledTimes(2);
  });

  it("gives up after the retry also stalls", async () => {
    const base = vi.fn<typeof fetch>().mockImplementation(hang);
    await expect(withReadTimeout(base, 20)("https://x/rest/v1/events")).rejects.toMatchObject({ name: "TimeoutError" });
    expect(base).toHaveBeenCalledTimes(2);
  });

  it("never times out or repeats writes", async () => {
    const base = vi.fn<typeof fetch>().mockResolvedValue(ok());
    await withReadTimeout(base, 20)("https://x/rest/v1/rpc/sync", { method: "POST", body: "{}" });
    expect(base).toHaveBeenCalledTimes(1);
    expect(base.mock.calls[0][1]?.signal).toBeUndefined();
  });

  it("keeps the caller's own signal", async () => {
    const base = vi.fn<typeof fetch>().mockResolvedValue(ok());
    const signal = new AbortController().signal;
    await withReadTimeout(base, 20)("https://x/rest/v1/events", { signal });
    expect(base.mock.calls[0][1]?.signal).toBe(signal);
  });
});
