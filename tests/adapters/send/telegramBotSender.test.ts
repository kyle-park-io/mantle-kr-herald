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
    const res = await new TelegramBotSender("TOK", fn).send({ itemId: "x:1", type: "announcement", channel: "telegram", segments: ["A", "B"] , chatId: "-100999"});
    expect(calls).toHaveLength(2);
    expect(calls[0].url).toContain("/botTOK/sendMessage");
    expect(calls[0].body).toMatchObject({ chat_id: "-100999", text: "A", parse_mode: "HTML" });
    expect(calls[1].body).toMatchObject({ text: "B", reply_to_message_id: 11 });
    expect(res.postId).toBe("11");
    expect(res.url).toBe("https://t.me/c/999/11");
  });

  it("throws with the API error on a non-ok response", async () => {
    const { fn } = fakeFetch([{ ok: false, status: 400, body: { description: "chat not found" } }]);
    await expect(new TelegramBotSender("TOK", fn).send({ itemId: "x:1", type: "x", channel: "telegram", segments: ["A"] , chatId: "-100999"}))
      .rejects.toThrow(/400/);
  });
});

/**
 * The room is a property of the send, never of the sender. There is no configured default: one
 * would name a single room, so a request that forgot its id would post that room's copy to
 * whichever room the default happened to be — silently, and irreversibly.
 */
describe("TelegramBotSender addresses the room the request names", () => {
  it("posts to the request's chatId", async () => {
    const { fn, calls } = fakeFetch([{ ok: true, status: 200, body: { result: { message_id: 1 } } }]);
    await new TelegramBotSender("TOK", fn).send({ itemId: "x:1", type: "announcement", channel: "telegram", segments: ["안녕"], chatId: "-100222" });
    expect((calls[0]?.body as { chat_id: string }).chat_id).toBe("-100222");
  });

  it("refuses a send that names no room, without reaching the API", async () => {
    const { fn, calls } = fakeFetch([{ ok: true, status: 200, body: { result: { message_id: 1 } } }]);
    const sender = new TelegramBotSender("TOK", fn);
    await expect(sender.send({ itemId: "x:1", type: "announcement", channel: "telegram", segments: ["안녕"] }))
      .rejects.toThrow(/chat id/i);
    expect(calls).toHaveLength(0);
  });

  /** Two rooms, one sender: each send must carry its own id rather than inherit the last one. */
  it("keeps two rooms apart across consecutive sends", async () => {
    const { fn, calls } = fakeFetch([
      { ok: true, status: 200, body: { result: { message_id: 1 } } },
      { ok: true, status: 200, body: { result: { message_id: 2 } } },
    ]);
    const sender = new TelegramBotSender("TOK", fn);
    await sender.send({ itemId: "x:1", type: "announcement", channel: "telegram", segments: ["커뮤니티"], chatId: "-100111" });
    await sender.send({ itemId: "x:1", type: "announcement", channel: "telegram", segments: ["데브방"], chatId: "-100222" });
    expect(calls.map((c) => (c.body as { chat_id: string }).chat_id)).toEqual(["-100111", "-100222"]);
  });

  it("uses the overridden chatId for sendPhoto and for the derived t.me url", async () => {
    const calls: { url: string; body: any }[] = [];
    const fn = (async (url: string, init?: any) => { calls.push({ url: String(url), body: JSON.parse(init.body) });
      return { ok: true, status: 200, json: async () => ({ result: { message_id: 5 } }), text: async () => "" } as Response; }) as unknown as typeof fetch;
    const res = await new TelegramBotSender("T", fn).send({ itemId: "x:1", type: "announcement", channel: "telegram", segments: ["짧은 공지"], photos: ["https://pbs.twimg.com/media/a.jpg"], chatId: "-100555" });
    expect(calls[0].url).toContain("/sendPhoto");
    expect(calls[0].body).toMatchObject({ chat_id: "-100555", photo: "https://pbs.twimg.com/media/a.jpg" });
    expect(res.url).toBe("https://t.me/c/555/5");
  });

  it("uses the overridden chatId for sendMediaGroup and the reply message", async () => {
    const calls: { url: string; body: any }[] = [];
    const fn = (async (url: string, init?: any) => { const u = String(url); calls.push({ url: u, body: JSON.parse(init.body) });
      const result = u.includes("sendMediaGroup") ? [{ message_id: 5 }] : { message_id: 6 };
      return { ok: true, status: 200, json: async () => ({ result }), text: async () => "" } as Response; }) as unknown as typeof fetch;
    await new TelegramBotSender("T", fn).send({ itemId: "x:1", type: "x", channel: "telegram", segments: ["본문"], photos: ["https://pbs.twimg.com/media/a.jpg", "https://pbs.twimg.com/media/b.jpg"], chatId: "-100555" });
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
    await new TelegramBotSender("TOK", fn).send({ itemId: "x:1", type: "announcement", channel: "telegram", segments: ["A", "B"], chatId: "-100777" });
    expect(calls[0].body).toMatchObject({ chat_id: "-100777" });
    expect(calls[1].body).toMatchObject({ chat_id: "-100777", reply_to_message_id: 11 });
  });
});

describe("TelegramBotSender media", () => {
  it("one photo + short text → sendPhoto with the text as caption, no separate sendMessage", async () => {
    const calls: { url: string; body: any }[] = [];
    const fn = (async (url: string, init?: any) => { calls.push({ url: String(url), body: JSON.parse(init.body) });
      return { ok: true, status: 200, json: async () => ({ result: { message_id: 5 } }), text: async () => "" } as Response; }) as unknown as typeof fetch;
    await new TelegramBotSender("T", fn).send({ itemId: "x:1", type: "announcement", channel: "telegram", segments: ["짧은 공지"], photos: ["https://pbs.twimg.com/media/a.jpg"] , chatId: "-100999"});
    expect(calls).toHaveLength(1);
    expect(calls[0].url).toContain("/sendPhoto");
    expect(calls[0].body).toMatchObject({ photo: "https://pbs.twimg.com/media/a.jpg", caption: "짧은 공지" });
  });

  it("two photos → sendMediaGroup, then the text as a reply message", async () => {
    const calls: { url: string; body: any }[] = [];
    const fn = (async (url: string, init?: any) => { const u = String(url); calls.push({ url: u, body: JSON.parse(init.body) });
      const result = u.includes("sendMediaGroup") ? [{ message_id: 5 }] : { message_id: 6 };
      return { ok: true, status: 200, json: async () => ({ result }), text: async () => "" } as Response; }) as unknown as typeof fetch;
    await new TelegramBotSender("T", fn).send({ itemId: "x:1", type: "x", channel: "telegram", segments: ["본문"], photos: ["https://pbs.twimg.com/media/a.jpg", "https://pbs.twimg.com/media/b.jpg"] , chatId: "-100999"});
    expect(calls[0].url).toContain("/sendMediaGroup");
    expect(calls[0].body.media).toHaveLength(2);
    expect(calls[0].body.media[0]).toMatchObject({ type: "photo", media: "https://pbs.twimg.com/media/a.jpg" });
    expect(calls[1].url).toContain("/sendMessage");
    expect(calls[1].body).toMatchObject({ text: "본문", reply_to_message_id: 5 });
  });

  it("no photos → sendMessage only (unchanged)", async () => {
    const calls: string[] = [];
    const fn = (async (url: string) => { calls.push(String(url)); return { ok: true, status: 200, json: async () => ({ result: { message_id: 1 } }), text: async () => "" } as Response; }) as unknown as typeof fetch;
    await new TelegramBotSender("T", fn).send({ itemId: "x:1", type: "x", channel: "telegram", segments: ["a", "b"] , chatId: "-100999"});
    expect(calls.every((u) => u.includes("/sendMessage"))).toBe(true);
    expect(calls).toHaveLength(2);
  });
});

describe("TelegramBotSender pins the message that carries the text", () => {
  const req = (o: Partial<Parameters<TelegramBotSender["send"]>[0]>) => ({
    itemId: "x:1", type: "announcement" as const, channel: "telegram" as const,
    segments: ["A"], chatId: "-100999", pin: true, ...o,
  });
  const pinCalls = (calls: { url: string; body: unknown }[]) =>
    calls.filter((c) => c.url.includes("/pinChatMessage"));

  it("pins the only message of a text-only send, silently", async () => {
    const { fn, calls } = fakeFetch([
      { ok: true, status: 200, body: { result: { message_id: 11 } } },
      { ok: true, status: 200, body: { result: true } },
    ]);
    const res = await new TelegramBotSender("TOK", fn).send(req({}));
    expect(pinCalls(calls)).toHaveLength(1);
    expect(pinCalls(calls)[0].body).toEqual({ chat_id: "-100999", message_id: 11, disable_notification: true });
    expect(res.warning).toBeUndefined();
  });

  it("pins the FIRST segment only, when the text goes out in two", async () => {
    const { fn, calls } = fakeFetch([
      { ok: true, status: 200, body: { result: { message_id: 11 } } },
      { ok: true, status: 200, body: { result: { message_id: 12 } } },
      { ok: true, status: 200, body: { result: true } },
    ]);
    await new TelegramBotSender("TOK", fn).send(req({ segments: ["A", "B"] }));
    expect(pinCalls(calls)).toHaveLength(1);
    expect(pinCalls(calls)[0].body).toMatchObject({ message_id: 11 });
  });

  it("pins the photo when the whole text went out as its caption", async () => {
    const { fn, calls } = fakeFetch([
      { ok: true, status: 200, body: { result: { message_id: 21 } } },
      { ok: true, status: 200, body: { result: true } },
    ]);
    await new TelegramBotSender("TOK", fn).send(req({ photos: ["https://img/1.png"] }));
    expect(calls[0].url).toContain("/sendPhoto");
    expect(pinCalls(calls)).toHaveLength(1);
    expect(pinCalls(calls)[0].body).toMatchObject({ message_id: 21 });
  });

  /**
   * The album is what `firstId` — and so the row's t.me link — points at, and it is deliberately
   * NOT what gets pinned: a pinned album reads as "Photo" in the room's pinned bar.
   */
  it("pins the text reply, not the album, on a media-group send", async () => {
    const { fn, calls } = fakeFetch([
      { ok: true, status: 200, body: { result: [{ message_id: 31 }, { message_id: 32 }] } },
      { ok: true, status: 200, body: { result: { message_id: 33 } } },
      { ok: true, status: 200, body: { result: true } },
    ]);
    const res = await new TelegramBotSender("TOK", fn).send(req({ photos: ["https://img/1.png", "https://img/2.png"] }));
    expect(calls[0].url).toContain("/sendMediaGroup");
    expect(pinCalls(calls)[0].body).toMatchObject({ message_id: 33 });
    expect(res.url).toBe("https://t.me/c/999/31"); // the link still points at the album
  });

  it("does not call pinChatMessage at all when the send did not ask for it", async () => {
    const { fn, calls } = fakeFetch([{ ok: true, status: 200, body: { result: { message_id: 11 } } }]);
    await new TelegramBotSender("TOK", fn).send(req({ pin: false }));
    expect(pinCalls(calls)).toHaveLength(0);
  });

  /**
   * `textId ?? firstId` in the sender: with no text-bearing message at all (an image-only send),
   * the pin must still target something — the photo, via the `firstId` fallback — rather than being
   * silently skipped. Mutating that fallback away (`textId` alone) would leave this the only test
   * that notices, since every other pin test sends at least one text segment.
   */
  it("pins the photo via the firstId fallback when the send carries no text at all", async () => {
    const { fn, calls } = fakeFetch([
      { ok: true, status: 200, body: { result: { message_id: 41 } } }, // sendPhoto
      { ok: true, status: 200, body: { result: true } }, // pinChatMessage
    ]);
    await new TelegramBotSender("TOK", fn).send(req({ segments: [], photos: ["https://img/1.png"] }));
    expect(calls[0].url).toContain("/sendPhoto");
    expect(pinCalls(calls)).toHaveLength(1);
    expect(pinCalls(calls)[0].body).toMatchObject({ message_id: 41 });
  });

  /**
   * `pinTargetId` can be undefined even when a message clearly went out, if Telegram's reply simply
   * carries no `message_id`. Skipping the pin silently there is indistinguishable from the checkbox
   * never having been ticked — the operator gets no pin and no explanation.
   */
  it("warns instead of silently doing nothing when Telegram returns no message id to pin", async () => {
    const { fn, calls } = fakeFetch([{ ok: true, status: 200, body: { result: {} } }]); // no message_id
    const res = await new TelegramBotSender("TOK", fn).send(req({}));
    expect(pinCalls(calls)).toHaveLength(0); // nothing to pin — pinChatMessage is never called
    expect(res.warning).toContain("고정하지 못했습니다");
    expect(res.warning).toContain("메시지 ID");
  });

  /**
   * A hung pin request (what `AbortSignal.timeout` turns into) rejects the fetch call itself, rather
   * than resolving with a non-ok response — a different failure shape from the other pin tests here,
   * and the one an abort actually produces.
   */
  it("keeps a REJECTING pin fetch out of the send: resolves, warns, reports the post", async () => {
    let calls = 0;
    const fn = (async () => {
      calls += 1;
      if (calls === 1) {
        return { ok: true, status: 200, json: async () => ({ result: { message_id: 11 } }), text: async () => "" } as Response;
      }
      throw new Error("This operation was aborted"); // what AbortSignal.timeout produces on fetch
    }) as unknown as typeof fetch;
    const res = await new TelegramBotSender("TOK", fn).send(req({}));
    expect(res.postId).toBe("11");
    expect(res.warning).toContain("고정하지 못했습니다");
  });

  /**
   * The post is already in the room. Throwing here would make `SendChannels` count the item as
   * failed and skip the ledger write, and the next run would post it a second time.
   */
  it("keeps a failed pin out of the send: resolves, warns, reports the post", async () => {
    const { fn } = fakeFetch([
      { ok: true, status: 200, body: { result: { message_id: 11 } } },
      { ok: false, status: 400, body: { description: "not enough rights to pin a message" } },
    ]);
    const res = await new TelegramBotSender("TOK", fn).send(req({}));
    expect(res.postId).toBe("11");
    expect(res.warning).toContain("고정하지 못했습니다");
    expect(res.warning).toContain("관리자");
  });
});
