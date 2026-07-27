import { describe, it, expect } from "vitest";
import { TypefullySender } from "../../../src/adapters/send/TypefullySender";

function fakeFetch(responses: { ok: boolean; status: number; body: unknown }[]) {
  const calls: { url: string; method?: string; body: unknown; auth?: string }[] = [];
  let i = 0;
  const fn = (async (url: string, init?: { method?: string; body?: string; headers?: Record<string, string> }) => {
    calls.push({ url: String(url), method: init?.method, body: init?.body ? JSON.parse(init.body) : undefined, auth: init?.headers?.Authorization });
    const r = responses[Math.min(i++, responses.length - 1)];
    return { ok: r.ok, status: r.status, json: async () => r.body, text: async () => JSON.stringify(r.body) } as Response;
  }) as unknown as typeof fetch;
  return { fn, calls };
}
const noSleep = async () => {};

describe("TypefullySender", () => {
  it("creates a draft (posts array = segments, publish now, bearer) and returns the url from the create response", async () => {
    const { fn, calls } = fakeFetch([{ ok: true, status: 200, body: { id: 77, x_published_url: "https://x.com/i/status/1" } }]);
    const res = await new TypefullySender("KEY", "42", fn, noSleep).send({ itemId: "x:1", type: "x", channel: "x", segments: ["a", "b", "c"] });
    expect(calls[0].url).toContain("/v2/social-sets/42/drafts");
    expect(calls[0].method).toBe("POST");
    expect(calls[0].auth).toBe("Bearer KEY");
    expect((calls[0].body as any).platforms.x.posts).toEqual([{ text: "a" }, { text: "b" }, { text: "c" }]);
    expect((calls[0].body as any).publish_at).toBe("now");
    // postId must be the X tweet id parsed from x_published_url (what RecordImpressions looks up
    // via twitterapi.io), not Typefully's own draft id ("77").
    expect(res).toEqual({ postId: "1", url: "https://x.com/i/status/1" });
  });

  it("polls the draft for x_published_url when the create response lacks it", async () => {
    const { fn, calls } = fakeFetch([
      { ok: true, status: 200, body: { id: 77 } },
      { ok: true, status: 200, body: {} },
      { ok: true, status: 200, body: { x_published_url: "https://x.com/i/status/9" } },
    ]);
    const res = await new TypefullySender("KEY", "42", fn, noSleep).send({ itemId: "x:1", type: "x", channel: "x", segments: ["a"] });
    expect(res).toEqual({ postId: "9", url: "https://x.com/i/status/9" });
    // The poll GETs must hit the specific draft's endpoint with the bearer auth carried through.
    expect(calls[1].url).toContain("/v2/social-sets/42/drafts/77");
    expect(calls[1].auth).toBe("Bearer KEY");
    expect(calls[2].url).toContain("/v2/social-sets/42/drafts/77");
    expect(calls[2].auth).toBe("Bearer KEY");
  });

  it("returns the draft id without a url when the poll never resolves", async () => {
    const { fn } = fakeFetch([{ ok: true, status: 200, body: { id: 77 } }, { ok: true, status: 200, body: {} }]);
    const res = await new TypefullySender("KEY", "42", fn, noSleep).send({ itemId: "x:1", type: "x", channel: "x", segments: ["a"] });
    expect(res).toEqual({ postId: "77", url: undefined });
  });

  it("throws on a non-ok create", async () => {
    const { fn } = fakeFetch([{ ok: false, status: 401, body: { detail: "bad key" } }]);
    await expect(new TypefullySender("KEY", "42", fn, noSleep).send({ itemId: "x:1", type: "x", channel: "x", segments: ["a"] }))
      .rejects.toThrow(/401/);
  });
});
