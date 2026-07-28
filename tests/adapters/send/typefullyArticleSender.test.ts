import { describe, it, expect } from "vitest";
import { TypefullyArticleSender } from "../../../src/adapters/send/TypefullyArticleSender";

function fakeFetch(responses: { ok: boolean; status: number; body: unknown }[]) {
  const calls: { url: string; method?: string; body: any }[] = [];
  let i = 0;
  const fn = (async (url: string, init?: any) => {
    calls.push({ url: String(url), method: init?.method, body: init?.body ? JSON.parse(init.body) : undefined });
    const r = responses[Math.min(i++, responses.length - 1)];
    return { ok: r.ok, status: r.status, json: async () => r.body, text: async () => JSON.stringify(r.body) } as Response;
  }) as unknown as typeof fetch;
  return { fn, calls };
}
const noSleep = async () => {};

describe("TypefullyArticleSender", () => {
  it("posts an x_article draft (no enabled/posts) and parses the article id from x_article_published_url", async () => {
    const { fn, calls } = fakeFetch([{ ok: true, status: 200, body: { id: 5, x_article_published_url: "https://x.com/i/article/123" } }]);
    const res = await new TypefullyArticleSender("KEY", "42", fn, noSleep).send({ content_markdown: "# T\n\nbody", cover_media_id: "C1" });
    expect(calls[0].url).toContain("/social-sets/42/drafts");
    expect(calls[0].body.platforms.x_article).toEqual({ content_markdown: "# T\n\nbody", cover_media_id: "C1" });
    expect(calls[0].body.platforms.x_article.enabled).toBeUndefined();
    expect(calls[0].body.publish_at).toBe("now");
    expect(res).toEqual({ postId: "123", url: "https://x.com/i/article/123" });
  });

  it("omits cover_media_id when not provided, and polls for the url when the create lacks it", async () => {
    const { fn, calls } = fakeFetch([
      { ok: true, status: 200, body: { id: 5 } },
      { ok: true, status: 200, body: { x_article_published_url: "https://x.com/i/article/9" } },
    ]);
    const res = await new TypefullyArticleSender("KEY", "42", fn, noSleep).send({ content_markdown: "# T" });
    expect("cover_media_id" in calls[0].body.platforms.x_article).toBe(false);
    expect(res).toEqual({ postId: "9", url: "https://x.com/i/article/9" });
  });

  it("throws on a create error", async () => {
    const { fn } = fakeFetch([{ ok: false, status: 400, body: { error: "bad" } }]);
    await expect(new TypefullyArticleSender("KEY", "42", fn, noSleep).send({ content_markdown: "# T" })).rejects.toThrow(/HTTP 400/);
  });
});
