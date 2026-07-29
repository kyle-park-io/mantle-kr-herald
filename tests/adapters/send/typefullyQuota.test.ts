import { describe, it, expect } from "vitest";
import { TypefullyQuota } from "../../../src/adapters/send/TypefullyQuota";

/** The live payload shape, trimmed to what this adapter reads (social set 283589, 2026-07-29). */
const LIVE = {
  id: 283589,
  username: "bcd_kyle",
  publishing_quota: { used: 9, remaining: 6, resets_at: "2026-08-01T00:00:00+09:00" },
};

function fakeFetch(body: unknown, ok = true, status = 200) {
  const calls: { url: string; auth?: string }[] = [];
  const fn = (async (url: string, init?: any) => {
    calls.push({ url: String(url), auth: init?.headers?.Authorization });
    return { ok, status, json: async () => body } as Response;
  }) as unknown as typeof fetch;
  return { fn, calls };
}

describe("TypefullyQuota", () => {
  it("reads the quota off the social set", async () => {
    const { fn, calls } = fakeFetch(LIVE);
    const quota = await new TypefullyQuota("KEY", "283589", fn, async () => {}).read();
    expect(quota).toEqual({ used: 9, remaining: 6, resetsAt: "2026-08-01T00:00:00+09:00" });
    expect(calls[0].auth).toBe("Bearer KEY");
  });

  /** Without it the API answers 301 with an empty body, which would parse as a quota of nothing. */
  it("requests the trailing-slash url", async () => {
    const { fn, calls } = fakeFetch(LIVE);
    await new TypefullyQuota("KEY", "283589", fn, async () => {}).read();
    expect(calls[0].url).toBe("https://api.typefully.com/v2/social-sets/283589/");
  });

  it("throws on a non-ok response", async () => {
    const { fn } = fakeFetch({}, false, 401);
    await expect(new TypefullyQuota("KEY", "283589", fn, async () => {}).read()).rejects.toThrow(/HTTP 401/);
  });

  // Silently reporting "0 remaining" for a payload that simply lacks the field would block every
  // send on the account for no reason.
  it("throws when the payload carries no publishing_quota", async () => {
    const { fn } = fakeFetch({ id: 283589 });
    await expect(new TypefullyQuota("KEY", "283589", fn, async () => {}).read()).rejects.toThrow(/publishing_quota/);
  });

  /**
   * `used` used to default to `0`, which is the one shape that fails DANGEROUSLY rather than
   * loudly. The resend guard proves "the original published while we were cancelling it" by
   * comparing `used` across the cancel: with both sides defaulted to `0` they agree, the guard
   * concludes nothing published, and the resend goes out on top of a live post — while the guard
   * believes it verified. A quota this adapter cannot read must say so.
   */
  it("throws when publishing_quota omits `used` — a defaulted 0 would silently disarm the resend guard", async () => {
    const { fn } = fakeFetch({ id: 283589, publishing_quota: { remaining: 6, resets_at: "2026-08-01T00:00:00+09:00" } });
    await expect(new TypefullyQuota("KEY", "283589", fn, async () => {}).read()).rejects.toThrow(/publishing_quota/);
  });
});
