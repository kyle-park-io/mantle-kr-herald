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
    expect(res).toEqual({ xUrl: "https://x.com/a/status/9", xId: "9", articleUrl: undefined, articleId: undefined });
  });

  it("parses an article url", async () => {
    const { fn } = fakeFetch({ x_article_published_url: "https://x.com/i/article/2082141" });
    expect(await new TypefullyDraftLookup("KEY", "42", fn).published("100")).toEqual({
      xUrl: undefined, xId: undefined, articleUrl: "https://x.com/i/article/2082141", articleId: "2082141",
    });
  });

  it("returns {} on a non-ok response (still scheduled / unknown draft)", async () => {
    const { fn } = fakeFetch({}, false, 404);
    expect(await new TypefullyDraftLookup("KEY", "42", fn).published("100")).toEqual({});
  });
});
