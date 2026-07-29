import { describe, it, expect } from "vitest";
import { TypefullyArticleSender } from "../../../src/adapters/send/TypefullyArticleSender";
import { scheduledPublishAt } from "../../../src/adapters/send/typefullyPublish";

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
const AT = 1_800_000_000_000;
const now = () => AT;

describe("TypefullyArticleSender", () => {
  it("posts a scheduled x_article draft (no enabled/posts) and returns the share_url", async () => {
    const { fn, calls } = fakeFetch([{ ok: true, status: 200, body: { id: 5, share_url: "https://typefully.com/t/art" } }]);
    const res = await new TypefullyArticleSender("KEY", "42", fn, noSleep, now).send({ content_markdown: "# T\n\nbody", cover_media_id: "C1" });
    expect(calls[0].url).toContain("/social-sets/42/drafts");
    expect(calls[0].body.platforms.x_article).toEqual({ content_markdown: "# T\n\nbody", cover_media_id: "C1" });
    expect(calls[0].body.platforms.x_article.enabled).toBeUndefined();
    expect(calls[0].body.publish_at).toBe(scheduledPublishAt(now));
    expect(calls[0].body.publish_at).not.toBe("now");
    expect(res).toEqual({ postId: "5", url: "https://typefully.com/t/art" });
    expect(calls).toHaveLength(1); // no poll
  });

  it("omits cover_media_id when not provided", async () => {
    const { fn, calls } = fakeFetch([{ ok: true, status: 200, body: { id: 5, share_url: "https://typefully.com/t/art" } }]);
    const res = await new TypefullyArticleSender("KEY", "42", fn, noSleep, now).send({ content_markdown: "# T" });
    expect("cover_media_id" in calls[0].body.platforms.x_article).toBe(false);
    expect(res).toEqual({ postId: "5", url: "https://typefully.com/t/art" });
  });

  it("throws on a create error", async () => {
    const { fn } = fakeFetch([{ ok: false, status: 400, body: { error: "bad" } }]);
    await expect(new TypefullyArticleSender("KEY", "42", fn, noSleep, now).send({ content_markdown: "# T" })).rejects.toThrow(/HTTP 400/);
  });
});

describe("TypefullyArticleSender — retry behaviour", () => {
  it("does not retry a 5xx on draft creation: the draft may already exist", async () => {
    const calls: string[] = [];
    const fn = (async (url: string) => {
      calls.push(String(url));
      return { ok: false, status: 502, text: async () => "bad gateway" } as Response;
    }) as unknown as typeof fetch;
    const sender = new TypefullyArticleSender("KEY", "42", fn, async () => {});
    await expect(sender.send({ content_markdown: "# T" })).rejects.toThrow(/may have been created/);
    expect(calls).toHaveLength(1);
  });

  it("retries a 429 on draft creation — it was rejected, not processed", async () => {
    const calls: string[] = [];
    const fn = (async (url: string) => {
      calls.push(String(url));
      return calls.length === 1
        ? ({ ok: false, status: 429, text: async () => "" } as Response)
        : ({ ok: true, status: 200, json: async () => ({ id: 7, share_url: "https://typefully.com/t/art" }) } as Response);
    }) as unknown as typeof fetch;
    const sender = new TypefullyArticleSender("KEY", "42", fn, async () => {});
    expect(await sender.send({ content_markdown: "# T" })).toEqual({
      postId: "7",
      url: "https://typefully.com/t/art",
    });
    expect(calls).toHaveLength(2);
  });
});
