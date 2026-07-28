import { describe, it, expect } from "vitest";
import { TelegramBotSender } from "../../../src/adapters/send/TelegramBotSender";

function fakeFetch(responses: { ok: boolean; status: number; body: unknown }[]) {
  const calls: { url: string; body: unknown }[] = [];
  let i = 0;
  const fn = (async (url: string, init?: { body?: string }) => {
    calls.push({ url: String(url), body: init?.body ? JSON.parse(init.body) : undefined });
    const r = responses[Math.min(i++, responses.length - 1)];
    return { ok: r.ok, status: r.status, json: async () => r.body, text: async () => JSON.stringify(r.body) } as Response;
  }) as unknown as typeof fetch;
  return { fn, calls };
}

describe("TelegramBotSender", () => {
  it("sends one HTML message per segment, chaining replies to the first", async () => {
    const { fn, calls } = fakeFetch([
      { ok: true, status: 200, body: { result: { message_id: 11 } } },
      { ok: true, status: 200, body: { result: { message_id: 12 } } },
    ]);
    const res = await new TelegramBotSender("TOK", "-100999", fn).send({ itemId: "x:1", type: "announcement", channel: "telegram", segments: ["A", "B"] });
    expect(calls).toHaveLength(2);
    expect(calls[0].url).toContain("/botTOK/sendMessage");
    expect(calls[0].body).toMatchObject({ chat_id: "-100999", text: "A", parse_mode: "HTML" });
    expect(calls[1].body).toMatchObject({ text: "B", reply_to_message_id: 11 });
    expect(res.postId).toBe("11");
    expect(res.url).toBe("https://t.me/c/999/11");
  });

  it("throws with the API error on a non-ok response", async () => {
    const { fn } = fakeFetch([{ ok: false, status: 400, body: { description: "chat not found" } }]);
    await expect(new TelegramBotSender("TOK", "-100999", fn).send({ itemId: "x:1", type: "x", channel: "telegram", segments: ["A"] }))
      .rejects.toThrow(/400/);
  });
});

describe("TelegramBotSender per-request chatId override", () => {
  it("posts to the per-request chatId when one is given, instead of the configured one", async () => {
    const { fn, calls } = fakeFetch([{ ok: true, status: 200, body: { result: { message_id: 1 } } }]);
    await new TelegramBotSender("TOK", "-100111", fn).send({ itemId: "x:1", type: "announcement", channel: "telegram", segments: ["안녕"], chatId: "-100222" });
    expect((calls[0]?.body as { chat_id: string }).chat_id).toBe("-100222");
  });

  it("falls back to the configured chatId when the request omits one", async () => {
    const { fn, calls } = fakeFetch([{ ok: true, status: 200, body: { result: { message_id: 1 } } }]);
    await new TelegramBotSender("TOK", "-100111", fn).send({ itemId: "x:1", type: "announcement", channel: "telegram", segments: ["안녕"] });
    expect((calls[0]?.body as { chat_id: string }).chat_id).toBe("-100111");
  });

  it("uses the overridden chatId for sendPhoto and for the derived t.me url", async () => {
    const calls: { url: string; body: any }[] = [];
    const fn = (async (url: string, init?: any) => { calls.push({ url: String(url), body: JSON.parse(init.body) });
      return { ok: true, status: 200, json: async () => ({ result: { message_id: 5 } }), text: async () => "" } as Response; }) as unknown as typeof fetch;
    const res = await new TelegramBotSender("T", "-100999", fn).send({ itemId: "x:1", type: "announcement", channel: "telegram", segments: ["짧은 공지"], photos: ["https://pbs.twimg.com/media/a.jpg"], chatId: "-100555" });
    expect(calls[0].url).toContain("/sendPhoto");
    expect(calls[0].body).toMatchObject({ chat_id: "-100555", photo: "https://pbs.twimg.com/media/a.jpg" });
    expect(res.url).toBe("https://t.me/c/555/5");
  });

  it("uses the overridden chatId for sendMediaGroup and the reply message", async () => {
    const calls: { url: string; body: any }[] = [];
    const fn = (async (url: string, init?: any) => { const u = String(url); calls.push({ url: u, body: JSON.parse(init.body) });
      const result = u.includes("sendMediaGroup") ? [{ message_id: 5 }] : { message_id: 6 };
      return { ok: true, status: 200, json: async () => ({ result }), text: async () => "" } as Response; }) as unknown as typeof fetch;
    await new TelegramBotSender("T", "-100999", fn).send({ itemId: "x:1", type: "x", channel: "telegram", segments: ["본문"], photos: ["https://pbs.twimg.com/media/a.jpg", "https://pbs.twimg.com/media/b.jpg"], chatId: "-100555" });
    expect(calls[0].url).toContain("/sendMediaGroup");
    expect(calls[0].body).toMatchObject({ chat_id: "-100555" });
    expect(calls[1].url).toContain("/sendMessage");
    expect(calls[1].body).toMatchObject({ chat_id: "-100555", reply_to_message_id: 5 });
  });

  it("uses the overridden chatId for every reply-chained sendMessage segment", async () => {
    const { fn, calls } = fakeFetch([
      { ok: true, status: 200, body: { result: { message_id: 11 } } },
      { ok: true, status: 200, body: { result: { message_id: 12 } } },
    ]);
    await new TelegramBotSender("TOK", "-100999", fn).send({ itemId: "x:1", type: "announcement", channel: "telegram", segments: ["A", "B"], chatId: "-100777" });
    expect(calls[0].body).toMatchObject({ chat_id: "-100777" });
    expect(calls[1].body).toMatchObject({ chat_id: "-100777", reply_to_message_id: 11 });
  });
});

describe("TelegramBotSender media", () => {
  it("one photo + short text → sendPhoto with the text as caption, no separate sendMessage", async () => {
    const calls: { url: string; body: any }[] = [];
    const fn = (async (url: string, init?: any) => { calls.push({ url: String(url), body: JSON.parse(init.body) });
      return { ok: true, status: 200, json: async () => ({ result: { message_id: 5 } }), text: async () => "" } as Response; }) as unknown as typeof fetch;
    await new TelegramBotSender("T", "-100999", fn).send({ itemId: "x:1", type: "announcement", channel: "telegram", segments: ["짧은 공지"], photos: ["https://pbs.twimg.com/media/a.jpg"] });
    expect(calls).toHaveLength(1);
    expect(calls[0].url).toContain("/sendPhoto");
    expect(calls[0].body).toMatchObject({ photo: "https://pbs.twimg.com/media/a.jpg", caption: "짧은 공지" });
  });

  it("two photos → sendMediaGroup, then the text as a reply message", async () => {
    const calls: { url: string; body: any }[] = [];
    const fn = (async (url: string, init?: any) => { const u = String(url); calls.push({ url: u, body: JSON.parse(init.body) });
      const result = u.includes("sendMediaGroup") ? [{ message_id: 5 }] : { message_id: 6 };
      return { ok: true, status: 200, json: async () => ({ result }), text: async () => "" } as Response; }) as unknown as typeof fetch;
    await new TelegramBotSender("T", "-100999", fn).send({ itemId: "x:1", type: "x", channel: "telegram", segments: ["본문"], photos: ["https://pbs.twimg.com/media/a.jpg", "https://pbs.twimg.com/media/b.jpg"] });
    expect(calls[0].url).toContain("/sendMediaGroup");
    expect(calls[0].body.media).toHaveLength(2);
    expect(calls[0].body.media[0]).toMatchObject({ type: "photo", media: "https://pbs.twimg.com/media/a.jpg" });
    expect(calls[1].url).toContain("/sendMessage");
    expect(calls[1].body).toMatchObject({ text: "본문", reply_to_message_id: 5 });
  });

  it("no photos → sendMessage only (unchanged)", async () => {
    const calls: string[] = [];
    const fn = (async (url: string) => { calls.push(String(url)); return { ok: true, status: 200, json: async () => ({ result: { message_id: 1 } }), text: async () => "" } as Response; }) as unknown as typeof fetch;
    await new TelegramBotSender("T", "-100999", fn).send({ itemId: "x:1", type: "x", channel: "telegram", segments: ["a", "b"] });
    expect(calls.every((u) => u.includes("/sendMessage"))).toBe(true);
    expect(calls).toHaveLength(2);
  });
});
