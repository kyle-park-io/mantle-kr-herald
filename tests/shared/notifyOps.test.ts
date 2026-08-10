// tests/shared/notifyOps.test.ts — fetch is injected as notifyOps's second (test-only) parameter
// rather than stubbing the global, matching how TelegramBotSender is tested
// (tests/adapters/send/telegramBotSender.test.ts's own fakeFetch).
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { notifyOps } from "../../src/shared/notifyOps";
import { escapeTelegramHtml } from "../../src/shared/opsAlertGrammar";

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

  it("sends HTML and retries once as plain text when Telegram rejects it", async () => {
    // Reject-then-accept, not reject-then-reject: a fetchFn that rejects every call proves only that
    // the retry is ATTEMPTED, not that it DELIVERS — the same distinction
    // tests/deploy/notifyFailure.test.ts's own "lands the retry: rejects the HTML attempt, accepts
    // the plain one" test draws on the bash side, via STUB_CURL_EXITS="22 0". Driving the second
    // call to succeed here and asserting on its shape is what proves the retry lands on this side too.
    process.env.TELEGRAM_BOT_TOKEN = "t";
    process.env.TELEGRAM_CHAT_ID_OPS = "c";
    const calls: Array<Record<string, unknown>> = [];
    const fetchFn = (async (_url: string, init: RequestInit) => {
      const body = JSON.parse(String(init.body)) as Record<string, unknown>;
      calls.push(body);
      return { ok: calls.length > 1, status: calls.length > 1 ? 200 : 400 } as Response;
    }) as unknown as typeof fetch;

    await notifyOps("ℹ t\n<pre>a &lt;b&gt;</pre>", fetchFn);

    expect(calls).toHaveLength(2);
    expect(calls[0].parse_mode).toBe("HTML");
    expect(calls[1].parse_mode).toBeUndefined();
    expect(String(calls[1].text)).not.toContain("<pre>");
    expect(String(calls[1].text)).toContain("a <b>");
  });

  it("round-trips a fixture carrying <, >, & and a literal &lt; through escape then retry-unescape, exactly", async () => {
    // The escape order is load-bearing in both directions. escapeTelegramHtml (opsAlertGrammar.ts)
    // must run & first; notifyOps's plain-text retry must un-escape in the REVERSE order (&lt;/&gt;
    // before &amp;), or a source string that literally contained "&lt;" comes back wrong. A fixture
    // without entities in it cannot catch either direction being wrong — this one has all three
    // escaped characters plus a literal "&lt;" to catch exactly that.
    process.env.TELEGRAM_BOT_TOKEN = "t";
    process.env.TELEGRAM_CHAT_ID_OPS = "c";
    const fixture = "<x> & &lt; <y>";
    const escaped = escapeTelegramHtml(fixture);
    expect(escaped).toBe("&lt;x&gt; &amp; &amp;lt; &lt;y&gt;"); // sanity: the escape direction itself
    const text = `ℹ 제목\n<pre>${escaped}</pre>`;

    const calls: Array<Record<string, unknown>> = [];
    const fetchFn = (async (_url: string, init: RequestInit) => {
      const body = JSON.parse(String(init.body)) as Record<string, unknown>;
      calls.push(body);
      return { ok: calls.length > 1, status: calls.length > 1 ? 200 : 400 } as Response;
    }) as unknown as typeof fetch;

    await notifyOps(text, fetchFn);

    expect(calls).toHaveLength(2);
    // Exact equality, not a substring check: a partial round trip (e.g. the literal &lt; surviving
    // as &lt; instead of coming back to <) would still pass a toContain("<x>") check.
    expect(calls[1].text).toBe(`ℹ 제목\n${fixture}`);
  });

  it("does not retry a thrown network error — only an HTTP-level rejection from Telegram", async () => {
    // The bash side gates its retry on curl exit 22 specifically (an HTTP status >= 400 — a response
    // was received and Telegram said no), never on exit 6 (DNS), 28 (timeout) or 127 (curl missing):
    // retrying those doubles the hang against the hook's own deadline and can duplicate an alert
    // Telegram already accepted. The fetch equivalent of exit 22 is `res.ok === false`; the
    // equivalent of 6/28/127 is fetchFn's promise REJECTING rather than resolving. This pins that a
    // thrown/rejected fetchFn — a network failure, not an HTTP rejection — gets exactly one attempt.
    process.env.TELEGRAM_BOT_TOKEN = "t";
    process.env.TELEGRAM_CHAT_ID_OPS = "c";
    let callCount = 0;
    const fetchFn = (async () => {
      callCount++;
      throw new Error("getaddrinfo ENOTFOUND api.telegram.org");
    }) as unknown as typeof fetch;

    await expect(notifyOps("ℹ t", fetchFn)).resolves.toBeUndefined();
    expect(callCount).toBe(1);
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
