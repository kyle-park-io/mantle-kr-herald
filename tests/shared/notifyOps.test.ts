// tests/shared/notifyOps.test.ts — fetch is injected as notifyOps's second (test-only) parameter
// rather than stubbing the global, matching how TelegramBotSender is tested
// (tests/adapters/send/telegramBotSender.test.ts's own fakeFetch).
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { notifyOps } from "../../src/shared/notifyOps";

function fakeFetch(responses: { ok: boolean; status: number; body?: unknown }[]) {
  const calls: { url: string; body: unknown }[] = [];
  let i = 0;
  const fn = (async (url: string, init?: { body?: string }) => {
    calls.push({ url: String(url), body: init?.body ? JSON.parse(init.body) : undefined });
    const r = responses[Math.min(i++, responses.length - 1)];
    return { ok: r.ok, status: r.status, json: async () => r.body ?? {}, text: async () => JSON.stringify(r.body ?? {}) } as Response;
  }) as unknown as typeof fetch;
  return { fn, calls };
}

const ORIGINAL_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const ORIGINAL_CHAT_ID = process.env.TELEGRAM_CHAT_ID_OPS;

beforeEach(() => {
  delete process.env.TELEGRAM_BOT_TOKEN;
  delete process.env.TELEGRAM_CHAT_ID_OPS;
});

afterEach(() => {
  if (ORIGINAL_TOKEN === undefined) delete process.env.TELEGRAM_BOT_TOKEN;
  else process.env.TELEGRAM_BOT_TOKEN = ORIGINAL_TOKEN;
  if (ORIGINAL_CHAT_ID === undefined) delete process.env.TELEGRAM_CHAT_ID_OPS;
  else process.env.TELEGRAM_CHAT_ID_OPS = ORIGINAL_CHAT_ID;
});

describe("notifyOps", () => {
  it("posts to the bot API when both env vars are set", async () => {
    process.env.TELEGRAM_BOT_TOKEN = "TOK";
    process.env.TELEGRAM_CHAT_ID_OPS = "-100999";
    const { fn, calls } = fakeFetch([{ ok: true, status: 200, body: { result: true } }]);

    await notifyOps("3 translations retired: x:1, x:2, x:3", fn);

    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe("https://api.telegram.org/botTOK/sendMessage");
    expect(calls[0].body).toMatchObject({ chat_id: "-100999", text: "3 translations retired: x:1, x:2, x:3" });
  });

  it("does nothing and does not throw when either env var is missing", async () => {
    // Mirrors herald-notify-failure.sh's own gate: BOTH TELEGRAM_BOT_TOKEN and
    // TELEGRAM_CHAT_ID_OPS must be set, or nothing is sent — no partial-config send.
    const { fn: fnNoChat, calls: callsNoChat } = fakeFetch([{ ok: true, status: 200 }]);
    process.env.TELEGRAM_BOT_TOKEN = "TOK";
    delete process.env.TELEGRAM_CHAT_ID_OPS;
    await expect(notifyOps("x", fnNoChat)).resolves.toBeUndefined();
    expect(callsNoChat).toHaveLength(0);

    const { fn: fnNoToken, calls: callsNoToken } = fakeFetch([{ ok: true, status: 200 }]);
    delete process.env.TELEGRAM_BOT_TOKEN;
    process.env.TELEGRAM_CHAT_ID_OPS = "-100999";
    await expect(notifyOps("x", fnNoToken)).resolves.toBeUndefined();
    expect(callsNoToken).toHaveLength(0);
  });

  it("says on stdout that it sent, so the journal answers 'did the alert go out?' directly", async () => {
    // Before this, only the FAILURE path logged. Answering "did the alert go out?" then took a
    // three-step deduction — env vars are set, the threshold was met, and no failure line appears,
    // therefore it sent — run against a journal by a human who should not have to do that. A
    // successful send now says so.
    process.env.TELEGRAM_BOT_TOKEN = "TOK";
    process.env.TELEGRAM_CHAT_ID_OPS = "-100999";
    const { fn } = fakeFetch([{ ok: true, status: 200, body: { result: true } }]);
    const lines: string[] = [];
    const spy = vi.spyOn(console, "log").mockImplementation((m: unknown) => void lines.push(String(m)));

    await notifyOps("3 translations retired: x:1, x:2, x:3", fn);

    spy.mockRestore();
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatch(/^\[notifyOps\] sent to ops chat -100999$/);
  });

  it("says on stdout that no ops chat is configured, so a silent install is not mistaken for a sent alert", async () => {
    // An unconfigured install and a successful send used to look identical in the journal: both
    // silent. They call for opposite responses, so they must not read the same.
    process.env.TELEGRAM_BOT_TOKEN = "TOK";
    delete process.env.TELEGRAM_CHAT_ID_OPS;
    const { fn, calls } = fakeFetch([{ ok: true, status: 200 }]);
    const lines: string[] = [];
    const spy = vi.spyOn(console, "log").mockImplementation((m: unknown) => void lines.push(String(m)));

    await notifyOps("x", fn);

    spy.mockRestore();
    expect(calls).toHaveLength(0);
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatch(/TELEGRAM_CHAT_ID_OPS/);
    expect(lines[0]).toMatch(/not sent/);
  });

  it("swallows a failing request", async () => {
    // An alert must never fail the run that raised it — neither a network-level rejection...
    process.env.TELEGRAM_BOT_TOKEN = "TOK";
    process.env.TELEGRAM_CHAT_ID_OPS = "-100999";
    const rejecting = (async () => {
      throw new Error("network down");
    }) as unknown as typeof fetch;
    await expect(notifyOps("x", rejecting)).resolves.toBeUndefined();

    // ...nor an HTTP-level rejection from Telegram itself (bad token, bad chat id, ...).
    const { fn: badResponse } = fakeFetch([{ ok: false, status: 401, body: { description: "Unauthorized" } }]);
    await expect(notifyOps("x", badResponse)).resolves.toBeUndefined();
  });
});
