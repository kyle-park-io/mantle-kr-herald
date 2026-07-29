import { describe, it, expect } from "vitest";
import { TypefullyDraftLookup } from "../../../src/adapters/send/TypefullyDraftLookup";

function fakeFetch(body: unknown, ok = true, status = 200) {
  const calls: { url: string; auth?: string }[] = [];
  const fn = (async (url: string, init?: any) => {
    calls.push({ url: String(url), auth: init?.headers?.Authorization });
    return { ok, status, json: async () => body } as Response;
  }) as unknown as typeof fetch;
  return { fn, calls };
}

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

  it("reports a published draft", async () => {
    const { fn } = fakeFetch({ x_published_url: "https://x.com/a/status/9", x_article_published_url: null });
    expect(await new TypefullyDraftLookup("KEY", "42", fn).published("100")).toEqual({
      state: "published", xUrl: "https://x.com/a/status/9", xId: "9", articleUrl: undefined, articleId: undefined,
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
