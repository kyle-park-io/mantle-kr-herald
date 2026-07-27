# §8 Channel Delivery (Telegram bot + Typefully) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** `pnpm send:channels [--target telegram|x|both] [--ids …]` sends each approved channel rendering to its real channel — Telegram via the Bot API, X via Typefully — idempotently, and records the result to the Sheet `history` tab (best-effort) so §9b has data.

**Architecture:** A `ChannelSender` port with two adapters (`TelegramBotSender`, `TypefullySender`), a `SendChannels` use-case that reads approved renderings from the existing `FormattingStore`, emits each channel's API-destination spelling with the existing `emit()`, sends, and writes a local idempotency ledger (`output/publish/channels.json`). Mirrors the `DriveUploader`/`resolveTargets`/`createUploaders` pattern. Works in any storage mode; history recording is the cloud-only add-on.

**Tech Stack:** TypeScript (ESM, `tsx`), Node built-ins + `fetch`, `zod` (optional response parsing), `vitest`. No new runtime dependencies.

Spec: `docs/superpowers/specs/2026-07-27-channel-delivery-design.md`

## Global Constraints

- **Runtime deps stay zod-only.** HTTP via `fetch`; senders take an injected `fetch` for tests.
- **Works in any storage mode.** Channel senders need only their own tokens — `send:channels` is **not** `skipIfLocal`-gated. History recording (`RecordPublish`) is cloud-only and best-effort.
- **Never double-post.** A local ledger `output/publish/channels.json` (row per `(itemId, type, channel)`) gates every send; a **succeeded** send is ledgered so it never repeats, a **failed** send is NOT ledgered so it retries.
- **X goes through Typefully only.** No official X API, no twitterapi.io write (ban-risk decision).
- **Public repo:** tokens live only in `.env`; tests use synthetic data + an injected `fetch`, never a live call or a real token. Adding an env var requires the companion update (`.env.example` + its `[…]` tag; `tests/config/envExample.test.ts` enforces it).
- **Follow existing patterns:** pure domain in `src/domain/`; adapters with injected `fetch` like `GoogleSheetClient`; the CLI + `channelSenders.ts` mirror `uploaders.ts`; `emit()`/`FormattingStore`/`RecordPublish` are reused, not reimplemented.
- **Every test must be able to fail** (mutation-check assertions).

---

### Task 1: Send domain + `ChannelSender` port

**Files:**
- Create: `src/domain/send/channels.ts`
- Create: `src/ports/ChannelSender.ts`
- Test: `tests/domain/send/channels.test.ts`

**Interfaces:**
- Produces:
  - `type SendableChannel = "telegram" | "x"`
  - `const DELIVERY_DESTINATION: Record<SendableChannel, Destination>` = `{ telegram: "telegram_bot", x: "x_typefully" }`
  - `interface ChannelSentEntry { itemId: string; type: string; channel: SendableChannel; postId?: string; url?: string; senderName: string; sentAt: string }`
  - `sentKey(e): string` → `${itemId}:${type}:${channel}`
  - `interface SendRequest { itemId: string; type: string; channel: SendableChannel; segments: string[] }`
  - `interface SendResult { postId?: string; url?: string }`
  - `interface ChannelSender { send(req: SendRequest): Promise<SendResult>; readonly name: string }`

- [ ] **Step 1: Write the failing test**

```ts
import { describe, it, expect } from "vitest";
import { DELIVERY_DESTINATION, sentKey } from "../../../src/domain/send/channels";

describe("send domain", () => {
  it("maps each sendable channel to its API destination", () => {
    expect(DELIVERY_DESTINATION.telegram).toBe("telegram_bot");
    expect(DELIVERY_DESTINATION.x).toBe("x_typefully");
  });
  it("keys a sent entry by itemId:type:channel", () => {
    expect(sentKey({ itemId: "x:1", type: "announcement", channel: "telegram" })).toBe("x:1:announcement:telegram");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm test -- tests/domain/send/channels.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Write minimal implementation**

```ts
// src/domain/send/channels.ts
import type { Destination } from "../formatting/emitters";

export type SendableChannel = "telegram" | "x";

/** The API-delivery destination a sender transports for each channel (vs the human copy-paste one). */
export const DELIVERY_DESTINATION: Record<SendableChannel, Destination> = {
  telegram: "telegram_bot",
  x: "x_typefully",
};

export interface ChannelSentEntry {
  itemId: string;
  type: string;
  channel: SendableChannel;
  postId?: string;
  url?: string;
  senderName: string;
  sentAt: string;
}

export function sentKey(e: Pick<ChannelSentEntry, "itemId" | "type" | "channel">): string {
  return `${e.itemId}:${e.type}:${e.channel}`;
}
```

```ts
// src/ports/ChannelSender.ts
import type { SendableChannel } from "../domain/send/channels";

export interface SendRequest {
  itemId: string;
  type: string;
  channel: SendableChannel;
  /** Per-post strings already spelled for the delivery destination by emit(). */
  segments: string[];
}

export interface SendResult {
  postId?: string;
  url?: string;
}

export interface ChannelSender {
  /** Deliver the segments. Throws on an API error — the use-case isolates that per item. */
  send(req: SendRequest): Promise<SendResult>;
  readonly name: string; // "telegram" | "x" — stable key for the ledger + reporting
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm test -- tests/domain/send/channels.test.ts`
Expected: PASS.
Run: `pnpm typecheck`
Expected: clean (`Destination` imported from `src/domain/formatting/emitters`).

- [ ] **Step 5: Commit**

```bash
git add src/domain/send/channels.ts src/ports/ChannelSender.ts tests/domain/send/channels.test.ts
git commit -m "feat(send): channel-delivery domain types + ChannelSender port"
```

---

### Task 2: `TelegramBotSender`

**Files:**
- Create: `src/adapters/send/TelegramBotSender.ts`
- Test: `tests/adapters/send/telegramBotSender.test.ts`

**Interfaces:**
- Consumes: `ChannelSender`, `SendRequest`, `SendResult` (Task 1).
- Produces: `new TelegramBotSender(token: string, chatId: string, fetchFn?: typeof fetch)` — `name = "telegram"`.

- [ ] **Step 1: Write the failing test**

```ts
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
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm test -- tests/adapters/send/telegramBotSender.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Write minimal implementation**

```ts
// src/adapters/send/TelegramBotSender.ts
import type { ChannelSender, SendRequest, SendResult } from "../../ports/ChannelSender";

const API = "https://api.telegram.org";

export class TelegramBotSender implements ChannelSender {
  readonly name = "telegram";
  constructor(
    private readonly token: string,
    private readonly chatId: string,
    private readonly fetchFn: typeof fetch = fetch,
  ) {}

  async send(req: SendRequest): Promise<SendResult> {
    let firstId: number | undefined;
    for (const text of req.segments) {
      const body: Record<string, unknown> = { chat_id: this.chatId, text, parse_mode: "HTML" };
      if (firstId !== undefined) body.reply_to_message_id = firstId;
      const res = await this.fetchFn(`${API}/bot${this.token}/sendMessage`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      if (!res.ok) {
        const detail = await res.text().catch(() => "");
        throw new Error(`Telegram sendMessage failed: HTTP ${res.status}${detail ? ` — ${detail}` : ""}`);
      }
      const data = (await res.json()) as { result?: { message_id?: number } };
      const id = data.result?.message_id;
      if (firstId === undefined && typeof id === "number") firstId = id;
    }
    // A channel chat_id is "-100<internal>"; its post link is t.me/c/<internal>/<message_id>.
    const url =
      firstId !== undefined && this.chatId.startsWith("-100")
        ? `https://t.me/c/${this.chatId.slice(4)}/${firstId}`
        : undefined;
    return { postId: firstId !== undefined ? String(firstId) : undefined, url };
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm test -- tests/adapters/send/telegramBotSender.test.ts`
Expected: PASS (2 tests).

- [ ] **Step 5: Commit**

```bash
git add src/adapters/send/TelegramBotSender.ts tests/adapters/send/telegramBotSender.test.ts
git commit -m "feat(send): TelegramBotSender — HTML sendMessage per segment"
```

---

### Task 3: `TypefullySender`

**Files:**
- Create: `src/adapters/send/TypefullySender.ts`
- Test: `tests/adapters/send/typefullySender.test.ts`

**Interfaces:**
- Consumes: `ChannelSender`, `SendRequest`, `SendResult` (Task 1).
- Produces: `new TypefullySender(apiKey: string, socialSetId: string, fetchFn?: typeof fetch, sleep?: (ms: number) => Promise<void>)` — `name = "x"`.

- [ ] **Step 1: Write the failing test**

```ts
import { describe, it, expect } from "vitest";
import { TypefullySender } from "../../../src/adapters/send/TypefullySender";

function fakeFetch(responses: { ok: boolean; status: number; body: unknown }[]) {
  const calls: { url: string; method?: string; body: unknown; auth?: string }[] = [];
  let i = 0;
  const fn = (async (url: string, init?: { method?: string; body?: string; headers?: Record<string, string> }) => {
    calls.push({ url: String(url), method: init?.method, body: init?.body ? JSON.parse(init.body) : undefined, auth: init?.headers?.Authorization });
    const r = responses[Math.min(i++, responses.length - 1)];
    return { ok: r.ok, status: r.status, json: async () => r.body, text: async () => JSON.stringify(r.body) } as Response;
  }) as unknown as typeof fetch;
  return { fn, calls };
}
const noSleep = async () => {};

describe("TypefullySender", () => {
  it("creates a draft (posts array = segments, publish now, bearer) and returns the url from the create response", async () => {
    const { fn, calls } = fakeFetch([{ ok: true, status: 200, body: { id: 77, x_published_url: "https://x.com/i/status/1" } }]);
    const res = await new TypefullySender("KEY", "42", fn, noSleep).send({ itemId: "x:1", type: "x", channel: "x", segments: ["a", "b", "c"] });
    expect(calls[0].url).toContain("/v2/social-sets/42/drafts");
    expect(calls[0].method).toBe("POST");
    expect(calls[0].auth).toBe("Bearer KEY");
    expect((calls[0].body as any).platforms.x.posts).toEqual([{ text: "a" }, { text: "b" }, { text: "c" }]);
    expect((calls[0].body as any).publish_at).toBe("now");
    expect(res).toEqual({ postId: "77", url: "https://x.com/i/status/1" });
  });

  it("polls the draft for x_published_url when the create response lacks it", async () => {
    const { fn } = fakeFetch([
      { ok: true, status: 200, body: { id: 77 } },
      { ok: true, status: 200, body: {} },
      { ok: true, status: 200, body: { x_published_url: "https://x.com/i/status/9" } },
    ]);
    const res = await new TypefullySender("KEY", "42", fn, noSleep).send({ itemId: "x:1", type: "x", channel: "x", segments: ["a"] });
    expect(res).toEqual({ postId: "77", url: "https://x.com/i/status/9" });
  });

  it("returns the draft id without a url when the poll never resolves", async () => {
    const { fn } = fakeFetch([{ ok: true, status: 200, body: { id: 77 } }, { ok: true, status: 200, body: {} }]);
    const res = await new TypefullySender("KEY", "42", fn, noSleep).send({ itemId: "x:1", type: "x", channel: "x", segments: ["a"] });
    expect(res).toEqual({ postId: "77", url: undefined });
  });

  it("throws on a non-ok create", async () => {
    const { fn } = fakeFetch([{ ok: false, status: 401, body: { detail: "bad key" } }]);
    await expect(new TypefullySender("KEY", "42", fn, noSleep).send({ itemId: "x:1", type: "x", channel: "x", segments: ["a"] }))
      .rejects.toThrow(/401/);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm test -- tests/adapters/send/typefullySender.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Write minimal implementation**

```ts
// src/adapters/send/TypefullySender.ts
import type { ChannelSender, SendRequest, SendResult } from "../../ports/ChannelSender";

const API = "https://api.typefully.com/v2";
const POLL_ATTEMPTS = 10;
const POLL_DELAY_MS = 1500;

export class TypefullySender implements ChannelSender {
  readonly name = "x";
  constructor(
    private readonly apiKey: string,
    private readonly socialSetId: string,
    private readonly fetchFn: typeof fetch = fetch,
    private readonly sleep: (ms: number) => Promise<void> = (ms) => new Promise((r) => setTimeout(r, ms)),
  ) {}

  private headers(): Record<string, string> {
    return { Authorization: `Bearer ${this.apiKey}`, "Content-Type": "application/json" };
  }

  async send(req: SendRequest): Promise<SendResult> {
    const create = await this.fetchFn(`${API}/social-sets/${this.socialSetId}/drafts`, {
      method: "POST",
      headers: this.headers(),
      body: JSON.stringify({
        platforms: { x: { enabled: true, posts: req.segments.map((text) => ({ text })) } },
        publish_at: "now",
      }),
    });
    if (!create.ok) {
      const detail = await create.text().catch(() => "");
      throw new Error(`Typefully create draft failed: HTTP ${create.status}${detail ? ` — ${detail}` : ""}`);
    }
    const draft = (await create.json()) as { id?: number | string; x_published_url?: string };
    const draftId = draft.id !== undefined ? String(draft.id) : undefined;
    if (draft.x_published_url) return { postId: draftId, url: draft.x_published_url };

    // publish_at:"now" can be async — poll the draft for the published url.
    for (let i = 0; i < POLL_ATTEMPTS && draftId; i++) {
      await this.sleep(POLL_DELAY_MS);
      const res = await this.fetchFn(`${API}/social-sets/${this.socialSetId}/drafts/${draftId}`, { headers: this.headers() });
      if (!res.ok) continue;
      const d = (await res.json()) as { x_published_url?: string };
      if (d.x_published_url) return { postId: draftId, url: d.x_published_url };
    }
    // Created but the url was not confirmed in the poll window — still a real post; report the id.
    return { postId: draftId, url: undefined };
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm test -- tests/adapters/send/typefullySender.test.ts`
Expected: PASS (4 tests).

- [ ] **Step 5: Commit**

```bash
git add src/adapters/send/TypefullySender.ts tests/adapters/send/typefullySender.test.ts
git commit -m "feat(send): TypefullySender — publish a thread draft now, poll for the X url"
```

---

### Task 4: `JsonChannelLedger`

**Files:**
- Create: `src/adapters/store/JsonChannelLedger.ts`
- Test: `tests/adapters/jsonChannelLedger.test.ts`

**Interfaces:**
- Consumes: `ChannelSentEntry`, `sentKey` (Task 1).
- Produces: `new JsonChannelLedger(dir)` with `loadKeys(): Promise<Set<string>>` and `add(entry): Promise<void>` (upsert by `sentKey`, at `dir/channels.json`).

- [ ] **Step 1: Write the failing test**

```ts
import { describe, it, expect } from "vitest";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { JsonChannelLedger } from "../../src/adapters/store/JsonChannelLedger";
import type { ChannelSentEntry } from "../../src/domain/send/channels";

const entry = (overrides: Partial<ChannelSentEntry> = {}): ChannelSentEntry => ({
  itemId: "x:1", type: "announcement", channel: "telegram", postId: "11", url: "u", senderName: "telegram", sentAt: "2026-07-27T00:00:00Z", ...overrides,
});

describe("JsonChannelLedger", () => {
  it("records a sent key and reports it, upserting by (itemId,type,channel)", async () => {
    const dir = await mkdtemp(join(tmpdir(), "chled-"));
    const ledger = new JsonChannelLedger(dir);
    expect(await ledger.loadKeys()).toEqual(new Set());
    await ledger.add(entry());
    await ledger.add(entry({ postId: "22" })); // same key → upsert, not a second row
    const keys = await ledger.loadKeys();
    expect(keys.has("x:1:announcement:telegram")).toBe(true);
    expect(keys.size).toBe(1);
    await ledger.add(entry({ channel: "x" }));
    expect((await ledger.loadKeys()).size).toBe(2);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm test -- tests/adapters/jsonChannelLedger.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Write minimal implementation**

```ts
// src/adapters/store/JsonChannelLedger.ts
import { join } from "node:path";
import type { ChannelSentEntry } from "../../domain/send/channels";
import { sentKey } from "../../domain/send/channels";
import { readJsonFile, writeJsonFileAtomic } from "../../shared/store/jsonFile";

export class JsonChannelLedger {
  private readonly path: string;
  constructor(private readonly dir: string) {
    this.path = join(dir, "channels.json");
  }
  private load(): Promise<ChannelSentEntry[]> {
    return readJsonFile<ChannelSentEntry[]>(this.path, []);
  }
  async loadKeys(): Promise<Set<string>> {
    return new Set((await this.load()).map(sentKey));
  }
  async add(entry: ChannelSentEntry): Promise<void> {
    const byKey = new Map((await this.load()).map((e) => [sentKey(e), e]));
    byKey.set(sentKey(entry), entry);
    await writeJsonFileAtomic(this.dir, this.path, [...byKey.values()]);
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm test -- tests/adapters/jsonChannelLedger.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/adapters/store/JsonChannelLedger.ts tests/adapters/jsonChannelLedger.test.ts
git commit -m "feat(send): JsonChannelLedger — local idempotency ledger for sent posts"
```

---

### Task 5: Config loaders + `.env.example`

**Files:**
- Modify: `src/config.ts`
- Modify: `.env.example`
- Test: `tests/config/channelConfig.test.ts`

**Interfaces:**
- Produces:
  - `interface TelegramConfig { botToken: string; chatId: string }`; `loadTelegramConfig(): TelegramConfig`
  - `interface TypefullyConfig { apiKey: string; socialSetId: string }`; `loadTypefullyConfig(): TypefullyConfig`

- [ ] **Step 1: Write the failing test**

```ts
import { describe, it, expect, afterEach } from "vitest";
import { loadTelegramConfig, loadTypefullyConfig } from "../../src/config";

const saved = { ...process.env };
afterEach(() => {
  process.env = { ...saved };
});

describe("channel config loaders", () => {
  it("loadTelegramConfig returns the token + chat id, throws when either is missing", () => {
    process.env.TELEGRAM_BOT_TOKEN = "T";
    process.env.TELEGRAM_CHAT_ID = "-100";
    expect(loadTelegramConfig()).toEqual({ botToken: "T", chatId: "-100" });
    delete process.env.TELEGRAM_BOT_TOKEN;
    expect(() => loadTelegramConfig()).toThrow(/TELEGRAM_BOT_TOKEN/);
  });
  it("loadTypefullyConfig returns key + social set, throws when either is missing", () => {
    process.env.TYPEFULLY_API_KEY = "K";
    process.env.TYPEFULLY_SOCIAL_SET_ID = "42";
    expect(loadTypefullyConfig()).toEqual({ apiKey: "K", socialSetId: "42" });
    delete process.env.TYPEFULLY_SOCIAL_SET_ID;
    expect(() => loadTypefullyConfig()).toThrow(/TYPEFULLY_SOCIAL_SET_ID/);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm test -- tests/config/channelConfig.test.ts`
Expected: FAIL — loaders not exported.

- [ ] **Step 3: Implement**

Add to `src/config.ts`:

```ts
export interface TelegramConfig {
  botToken: string;
  chatId: string;
}
export function loadTelegramConfig(): TelegramConfig {
  const botToken = process.env.TELEGRAM_BOT_TOKEN;
  const chatId = process.env.TELEGRAM_CHAT_ID;
  if (!botToken) throw new Error("Missing required environment variable: TELEGRAM_BOT_TOKEN");
  if (!chatId) throw new Error("Missing required environment variable: TELEGRAM_CHAT_ID");
  return { botToken, chatId };
}

export interface TypefullyConfig {
  apiKey: string;
  socialSetId: string;
}
export function loadTypefullyConfig(): TypefullyConfig {
  const apiKey = process.env.TYPEFULLY_API_KEY;
  const socialSetId = process.env.TYPEFULLY_SOCIAL_SET_ID;
  if (!apiKey) throw new Error("Missing required environment variable: TYPEFULLY_API_KEY");
  if (!socialSetId) throw new Error("Missing required environment variable: TYPEFULLY_SOCIAL_SET_ID");
  return { apiKey, socialSetId };
}
```

Add to `.env.example` a new section **before** `# ═══ 4. Local tools`, and renumber `Local tools` to `5`:

```
# ═══ 4. Channel delivery (§8) — pnpm send:channels ═══════════════════════════
# Needed in ANY storage mode — these are channel APIs, not cloud Drive. Only for
# the channels you actually send to.

# [REQUIRED for `pnpm send:channels --target telegram`] Bot token from BotFather;
# add the bot to the target channel as an admin. Chat id of that channel
# (e.g. "-1001234567890"). See docs/ko/setup/.
TELEGRAM_BOT_TOKEN=
TELEGRAM_CHAT_ID=

# [REQUIRED for `pnpm send:channels --target x`] Typefully v2 API key
# (typefully.com → Settings → API) and the social_set_id whose X account is
# @0xMantleKR (list them with GET /v2/social-sets).
TYPEFULLY_API_KEY=
TYPEFULLY_SOCIAL_SET_ID=
```

- [ ] **Step 4: Run test + full suite**

Run: `pnpm test -- tests/config/channelConfig.test.ts`
Expected: PASS.
Run: `pnpm test && pnpm typecheck`
Expected: whole suite green (including `tests/config/envExample.test.ts` — the four vars are now documented with `[REQUIRED …]` tags) and typecheck clean.

- [ ] **Step 5: Commit**

```bash
git add src/config.ts .env.example tests/config/channelConfig.test.ts
git commit -m "feat(send): TELEGRAM_* + TYPEFULLY_* config loaders and .env.example"
```

---

### Task 6: `SendChannels` use-case

**Files:**
- Create: `src/app/SendChannels.ts`
- Test: `tests/app/sendChannels.test.ts`

**Interfaces:**
- Consumes: `FormattingStore` (`loadAll`), `ChannelSender` (Task 1), `emit`/`DELIVERY_DESTINATION` (Task 1 + existing), `ChannelSentEntry`/`sentKey` (Task 1), `PublishRecord` (`src/domain/sheet/models.ts` — `{ itemId, type, channel, postId?, url?, status, publishedAt }`).
- Produces:
  - `interface ChannelLedger { loadKeys(): Promise<Set<string>>; add(e: ChannelSentEntry): Promise<void> }`
  - `type Recorder = (rec: PublishRecord) => Promise<void>`
  - `interface SendChannelsInput { targets: SendableChannel[]; ids?: Set<string> }`
  - `interface SendChannelsResult { sent: number; skipped: number; failed: number }`
  - `SendChannels.run(input): Promise<SendChannelsResult>`

- [ ] **Step 1: Write the failing test**

```ts
import { describe, it, expect } from "vitest";
import { SendChannels } from "../../src/app/SendChannels";
import type { FormattingStore } from "../../src/ports/FormattingStore";
import type { ChannelSender } from "../../src/ports/ChannelSender";
import type { ChannelRendering } from "../../src/domain/formatting/models";
import type { ChannelSentEntry } from "../../src/domain/send/channels";
import { sentKey } from "../../src/domain/send/channels";

const rendering = (o: Partial<ChannelRendering>): ChannelRendering => ({
  itemId: "x:1", type: "announcement", channel: "telegram", text: "**hi** everyone", refined: false,
  createdAt: "2026-07-27T00:00:00Z", status: "approved", ...o,
});

function fakeStore(rows: ChannelRendering[]): FormattingStore {
  return { loadAll: async () => rows, upsert: async () => {}, listRenderedKeys: async () => new Set() };
}
function fakeLedger() {
  const keys = new Set<string>();
  const added: ChannelSentEntry[] = [];
  return { ledger: { loadKeys: async () => new Set(keys), add: async (e: ChannelSentEntry) => { keys.add(sentKey(e)); added.push(e); } }, added, keys };
}
const okSender = (name: "telegram" | "x"): ChannelSender => ({ name, send: async () => ({ postId: "p", url: "u" }) });

describe("SendChannels", () => {
  it("sends only approved renderings for the requested channels, and ledgers each", async () => {
    const store = fakeStore([
      rendering({ itemId: "x:1", channel: "telegram", status: "approved" }),
      rendering({ itemId: "x:2", channel: "telegram", status: "rendered" }), // not approved → skip
      rendering({ itemId: "x:3", channel: "kakao", status: "approved" }),    // not a sendable channel → skip
    ]);
    const { ledger, added } = fakeLedger();
    const res = await new SendChannels(store, { telegram: okSender("telegram"), x: undefined }, ledger).run({ targets: ["telegram"] });
    expect(res).toEqual({ sent: 1, skipped: 0, failed: 0 });
    expect(added.map((e) => e.itemId)).toEqual(["x:1"]);
  });

  it("skips a rendering already in the ledger (no second send)", async () => {
    const store = fakeStore([rendering({ itemId: "x:1", channel: "telegram" })]);
    const { ledger } = fakeLedger();
    await ledger.add({ itemId: "x:1", type: "announcement", channel: "telegram", senderName: "telegram", sentAt: "t" });
    let sends = 0;
    const sender: ChannelSender = { name: "telegram", send: async () => { sends++; return {}; } };
    const res = await new SendChannels(store, { telegram: sender, x: undefined }, ledger).run({ targets: ["telegram"] });
    expect(res).toEqual({ sent: 0, skipped: 1, failed: 0 });
    expect(sends).toBe(0);
  });

  it("isolates a failing send and still sends the rest; a best-effort recorder failure does not fail the send", async () => {
    const store = fakeStore([
      rendering({ itemId: "x:1", channel: "telegram" }),
      rendering({ itemId: "x:2", channel: "telegram" }),
    ]);
    const { ledger, added } = fakeLedger();
    const sender: ChannelSender = { name: "telegram", send: async (r) => { if (r.itemId === "x:1") throw new Error("boom"); return { postId: "p" }; } };
    const recorder = async () => { throw new Error("no sheet"); };
    const res = await new SendChannels(store, { telegram: sender, x: undefined }, ledger, recorder).run({ targets: ["telegram"] });
    expect(res).toEqual({ sent: 1, skipped: 0, failed: 1 });
    expect(added.map((e) => e.itemId)).toEqual(["x:2"]); // failed one is NOT ledgered → retryable
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm test -- tests/app/sendChannels.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Write minimal implementation**

```ts
// src/app/SendChannels.ts
import type { FormattingStore } from "../ports/FormattingStore";
import type { ChannelSender } from "../ports/ChannelSender";
import type { ChannelSentEntry, SendableChannel } from "../domain/send/channels";
import { DELIVERY_DESTINATION, sentKey } from "../domain/send/channels";
import { emit } from "../domain/formatting/emitters";
import type { PublishRecord } from "../domain/sheet/models";

export interface ChannelLedger {
  loadKeys(): Promise<Set<string>>;
  add(entry: ChannelSentEntry): Promise<void>;
}
export type Recorder = (rec: PublishRecord) => Promise<void>;

export interface SendChannelsInput {
  targets: SendableChannel[];
  ids?: Set<string>;
}
export interface SendChannelsResult {
  sent: number;
  skipped: number;
  failed: number;
}

function isSendable(c: string): c is SendableChannel {
  return c === "telegram" || c === "x";
}

export class SendChannels {
  constructor(
    private readonly store: FormattingStore,
    private readonly senders: Record<SendableChannel, ChannelSender | undefined>,
    private readonly ledger: ChannelLedger,
    private readonly record?: Recorder,
    private readonly now: () => string = () => new Date().toISOString(),
  ) {}

  async run(input: SendChannelsInput): Promise<SendChannelsResult> {
    const rows = await this.store.loadAll();
    const already = await this.ledger.loadKeys();
    const wanted = new Set<SendableChannel>(input.targets);
    let sent = 0;
    let skipped = 0;
    let failed = 0;

    for (const r of rows) {
      if (r.status !== "approved") continue;
      if (!isSendable(r.channel) || !wanted.has(r.channel)) continue;
      if (input.ids && !input.ids.has(r.itemId)) continue;
      const sender = this.senders[r.channel];
      if (!sender) continue;
      const key = sentKey({ itemId: r.itemId, type: r.type, channel: r.channel });
      if (already.has(key)) {
        skipped += 1;
        continue;
      }
      try {
        const segments = emit(r.text, DELIVERY_DESTINATION[r.channel]).segments.map((s) => s.text);
        const res = await sender.send({ itemId: r.itemId, type: r.type, channel: r.channel, segments });
        const sentAt = this.now();
        await this.ledger.add({ itemId: r.itemId, type: r.type, channel: r.channel, postId: res.postId, url: res.url, senderName: sender.name, sentAt });
        if (this.record) {
          try {
            await this.record({ itemId: r.itemId, type: r.type, channel: r.channel, postId: res.postId, url: res.url, status: "posted", publishedAt: sentAt });
          } catch (err) {
            console.warn(`[send] ${key} sent, but history record failed: ${(err as Error).message}`);
          }
        }
        sent += 1;
      } catch (err) {
        console.warn(`[send] ${key} failed: ${(err as Error).message}`);
        failed += 1;
      }
    }
    return { sent, skipped, failed };
  }
}
```

- [ ] **Step 4: Run test + typecheck**

Run: `pnpm test -- tests/app/sendChannels.test.ts`
Expected: PASS (3 tests).
Run: `pnpm typecheck`
Expected: clean.

- [ ] **Step 5: Commit**

```bash
git add src/app/SendChannels.ts tests/app/sendChannels.test.ts
git commit -m "feat(send): SendChannels — send approved renderings, idempotent, per-item isolation"
```

---

### Task 7: `send:channels` CLI + target selection

**Files:**
- Create: `src/cli/channelSenders.ts`
- Create: `src/cli/recorder.ts`
- Create: `src/cli/send-channels.ts`
- Modify: `package.json` (add `send:channels` script)
- Test: `tests/cli/channelSenders.test.ts`

**Interfaces:**
- Consumes: `TelegramBotSender`/`TypefullySender` (2,3), `loadTelegramConfig`/`loadTypefullyConfig` (5), `SendChannels` (6), `JsonFormattingStore`/`JsonChannelLedger`, `RecordPublish`, `parseList`/`argValue`, `paths`.
- Produces:
  - `const ALL_CHANNEL_TARGETS = ["telegram", "x"] as const`
  - `resolveChannelTargets(raw: string | undefined): SendableChannel[]` (`both` = all; default = all; unknown token throws)
  - `createSenders(targets): Record<SendableChannel, ChannelSender | undefined>`
  - `buildRecorder(): Promise<Recorder | undefined>` (best-effort; `undefined` unless `GSHEET_ID` + Google auth present)

- [ ] **Step 1: Write the failing test**

```ts
import { describe, it, expect } from "vitest";
import { resolveChannelTargets } from "../../src/cli/channelSenders";

describe("resolveChannelTargets", () => {
  it("defaults to all channels", () => {
    expect(resolveChannelTargets(undefined).sort()).toEqual(["telegram", "x"]);
  });
  it("expands 'both' to all channels", () => {
    expect(resolveChannelTargets("both").sort()).toEqual(["telegram", "x"]);
  });
  it("takes an explicit single channel", () => {
    expect(resolveChannelTargets("telegram")).toEqual(["telegram"]);
  });
  it("dedupes and rejects an unknown token", () => {
    expect(resolveChannelTargets("x,x")).toEqual(["x"]);
    expect(() => resolveChannelTargets("kakao")).toThrow(/Unknown channel target/);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm test -- tests/cli/channelSenders.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement**

```ts
// src/cli/channelSenders.ts
import { parseList } from "./args";
import { TelegramBotSender } from "../adapters/send/TelegramBotSender";
import { TypefullySender } from "../adapters/send/TypefullySender";
import { loadTelegramConfig, loadTypefullyConfig } from "../config";
import type { ChannelSender } from "../ports/ChannelSender";
import type { SendableChannel } from "../domain/send/channels";

export const ALL_CHANNEL_TARGETS = ["telegram", "x"] as const;
export const CHANNEL_TARGETS_USAGE = ALL_CHANNEL_TARGETS.join("|");

function isChannelTarget(v: string): v is SendableChannel {
  return (ALL_CHANNEL_TARGETS as readonly string[]).includes(v);
}

/** Expand `--target`. `both` = every channel; default = every channel. */
export function resolveChannelTargets(raw: string | undefined): SendableChannel[] {
  const requested = parseList(raw) ?? ["both"];
  const expanded = requested.flatMap((t) => (t === "both" ? [...ALL_CHANNEL_TARGETS] : [t]));
  const out: SendableChannel[] = [];
  for (const c of expanded) {
    if (!isChannelTarget(c)) throw new Error(`Unknown channel target: ${c} (expected ${CHANNEL_TARGETS_USAGE}, or "both")`);
    if (!out.includes(c)) out.push(c);
  }
  return out;
}

/** Build only the requested senders, so a Typefully-less setup can still send Telegram. */
export function createSenders(targets: SendableChannel[]): Record<SendableChannel, ChannelSender | undefined> {
  const senders: Record<SendableChannel, ChannelSender | undefined> = { telegram: undefined, x: undefined };
  for (const t of targets) {
    if (t === "telegram") {
      const c = loadTelegramConfig();
      senders.telegram = new TelegramBotSender(c.botToken, c.chatId);
    } else {
      const c = loadTypefullyConfig();
      senders.x = new TypefullySender(c.apiKey, c.socialSetId);
    }
  }
  return senders;
}
```

```ts
// src/cli/recorder.ts
import { createGoogleAuth } from "../adapters/drive/createGoogleAuth";
import { GoogleSheetClient } from "../adapters/sheets/GoogleSheetClient";
import { RecordPublish } from "../app/RecordPublish";
import { loadGoogleAuthConfig, loadGoogleSheetConfig } from "../config";
import type { Recorder } from "../app/SendChannels";

/**
 * A best-effort history recorder: undefined unless GSHEET_ID + Google auth are configured, so a send
 * still works with no Sheet. History (§9b) is an add-on, not a prerequisite for delivery.
 */
export async function buildRecorder(): Promise<Recorder | undefined> {
  try {
    const { spreadsheetId } = loadGoogleSheetConfig();
    const auth = await createGoogleAuth(loadGoogleAuthConfig());
    const rp = new RecordPublish(new GoogleSheetClient(auth, spreadsheetId));
    return (rec) => rp.record(rec);
  } catch {
    return undefined;
  }
}
```

```ts
// src/cli/send-channels.ts
import "./registerErrorHandler";
import { argValue } from "./args";
import { paths } from "../paths";
import { JsonFormattingStore } from "../adapters/store/JsonFormattingStore";
import { JsonChannelLedger } from "../adapters/store/JsonChannelLedger";
import { SendChannels } from "../app/SendChannels";
import { resolveChannelTargets, createSenders } from "./channelSenders";
import { buildRecorder } from "./recorder";

const targets = resolveChannelTargets(argValue("--target"));
const senders = createSenders(targets);
const idsArg = argValue("--ids");
const ids = idsArg ? new Set(idsArg.split(",").map((s) => s.trim()).filter((s) => s.length > 0)) : undefined;

const store = new JsonFormattingStore(paths.formattedDir);
const ledger = new JsonChannelLedger(paths.publishDir);
const record = await buildRecorder();

const result = await new SendChannels(store, senders, ledger, record).run({ targets, ids });
console.log(`sent ${result.sent} · skipped ${result.skipped} (already sent) · failed ${result.failed}`);
```

Add to `package.json` scripts:

```json
    "send:channels": "tsx --env-file-if-exists=.env src/cli/send-channels.ts",
```

- [ ] **Step 4: Run test + typecheck + full suite**

Run: `pnpm test -- tests/cli/channelSenders.test.ts`
Expected: PASS (4 tests).
Run: `pnpm typecheck && pnpm test`
Expected: clean + whole suite green.

- [ ] **Step 5: Commit**

```bash
git add src/cli/channelSenders.ts src/cli/recorder.ts src/cli/send-channels.ts package.json tests/cli/channelSenders.test.ts
git commit -m "feat(send): send:channels CLI + target selection + best-effort history recorder"
```

---

### Task 8: Documentation

**Files:**
- Modify: `CHANGELOG.md` (`[Unreleased]` → `### Added`)
- Modify: `docs/ko/capabilities.md`
- Modify: `docs/ko/artifacts.md`
- Modify: `docs/ko/team-runbook.md`

- [ ] **Step 1: Add the CHANGELOG entry**

Under `## [Unreleased]` → `### Added` in `CHANGELOG.md`, add:

```markdown
- **`pnpm send:channels [--target telegram|x|both] [--ids …]` — §8 channel delivery.** Sends each
  approved channel rendering to its real channel: **Telegram** via the Bot API (`sendMessage`, HTML,
  one message per segment, replies chained), **X** via **Typefully** (v2 draft published now, polled
  for the tweet url). Idempotent — a local ledger `output/publish/channels.json` (row per
  `(itemId, type, channel)`) means a succeeded send never repeats and a failed one retries. Works in
  any storage mode (the senders need only their own tokens); recording to the Sheet `history` tab is
  cloud-only and best-effort. X goes through Typefully only — no official X API, no twitterapi.io
  write (ban-risk on the official account). Config: `TELEGRAM_BOT_TOKEN`/`TELEGRAM_CHAT_ID`,
  `TYPEFULLY_API_KEY`/`TYPEFULLY_SOCIAL_SET_ID`. Kakao/mail senders and media are out of scope.
  See `docs/superpowers/specs/2026-07-27-channel-delivery-design.md`.
```

- [ ] **Step 2: Add the artifacts.md I/O row + a capabilities section + a runbook step**

- `docs/ko/artifacts.md` §3 (명령어별 입출력): add a row for `pnpm send:channels [--target telegram\|x\|both] [--ids]` — reads `output/formatted/renderings.json` (status `approved`, channel `telegram`/`x`) minus `output/publish/channels.json` (already sent); `TELEGRAM_*`/`TYPEFULLY_*` env; writes `output/publish/channels.json` (upsert), and best-effort `history` tab in cloud mode; external systems Telegram Bot API / Typefully API (+ Google Sheets when recording). Note it is **not** `skipIfLocal`-gated.
- `docs/ko/capabilities.md`: a section documenting `send:channels` — the flow (승인된 렌더링 → 채널별 sender → 발송 + 멱등 ledger), Telegram=봇/X=Typefully, X는 공식 API/twitterapi 쓰기 대신 Typefully(공식 계정 정지 리스크 회피), 어느 모드에서도 동작. Match the file's Korean voice; no tokens/secrets.
- `docs/ko/team-runbook.md` §2 weekly routine: add发行 step — after 2차 검수 approval, `pnpm send:channels`로 Telegram/X 발행; note the creds prerequisite and that a rerun is safe (idempotent).

- [ ] **Step 3: Verify the docs reference the real command**

Run: `grep -nE 'send:channels|channels\.json' package.json CHANGELOG.md docs/ko/capabilities.md docs/ko/artifacts.md`
Expected: the script in `package.json` and references in all three docs.

- [ ] **Step 4: Commit**

```bash
git add CHANGELOG.md docs/ko/capabilities.md docs/ko/artifacts.md docs/ko/team-runbook.md
git commit -m "docs(send): document the send:channels command (capabilities, artifacts, runbook)"
```

---

## Self-Review

**1. Spec coverage:**
- Decision 1 (`ChannelSender` port + adapters mirroring DriveUploader) → Task 1 (port) + Tasks 2/3 (adapters).
- Decision 2 (TelegramBotSender: Bot API, HTML, one message per segment, reply chaining, 4096) → Task 2. (The 4096 cap is enforced upstream by the `telegram_bot` emitter; the sender surfaces an over-limit as an API error.)
- Decision 3 (TypefullySender: v2 draft, posts array, publish now, poll for the url) → Task 3.
- Decision 4 (SendChannels: approved + unsent, per-item isolation) → Task 6.
- Decision 5 (idempotency via `output/publish/channels.json`; history cloud-only best-effort; any mode, not skipIfLocal) → Task 4 (ledger) + Task 6 (best-effort recorder) + Task 7 (`buildRecorder`).
- Decision 6 (`send:channels --target …` mirroring resolveTargets) → Task 7.
- Config + `.env.example` companion → Task 5. Docs companion (capabilities + artifacts + runbook) → Task 8.
- Non-goals (X API / twitterapi write / Kakao / mail / media / scheduling / dashboard button / edit-delete) → nothing in any task builds them.

**2. Placeholder scan:** No TBD/TODO; every code step has real code. Task 8 Step 2 describes doc sections (matching evolving Korean files) with a concrete verify grep in Step 3 — the same pattern the earlier docs tasks used and reviews accepted.

**3. Type consistency:** `SendableChannel`/`DELIVERY_DESTINATION`/`ChannelSentEntry`/`sentKey` (Task 1) are consumed by Tasks 4/6/7. `SendRequest`/`SendResult`/`ChannelSender` (Task 1) are implemented by Tasks 2/3 and consumed by Task 6. `Recorder`/`ChannelLedger`/`SendChannelsInput/Result` (Task 6) are used by Task 7's CLI + `buildRecorder`. `loadTelegramConfig`/`loadTypefullyConfig` (Task 5) are used by Task 7. `emit`/`Destination`/`FormattingStore`/`ChannelRendering`/`PublishRecord` are existing and used as-is. `ALL_CHANNEL_TARGETS`/`resolveChannelTargets`/`createSenders` (Task 7) match their CLI use. Consistent.

**Deviation from spec noted:** the spec's `SendResult` carried a `status: "posted"|"failed"`; the plan drops it — a sender **throws** on failure (idiomatic here, matching `GoogleSheetClient`), and `SendChannels` derives sent/failed from whether `send()` threw. `SendResult` is just `{ postId?, url? }`. Behaviour is identical; the error path is cleaner.
