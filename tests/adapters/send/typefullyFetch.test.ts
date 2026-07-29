import { describe, it, expect } from "vitest";
import { createTypefullyFetch } from "../../../src/adapters/send/typefullyFetch";

/** Returns the queued responses in order; a queued Error is thrown instead (network failure). */
function fakeFetch(queue: (Partial<Response> | Error)[]) {
  const calls: string[] = [];
  const fn = (async (url: string) => {
    calls.push(String(url));
    const next = queue.shift();
    if (next instanceof Error) throw next;
    return { ok: (next?.status ?? 200) < 400, status: 200, ...next } as Response;
  }) as unknown as typeof fetch;
  return { fn, calls };
}

function fakeSleep() {
  const slept: number[] = [];
  return { slept, sleep: async (ms: number) => void slept.push(ms) };
}

describe("createTypefullyFetch", () => {
  it("retries a 429 and returns the eventual success", async () => {
    const { fn, calls } = fakeFetch([{ status: 429 }, { status: 200 }]);
    const { slept, sleep } = fakeSleep();
    const res = await createTypefullyFetch(fn, sleep, () => {})("https://api.typefully.com/v2/me");
    expect(res.status).toBe(200);
    expect(calls).toHaveLength(2);
    expect(slept).toEqual([1000]);
  });

  it("retries an idempotent 5xx and gives up after three attempts", async () => {
    const { fn, calls } = fakeFetch([{ status: 503 }, { status: 503 }, { status: 503 }]);
    const { slept, sleep } = fakeSleep();
    const res = await createTypefullyFetch(fn, sleep, () => {})("https://api.typefully.com/v2/me");
    expect(res.status).toBe(503);
    expect(calls).toHaveLength(3);
    // No sleep after the final attempt — it would only delay the return.
    expect(slept).toEqual([1000, 2000]);
  });

  it("retries a network failure and returns the eventual success", async () => {
    const { fn, calls } = fakeFetch([new Error("ECONNRESET"), { status: 200 }]);
    const { sleep } = fakeSleep();
    const res = await createTypefullyFetch(fn, sleep, () => {})("https://api.typefully.com/v2/me");
    expect(res.status).toBe(200);
    expect(calls).toHaveLength(2);
  });

  it("does not retry a 4xx that is not 429", async () => {
    const { fn, calls } = fakeFetch([{ status: 400 }]);
    const { slept, sleep } = fakeSleep();
    const res = await createTypefullyFetch(fn, sleep, () => {})("https://api.typefully.com/v2/me");
    expect(res.status).toBe(400);
    expect(calls).toHaveLength(1);
    expect(slept).toEqual([]);
  });

  // The whole point of the option: a lost response on draft creation is indistinguishable from a
  // rejected one, and replaying it publishes the same post twice.
  it("does NOT retry a 5xx on a non-idempotent call", async () => {
    const { fn, calls } = fakeFetch([{ status: 502 }, { status: 200 }]);
    const { sleep } = fakeSleep();
    const res = await createTypefullyFetch(fn, sleep, () => {})("https://x/drafts", { method: "POST" }, { idempotent: false });
    expect(res.status).toBe(502);
    expect(calls).toHaveLength(1);
  });

  it("does NOT retry a network failure on a non-idempotent call, and says the request may have landed", async () => {
    const { fn, calls } = fakeFetch([new Error("ECONNRESET")]);
    const { sleep } = fakeSleep();
    const call = createTypefullyFetch(fn, sleep, () => {})("https://x/drafts", { method: "POST" }, { idempotent: false });
    await expect(call).rejects.toThrow(/may still have been processed/);
    expect(calls).toHaveLength(1);
  });

  // A 429 was rejected before it was processed, so replaying it cannot duplicate anything.
  it("DOES retry a 429 even on a non-idempotent call", async () => {
    const { fn, calls } = fakeFetch([{ status: 429 }, { status: 200 }]);
    const { sleep } = fakeSleep();
    const res = await createTypefullyFetch(fn, sleep, () => {})("https://x/drafts", { method: "POST" }, { idempotent: false });
    expect(res.status).toBe(200);
    expect(calls).toHaveLength(2);
  });

  it("logs the rate-limit headers on a 429", async () => {
    const headers = new Map([
      ["x-ratelimit-user-limit", "5000"],
      ["x-ratelimit-user-remaining", "0"],
      ["x-ratelimit-socialset-resource", "drafts.create"],
    ]);
    const { fn } = fakeFetch([
      { status: 429, headers: { get: (h: string) => headers.get(h) ?? null } as unknown as Headers },
      { status: 200 },
    ]);
    const logged: string[] = [];
    await createTypefullyFetch(fn, async () => {}, (m) => logged.push(m))("https://api.typefully.com/v2/me");
    expect(logged[0]).toContain("user-remaining=0");
    expect(logged[0]).toContain("socialset-resource=drafts.create");
  });
});
