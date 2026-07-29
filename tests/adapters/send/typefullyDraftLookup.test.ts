import { describe, it, expect } from "vitest";
import { TypefullyDraftLookup } from "../../../src/adapters/send/TypefullyDraftLookup";

function fakeFetch(body: unknown, ok = true, status = 200) {
  const calls: { url: string; auth?: string; method?: string }[] = [];
  const fn = (async (url: string, init?: any) => {
    calls.push({ url: String(url), auth: init?.headers?.Authorization, method: init?.method });
    return { ok, status, json: async () => body } as Response;
  }) as unknown as typeof fetch;
  return { fn, calls };
}

/** The retry wrapper's real backoff is seconds long; nothing here is testing how long it waits. */
const noSleep = async (): Promise<void> => {};

describe("TypefullyDraftLookup", () => {
  it("maps published urls and parses the ids", async () => {
    const { fn, calls } = fakeFetch({ x_published_url: "https://x.com/a/status/9", x_article_published_url: null });
    const res = await new TypefullyDraftLookup("KEY", "42", fn).published("100");
    expect(calls[0].url).toContain("/v2/social-sets/42/drafts/100");
    expect(calls[0].auth).toBe("Bearer KEY");
    expect(res).toEqual({
      state: "published", xUrl: "https://x.com/a/status/9", xId: "9", articleUrl: undefined, articleId: undefined,
    });
  });

  it("parses an article url", async () => {
    const { fn } = fakeFetch({ x_article_published_url: "https://x.com/i/article/2082141" });
    expect(await new TypefullyDraftLookup("KEY", "42", fn).published("100")).toEqual({
      state: "published", xUrl: undefined, xId: undefined, articleUrl: "https://x.com/i/article/2082141", articleId: "2082141",
    });
  });

  it("reports a draft with no published url as still scheduled", async () => {
    const { fn } = fakeFetch({ x_published_url: null, x_article_published_url: null });
    expect(await new TypefullyDraftLookup("KEY", "42", fn).published("100")).toEqual({ state: "scheduled" });
  });

  it("reports a 404 as gone — the draft was deleted and will never publish", async () => {
    const { fn } = fakeFetch({}, false, 404);
    expect(await new TypefullyDraftLookup("KEY", "42", fn).published("100")).toEqual({ state: "gone" });
  });

  it("reports a 500 as still scheduled — an outage must never retire a queued draft", async () => {
    const { fn } = fakeFetch({}, false, 500);
    expect(await new TypefullyDraftLookup("KEY", "42", fn).published("100")).toEqual({ state: "scheduled" });
  });

  it("reports a 403 as still scheduled", async () => {
    const { fn } = fakeFetch({}, false, 403);
    expect(await new TypefullyDraftLookup("KEY", "42", fn).published("100")).toEqual({ state: "scheduled" });
  });
});

// `cancel` is what stops a resend inside the two-minute publish window from posting twice, so what
// matters is that it can only answer `true` when the draft is provably no longer in the queue.
describe("TypefullyDraftLookup.cancel", () => {
  it("deletes the draft and reports it gone", async () => {
    const { fn, calls } = fakeFetch({}, true, 204);
    expect(await new TypefullyDraftLookup("KEY", "42", fn).cancel("100")).toBe(true);
    expect(calls[0].url).toContain("/v2/social-sets/42/drafts/100");
    expect(calls[0].method).toBe("DELETE"); // a GET here would report success while the draft publishes
    expect(calls[0].auth).toBe("Bearer KEY");
  });

  it("treats a 404 on cancel as already gone — that is the end state a cancel asks for", async () => {
    const { fn } = fakeFetch({}, false, 404);
    expect(await new TypefullyDraftLookup("KEY", "42", fn).cancel("100")).toBe(true);
  });

  it("reports a failed cancel, after exhausting the shared wrapper's retries", async () => {
    const { fn, calls } = fakeFetch({}, false, 500);
    expect(await new TypefullyDraftLookup("KEY", "42", fn, noSleep).cancel("100")).toBe(false);
    expect(calls).toHaveLength(3); // went through createTypefullyFetch, not a bare fetch
  });
});
