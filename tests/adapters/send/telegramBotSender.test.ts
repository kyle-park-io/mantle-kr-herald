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
