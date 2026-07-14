# Lark Data Collection (Subsystem B) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Collect text/post messages from target Lark group chats into local JSON, incrementally per-chat, with tenant-token auth — reusing shared infra extracted from module A.

**Architecture:** Hexagonal. First extract module A's generic HTTP client and atomic-JSON/watermark persistence into `src/shared/` (migrating module A, kept green by its existing tests). Then build a separate parallel Lark stack: pure `domain/larkMessage` (model + `extractText`), `ports` (LarkSourceGateway, LarkRepository), `adapters/lark` (LarkAuth token cache, LarkClient Bearer wrapper, zod schemas, gateway, local store), an `app/CollectLarkMessages` use-case, and a `cli/collect-lark` composition root.

**Tech Stack:** TypeScript (ESM), pnpm, Node 24, native `fetch`, `zod`, `vitest`, `tsx`. No new dependencies.

## Global Constraints

- **Language:** All code, identifiers, comments in English. Chat is Korean.
- **Dependencies:** no new runtime deps (only `zod`). Native `fetch`. No `dotenv`.
- **Module system:** ESM (`"type": "module"`), `moduleResolution: bundler` — imports need NO `.js` extension.
- **Node floor:** Node 24, pnpm 11.9.
- **Secrets:** read `LARK_APP_ID`, `LARK_APP_SECRET`, `LARK_CHAT_IDS`, `LARK_BASE_URL` from env only. Never log secrets. `output/`, `.env`, `design/` are git-ignored.
- **Lark base URL:** default `https://open.larksuite.com` (Larksuite international); overridable via `LARK_BASE_URL`.
- **Collect only** `msg_type` ∈ {`text`, `post`}. Exclude image/file/audio/etc.
- **Thread/message key:** dedup and upsert by `message_id`.
- **Incremental:** per-chat watermark on message `create_time` (ISO). Watermark advances only after a successful save.
- **Envelope:** Lark returns HTTP 200 with `{code, msg, data}`; `code !== 0` is an error.
- **TDD:** failing test first for every unit with logic. Commit after each green task.
- **Do not break module A:** its full test suite must stay green after the shared extraction (Tasks 1–2).

---

## File Structure

| File | Responsibility |
|---|---|
| `src/shared/http/IHttpClient.ts` | HTTP port (moved from module A) |
| `src/shared/http/HttpClient.ts` | Generic retry/backoff/params/JSON client (moved, errors generalized) |
| `src/shared/store/jsonFile.ts` | `readJsonFile` (ENOENT→fallback, else throw) + `writeJsonFileAtomic` |
| `src/shared/store/WatermarkStore.ts` | Keyed watermark port: `get(key)` / `set(key,time)` |
| `src/adapters/twitterapi/*` | Module A — migrated to import from `src/shared/*` |
| `src/app/CollectAuthoredContent.ts` | Module A — watermark keyed by `userName` |
| `src/domain/larkMessage.ts` | `LarkMessage` model + pure `extractText` |
| `src/ports/LarkSourceGateway.ts` | `fetchMessages(chatId, sinceTime?)` |
| `src/ports/LarkRepository.ts` | `loadAll` / `upsert` (by messageId) |
| `src/adapters/lark/schemas.ts` | zod validation + `normalizeMessage` + `parseMessagesData` |
| `src/adapters/lark/LarkAuth.ts` | tenant_access_token fetch + cache/refresh |
| `src/adapters/lark/LarkClient.ts` | Bearer injection + auth-error retry over shared HttpClient |
| `src/adapters/lark/LarkSourceGateway.ts` | `im/v1/messages` pagination + type filter |
| `src/adapters/lark/LarkLocalStore.ts` | `LarkRepository` + per-chat `WatermarkStore` over `output/` |
| `src/app/CollectLarkMessages.ts` | Use-case: per-chat incremental collect |
| `src/config.ts` | + `loadLarkConfig()` |
| `src/cli/collect-lark.ts` | Composition root |
| `tests/**` | vitest unit tests + skipped live probe |

---

## Task 1: Extract shared HTTP client (migrate module A)

**Files:**
- Create: `src/shared/http/IHttpClient.ts`, `src/shared/http/HttpClient.ts`
- Delete: `src/adapters/twitterapi/IHttpClient.ts`, `src/adapters/twitterapi/HttpClient.ts`
- Modify: `src/adapters/twitterapi/TwitterClient.ts` (import path)
- Move test: `tests/adapters/httpClient.test.ts` → `tests/shared/httpClient.test.ts` (adjust import + 401 assertion)

**Interfaces:**
- Consumes: nothing
- Produces: `IHttpClient` (get/post/patch/delete), `HttpClient(baseUrl, defaultHeaders?)` with generic error messages

- [ ] **Step 1: Create `src/shared/http/IHttpClient.ts`**

```ts
export interface IHttpClient {
  get<T>(path: string, params?: Record<string, string>): Promise<T>;
  post<T>(path: string, body?: unknown): Promise<T>;
  patch<T>(path: string, body?: unknown): Promise<T>;
  delete<T>(path: string, body?: unknown): Promise<T>;
}
```

- [ ] **Step 2: Create `src/shared/http/HttpClient.ts`**

```ts
import type { IHttpClient } from "./IHttpClient";

export class HttpClient implements IHttpClient {
  constructor(
    private readonly baseUrl: string,
    private readonly defaultHeaders: Record<string, string> = {},
  ) {}

  private async request<T>(
    method: string,
    path: string,
    options: { params?: Record<string, string>; body?: unknown } = {},
  ): Promise<T> {
    const url = new URL(`${this.baseUrl}${path}`);
    if (options.params) {
      for (const [k, v] of Object.entries(options.params)) {
        if (v !== undefined && v !== "") url.searchParams.set(k, v);
      }
    }

    const headers: Record<string, string> = {
      "Content-Type": "application/json",
      ...this.defaultHeaders,
    };

    const init: RequestInit = { method, headers };
    if (options.body !== undefined) init.body = JSON.stringify(options.body);

    for (let attempt = 0; attempt < 3; attempt++) {
      const res = await fetch(url.toString(), init);

      if (res.status === 429 || res.status >= 500) {
        await new Promise((r) => setTimeout(r, 1000 * 2 ** attempt));
        continue;
      }

      if (!res.ok) {
        let detail = res.statusText;
        try {
          const body = (await res.json()) as Record<string, unknown>;
          if (typeof body["detail"] === "string") detail = body["detail"];
          else if (typeof body["msg"] === "string") detail = body["msg"];
        } catch {
          // ignore parse error
        }
        if (res.status === 401) throw new Error(`HTTP 401: unauthorized — ${detail}`);
        if (res.status === 402) throw new Error(`HTTP 402: payment required — ${detail}`);
        throw new Error(`HTTP ${res.status}: ${detail}`);
      }

      return res.json() as Promise<T>;
    }

    throw new Error(`Request failed after 3 attempts: ${method} ${path}`);
  }

  get<T>(path: string, params?: Record<string, string>): Promise<T> {
    return this.request<T>("GET", path, { params });
  }
  post<T>(path: string, body?: unknown): Promise<T> {
    return this.request<T>("POST", path, { body });
  }
  patch<T>(path: string, body?: unknown): Promise<T> {
    return this.request<T>("PATCH", path, { body });
  }
  delete<T>(path: string, body?: unknown): Promise<T> {
    return this.request<T>("DELETE", path, { body });
  }
}
```

- [ ] **Step 3: Delete the old module-A HTTP files**

Run:
```bash
git rm src/adapters/twitterapi/IHttpClient.ts src/adapters/twitterapi/HttpClient.ts
```

- [ ] **Step 4: Update `src/adapters/twitterapi/TwitterClient.ts` import**

Change the two import lines at the top to point at shared:
```ts
import { HttpClient } from "../../shared/http/HttpClient";
import type { IHttpClient } from "../../shared/http/IHttpClient";
```
(The rest of `TwitterClient.ts` is unchanged.)

- [ ] **Step 5: Update the remaining `IHttpClient` importers to point at shared**

In `src/adapters/twitterapi/TwitterApiSourceGateway.ts`:
```ts
import type { IHttpClient } from "../../shared/http/IHttpClient";
```
In `tests/adapters/twitterApiSourceGateway.test.ts` (it constructs a `FakeHttpClient implements IHttpClient`):
```ts
import type { IHttpClient } from "../../src/shared/http/IHttpClient";
```
(Leave all other imports/logic unchanged. Confirm no other file imports from `adapters/twitterapi/IHttpClient` or `adapters/twitterapi/HttpClient` with `grep -rn "twitterapi/HttpClient\|twitterapi/IHttpClient" src tests` — expect no remaining hits after these edits.)

- [ ] **Step 6: Move + adjust the HTTP client test**

Run:
```bash
git mv tests/adapters/httpClient.test.ts tests/shared/httpClient.test.ts
```
Then edit `tests/shared/httpClient.test.ts`:
- Change the import to `import { HttpClient } from "../../src/shared/http/HttpClient";`
- Change the 401 test's assertion from `rejects.toThrow(/API key/i)` to `rejects.toThrow(/401|unauthorized/i)`.

- [ ] **Step 7: Run the full suite**

Run: `pnpm test`
Expected: all pass (same counts as before, HTTP test now under `tests/shared/`), typecheck clean via `pnpm typecheck`.

- [ ] **Step 8: Commit**

```bash
git add -A
git commit -m "refactor: extract generic HttpClient to src/shared/http (module A migrated)"
```

---

## Task 2: Extract shared JSON-file helpers + keyed WatermarkStore (migrate module A)

**Files:**
- Create: `src/shared/store/jsonFile.ts`, `src/shared/store/WatermarkStore.ts`
- Delete: `src/ports/WatermarkStore.ts`
- Modify: `src/adapters/store/LocalJsonStore.ts`, `src/app/CollectAuthoredContent.ts`
- Modify tests: `tests/adapters/localJsonStore.test.ts`, `tests/app/collectAuthoredContent.test.ts`

**Interfaces:**
- Consumes: nothing
- Produces:
  - `readJsonFile<T>(path: string, fallback: T): Promise<T>`
  - `writeJsonFileAtomic(dir: string, path: string, data: unknown): Promise<void>`
  - `WatermarkStore { get(key: string): Promise<string|undefined>; set(key: string, time: string): Promise<void> }`
  - `CollectAuthoredContent` now keys its watermark by `userName`.

- [ ] **Step 1: Create `src/shared/store/jsonFile.ts`**

```ts
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";

function isErrnoException(err: unknown): err is NodeJS.ErrnoException {
  return err instanceof Error && "code" in err;
}

/** Read + parse JSON. Missing file (ENOENT) → fallback; corrupt/other errors throw. */
export async function readJsonFile<T>(path: string, fallback: T): Promise<T> {
  try {
    return JSON.parse(await readFile(path, "utf8")) as T;
  } catch (err: unknown) {
    if (isErrnoException(err) && err.code === "ENOENT") return fallback;
    const cause = err instanceof Error ? err.message : String(err);
    throw new Error(`Failed to read JSON file at ${path}: ${cause}`, { cause: err });
  }
}

/** Atomic write: temp file in the same dir + rename over the target. */
export async function writeJsonFileAtomic(dir: string, path: string, data: unknown): Promise<void> {
  await mkdir(dir, { recursive: true });
  const tmpPath = `${path}.tmp-${process.pid}-${Date.now()}-${randomUUID()}`;
  await writeFile(tmpPath, `${JSON.stringify(data, null, 2)}\n`, "utf8");
  await rename(tmpPath, path);
}
```

- [ ] **Step 2: Create `src/shared/store/WatermarkStore.ts`**

```ts
/** Keyed incremental watermark (e.g. per account or per chat). ISO 8601 times. */
export interface WatermarkStore {
  get(key: string): Promise<string | undefined>;
  set(key: string, time: string): Promise<void>;
}
```

- [ ] **Step 3: Delete the old single-key port**

Run: `git rm src/ports/WatermarkStore.ts`

- [ ] **Step 4: Rewrite `src/adapters/store/LocalJsonStore.ts`**

```ts
import { join } from "node:path";
import type { CollectedThread, SourceTweet } from "../../domain/models";
import type { CollectionRepository } from "../../ports/CollectionRepository";
import type { WatermarkStore } from "../../shared/store/WatermarkStore";
import { readJsonFile, writeJsonFileAtomic } from "../../shared/store/jsonFile";

interface StateFile {
  watermarks?: Record<string, string>;
}

export class LocalJsonStore implements CollectionRepository, WatermarkStore {
  private readonly itemsPath: string;
  private readonly statePath: string;

  constructor(private readonly dir: string) {
    this.itemsPath = join(dir, "items.json");
    this.statePath = join(dir, "state.json");
  }

  async loadAll(): Promise<CollectedThread[]> {
    return readJsonFile<CollectedThread[]>(this.itemsPath, []);
  }

  async upsert(threads: CollectedThread[]): Promise<void> {
    const existing = await this.loadAll();
    const byRoot = new Map(existing.map((t) => [t.rootId, t]));
    for (const incoming of threads) {
      const prev = byRoot.get(incoming.rootId);
      byRoot.set(incoming.rootId, {
        ...incoming,
        tweets: this.mergeTweets(prev?.tweets ?? [], incoming.tweets),
        firstSeenAt: prev?.firstSeenAt ?? incoming.firstSeenAt,
      });
    }
    await writeJsonFileAtomic(this.dir, this.itemsPath, [...byRoot.values()]);
  }

  private mergeTweets(existing: SourceTweet[], incoming: SourceTweet[]): SourceTweet[] {
    const byId = new Map<string, SourceTweet>();
    for (const t of existing) byId.set(t.id, t);
    for (const t of incoming) byId.set(t.id, t);
    return [...byId.values()].sort(
      (a, b) => a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id),
    );
  }

  async listActiveTweetIds(): Promise<string[]> {
    const all = await this.loadAll();
    const ids: string[] = [];
    for (const thread of all) {
      if (thread.status !== "active") continue;
      for (const tweet of thread.tweets) ids.push(tweet.id);
    }
    return ids;
  }

  async markDeleted(tweetIds: string[], deletedAt: string): Promise<void> {
    const target = new Set(tweetIds);
    const all = await this.loadAll();
    let changed = false;
    for (const thread of all) {
      if (thread.status !== "active") continue;
      if (thread.tweets.some((t) => target.has(t.id))) {
        thread.status = "deleted";
        thread.deletedAt = deletedAt;
        changed = true;
      }
    }
    if (changed) await writeJsonFileAtomic(this.dir, this.itemsPath, all);
  }

  async get(key: string): Promise<string | undefined> {
    const state = await readJsonFile<StateFile>(this.statePath, {});
    return state.watermarks?.[key];
  }

  async set(key: string, time: string): Promise<void> {
    const state = await readJsonFile<StateFile>(this.statePath, {});
    const watermarks = { ...(state.watermarks ?? {}), [key]: time };
    await writeJsonFileAtomic(this.dir, this.statePath, { watermarks } satisfies StateFile);
  }
}
```

- [ ] **Step 5: Update `src/app/CollectAuthoredContent.ts`**

Change the import of `WatermarkStore` and key the watermark by `userName`. Replace the import line:
```ts
import type { WatermarkStore } from "../shared/store/WatermarkStore";
```
In `run(userName)`, change the two watermark calls:
```ts
    const since = await this.watermark.get(userName);
```
and near the end:
```ts
    if (maxCreatedAt && (!since || maxCreatedAt > since)) {
      await this.watermark.set(userName, maxCreatedAt);
    }
```
(All other logic unchanged.)

- [ ] **Step 6: Update `tests/adapters/localJsonStore.test.ts` watermark test**

Change the watermark test's calls to the keyed signature:
```ts
  it("watermark get returns undefined initially, then the set value", async () => {
    const store = new LocalJsonStore(dir);
    expect(await store.get("acct")).toBeUndefined();
    await store.set("acct", "2026-04-04T00:00:00.000Z");
    expect(await store.get("acct")).toBe("2026-04-04T00:00:00.000Z");
  });
```

- [ ] **Step 7: Update `tests/app/collectAuthoredContent.test.ts` fake watermark**

Replace the `InMemoryWatermark` class and its assertions with the keyed version:
```ts
class InMemoryWatermark implements WatermarkStore {
  public marks = new Map<string, string>();
  async get(key: string) {
    return this.marks.get(key);
  }
  async set(key: string, time: string) {
    this.marks.set(key, time);
  }
}
```
Update its import to `import type { WatermarkStore } from "../../src/shared/store/WatermarkStore";`.
Then update the two assertions that read the watermark:
- "advances the watermark…" test: `expect(wm.marks.get("Mantle_Official")).toBe("2026-01-01T00:02:00.000Z");`
- "does not advance…" test: construct as `const wm = new InMemoryWatermark(); wm.marks.set("Mantle_Official", "2026-01-01T00:00:00.000Z");` and assert `expect(wm.marks.get("Mantle_Official")).toBe("2026-01-01T00:00:00.000Z");`.

- [ ] **Step 8: Run the full suite + typecheck**

Run: `pnpm test && pnpm typecheck`
Expected: all pass; typecheck exit 0.

- [ ] **Step 9: Commit**

```bash
git add -A
git commit -m "refactor: extract shared JSON-file helpers + keyed WatermarkStore (module A watermark now per-account)"
```

---

## Task 3: LarkMessage domain model + extractText (pure)

**Files:**
- Create: `src/domain/larkMessage.ts`
- Test: `tests/domain/larkMessage.test.ts`

**Interfaces:**
- Consumes: nothing
- Produces:
  - `LarkMessage { messageId: string; chatId: string; msgType: string; createdAt: string; senderId?: string; threadId?: string; parentId?: string; text: string; rawContent: string }`
  - `extractText(msgType: string, content: string): string`

- [ ] **Step 1: Write the failing test**

Create `tests/domain/larkMessage.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { extractText } from "../../src/domain/larkMessage";

describe("extractText", () => {
  it("returns the text field for a text message", () => {
    expect(extractText("text", JSON.stringify({ text: "hello world" }))).toBe("hello world");
  });

  it("flattens a post message (title + paragraphs) to plain text", () => {
    const content = JSON.stringify({
      title: "Update",
      content: [
        [{ tag: "text", text: "Line one " }, { tag: "a", text: "link", href: "https://x" }],
        [{ tag: "text", text: "Line two" }],
      ],
    });
    expect(extractText("post", content)).toBe("Update\nLine one link\nLine two");
  });

  it("returns empty string for unsupported types", () => {
    expect(extractText("image", JSON.stringify({ image_key: "img_x" }))).toBe("");
  });

  it("returns empty string when content is not valid JSON", () => {
    expect(extractText("text", "{ not json")).toBe("");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm test tests/domain/larkMessage.test.ts`
Expected: FAIL — cannot resolve `larkMessage`.

- [ ] **Step 3: Write `src/domain/larkMessage.ts`**

```ts
export interface LarkMessage {
  messageId: string;
  chatId: string;
  msgType: string; // "text" | "post" (collected); preserved as-is
  createdAt: string; // ISO 8601 UTC (from create_time ms)
  senderId?: string;
  threadId?: string;
  parentId?: string;
  text: string; // plain text for translation
  rawContent: string; // original body.content JSON string
}

interface PostElement {
  text?: string;
}

/** Pure: extract plain text from a Lark message body.content (per msg_type). */
export function extractText(msgType: string, content: string): string {
  let parsed: unknown;
  try {
    parsed = JSON.parse(content);
  } catch {
    return "";
  }

  if (msgType === "text") {
    const text = (parsed as { text?: unknown }).text;
    return typeof text === "string" ? text : "";
  }

  if (msgType === "post") {
    const post = parsed as { title?: unknown; content?: unknown };
    const lines: string[] = [];
    if (typeof post.title === "string" && post.title.length > 0) lines.push(post.title);
    if (Array.isArray(post.content)) {
      for (const paragraph of post.content) {
        if (!Array.isArray(paragraph)) continue;
        const line = paragraph
          .map((el) => (typeof (el as PostElement).text === "string" ? (el as PostElement).text : ""))
          .join("");
        lines.push(line);
      }
    }
    return lines.join("\n");
  }

  return "";
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm test tests/domain/larkMessage.test.ts`
Expected: PASS (4 tests).

- [ ] **Step 5: Commit**

```bash
git add src/domain/larkMessage.ts tests/domain/larkMessage.test.ts
git commit -m "feat: LarkMessage model and pure extractText"
```

---

## Task 4: Lark ports

**Files:**
- Create: `src/ports/LarkSourceGateway.ts`, `src/ports/LarkRepository.ts`

**Interfaces:**
- Consumes: `LarkMessage` (Task 3)
- Produces:
  - `LarkSourceGateway.fetchMessages(chatId: string, sinceTime?: string): AsyncGenerator<LarkMessage>`
  - `LarkRepository.loadAll(): Promise<LarkMessage[]>` / `upsert(messages: LarkMessage[]): Promise<void>`

- [ ] **Step 1: Write `src/ports/LarkSourceGateway.ts`**

```ts
import type { LarkMessage } from "../domain/larkMessage";

export interface LarkSourceGateway {
  /** Messages in a chat newer than sinceTime (ISO), streamed via pagination. */
  fetchMessages(chatId: string, sinceTime?: string): AsyncGenerator<LarkMessage>;
}
```

- [ ] **Step 2: Write `src/ports/LarkRepository.ts`**

```ts
import type { LarkMessage } from "../domain/larkMessage";

export interface LarkRepository {
  loadAll(): Promise<LarkMessage[]>;
  /** Merge by messageId (incoming wins). Never drops stored messages. */
  upsert(messages: LarkMessage[]): Promise<void>;
}
```

- [ ] **Step 3: Verify typecheck**

Run: `pnpm typecheck`
Expected: exit 0.

- [ ] **Step 4: Commit**

```bash
git add src/ports/LarkSourceGateway.ts src/ports/LarkRepository.ts
git commit -m "feat: Lark ports (LarkSourceGateway, LarkRepository)"
```

---

## Task 5: Lark response schemas + normalization (zod)

**Files:**
- Create: `src/adapters/lark/schemas.ts`
- Test: `tests/adapters/lark/schemas.test.ts`

**Interfaces:**
- Consumes: `LarkMessage`, `extractText` (Task 3)
- Produces:
  - `normalizeMessage(raw: unknown): LarkMessage`
  - `parseMessagesData(response: unknown): { items: unknown[]; pageToken: string; hasMore: boolean }` (throws on `code !== 0`)

- [ ] **Step 1: Write the failing test**

Create `tests/adapters/lark/schemas.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { normalizeMessage, parseMessagesData } from "../../../src/adapters/lark/schemas";

const rawMessage = {
  message_id: "om_123",
  msg_type: "text",
  create_time: "1750000000000",
  chat_id: "oc_abc",
  thread_id: "th_1",
  parent_id: "",
  sender: { id: "ou_sender", id_type: "open_id", sender_type: "user", tenant_key: "t" },
  body: { content: '{"text":"hello"}' },
};

describe("normalizeMessage", () => {
  it("maps a raw Lark message to LarkMessage with ISO createdAt and extracted text", () => {
    const m = normalizeMessage(rawMessage);
    expect(m.messageId).toBe("om_123");
    expect(m.chatId).toBe("oc_abc");
    expect(m.msgType).toBe("text");
    expect(m.createdAt).toBe(new Date(1750000000000).toISOString());
    expect(m.senderId).toBe("ou_sender");
    expect(m.threadId).toBe("th_1");
    expect(m.text).toBe("hello");
    expect(m.rawContent).toBe('{"text":"hello"}');
  });

  it("throws when a required field is missing", () => {
    expect(() => normalizeMessage({ msg_type: "text" })).toThrow();
  });
});

describe("parseMessagesData", () => {
  it("extracts items, pageToken, hasMore from a code:0 envelope", () => {
    const parsed = parseMessagesData({
      code: 0,
      msg: "success",
      data: { items: [rawMessage], page_token: "pt1", has_more: true },
    });
    expect(parsed.items).toHaveLength(1);
    expect(parsed.pageToken).toBe("pt1");
    expect(parsed.hasMore).toBe(true);
  });

  it("defaults missing pagination fields", () => {
    const parsed = parseMessagesData({ code: 0, msg: "ok", data: { items: [] } });
    expect(parsed.hasMore).toBe(false);
    expect(parsed.pageToken).toBe("");
  });

  it("throws when code is non-zero", () => {
    expect(() => parseMessagesData({ code: 99991663, msg: "invalid token", data: {} })).toThrow(
      /99991663|invalid token/,
    );
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm test tests/adapters/lark/schemas.test.ts`
Expected: FAIL — cannot resolve `schemas`.

- [ ] **Step 3: Write `src/adapters/lark/schemas.ts`**

```ts
import { z } from "zod";
import { extractText, type LarkMessage } from "../../domain/larkMessage";

const MessageRaw = z
  .object({
    message_id: z.string(),
    msg_type: z.string(),
    create_time: z.string(),
    chat_id: z.string(),
    thread_id: z.string().optional(),
    parent_id: z.string().optional(),
    sender: z.object({ id: z.string().optional() }).passthrough().optional(),
    body: z.object({ content: z.string() }).passthrough(),
  })
  .passthrough();

const MessagesEnvelope = z.object({
  code: z.number(),
  msg: z.string().optional(),
  data: z
    .object({
      items: z.array(z.unknown()).nullish(),
      page_token: z.string().nullish(),
      has_more: z.boolean().nullish(),
    })
    .nullish(),
});

function emptyToUndefined(value: string | undefined): string | undefined {
  return value && value.length > 0 ? value : undefined;
}

/** Validate and convert a raw Lark message into a domain LarkMessage. */
export function normalizeMessage(raw: unknown): LarkMessage {
  const m = MessageRaw.parse(raw);
  const content = m.body.content;
  return {
    messageId: m.message_id,
    chatId: m.chat_id,
    msgType: m.msg_type,
    createdAt: new Date(Number(m.create_time)).toISOString(),
    senderId: m.sender?.id,
    threadId: emptyToUndefined(m.thread_id),
    parentId: emptyToUndefined(m.parent_id),
    text: extractText(m.msg_type, content),
    rawContent: content,
  };
}

/** Validate a messages-list envelope; throw on code !== 0. */
export function parseMessagesData(response: unknown): {
  items: unknown[];
  pageToken: string;
  hasMore: boolean;
} {
  const env = MessagesEnvelope.parse(response);
  if (env.code !== 0) {
    throw new Error(`Lark API error: code=${env.code} ${env.msg ?? ""}`.trim());
  }
  return {
    items: env.data?.items ?? [],
    pageToken: env.data?.page_token ?? "",
    hasMore: env.data?.has_more ?? false,
  };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm test tests/adapters/lark/schemas.test.ts`
Expected: PASS (5 tests).

- [ ] **Step 5: Commit**

```bash
git add src/adapters/lark/schemas.ts tests/adapters/lark/schemas.test.ts
git commit -m "feat: Lark response schemas and message normalization"
```

---

## Task 6: LarkAuth (tenant_access_token cache/refresh)

**Files:**
- Create: `src/adapters/lark/LarkAuth.ts`
- Test: `tests/adapters/lark/larkAuth.test.ts`

**Interfaces:**
- Consumes: `IHttpClient` (Task 1)
- Produces: `LarkAuth(http: IHttpClient, appId: string, appSecret: string, now?: () => number)` with `getToken(force?: boolean): Promise<string>`

- [ ] **Step 1: Write the failing test**

Create `tests/adapters/lark/larkAuth.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { LarkAuth } from "../../../src/adapters/lark/LarkAuth";
import type { IHttpClient } from "../../../src/shared/http/IHttpClient";

class FakeHttpClient implements IHttpClient {
  public postCount = 0;
  constructor(private readonly responder: () => unknown) {}
  async get<T>(): Promise<T> {
    throw new Error("not used");
  }
  async post<T>(): Promise<T> {
    this.postCount += 1;
    return this.responder() as T;
  }
  async patch<T>(): Promise<T> {
    throw new Error("not used");
  }
  async delete<T>(): Promise<T> {
    throw new Error("not used");
  }
}

describe("LarkAuth", () => {
  it("fetches a token and caches it (no second request within validity)", async () => {
    const http = new FakeHttpClient(() => ({ code: 0, msg: "ok", tenant_access_token: "t-1", expire: 7200 }));
    const auth = new LarkAuth(http, "app", "secret", () => 1000);

    expect(await auth.getToken()).toBe("t-1");
    expect(await auth.getToken()).toBe("t-1");
    expect(http.postCount).toBe(1);
  });

  it("refreshes when the cached token is near expiry", async () => {
    let n = 0;
    const http = new FakeHttpClient(() => ({ code: 0, tenant_access_token: `t-${++n}`, expire: 7200 }));
    let clock = 0;
    const auth = new LarkAuth(http, "app", "secret", () => clock);

    expect(await auth.getToken()).toBe("t-1");
    clock = (7200 - 30) * 1000; // within the 60s refresh window
    expect(await auth.getToken()).toBe("t-2");
    expect(http.postCount).toBe(2);
  });

  it("throws when the auth response has a non-zero code", async () => {
    const http = new FakeHttpClient(() => ({ code: 10003, msg: "bad app_secret" }));
    const auth = new LarkAuth(http, "app", "secret");
    await expect(auth.getToken()).rejects.toThrow(/10003|bad app_secret/);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm test tests/adapters/lark/larkAuth.test.ts`
Expected: FAIL — cannot resolve `LarkAuth`.

- [ ] **Step 3: Write `src/adapters/lark/LarkAuth.ts`**

```ts
import type { IHttpClient } from "../../shared/http/IHttpClient";

interface TokenResponse {
  code: number;
  msg?: string;
  tenant_access_token?: string;
  expire?: number; // seconds, <= 7200
}

const REFRESH_MARGIN_SECONDS = 60;

export class LarkAuth {
  private token?: string;
  private expiresAt = 0; // ms epoch

  constructor(
    private readonly http: IHttpClient,
    private readonly appId: string,
    private readonly appSecret: string,
    private readonly now: () => number = Date.now,
  ) {}

  async getToken(force = false): Promise<string> {
    if (!force && this.token && this.now() < this.expiresAt) return this.token;

    const res = await this.http.post<TokenResponse>(
      "/open-apis/auth/v3/tenant_access_token/internal",
      { app_id: this.appId, app_secret: this.appSecret },
    );
    if (res.code !== 0 || !res.tenant_access_token) {
      throw new Error(`Lark auth failed: code=${res.code} ${res.msg ?? ""}`.trim());
    }

    this.token = res.tenant_access_token;
    const ttl = (res.expire ?? 7200) - REFRESH_MARGIN_SECONDS;
    this.expiresAt = this.now() + Math.max(ttl, 0) * 1000;
    return this.token;
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm test tests/adapters/lark/larkAuth.test.ts`
Expected: PASS (3 tests).

- [ ] **Step 5: Commit**

```bash
git add src/adapters/lark/LarkAuth.ts tests/adapters/lark/larkAuth.test.ts
git commit -m "feat: LarkAuth tenant_access_token cache and refresh"
```

---

## Task 7: LarkClient (Bearer injection + auth-error retry)

**Files:**
- Create: `src/adapters/lark/LarkClient.ts`
- Test: `tests/adapters/lark/larkClient.test.ts`

**Interfaces:**
- Consumes: `HttpClient` (Task 1), `LarkAuth` (Task 6)
- Produces: `LarkClient(baseUrl: string, auth: LarkAuth, makeHttp?: (baseUrl, headers) => IHttpClient)` with `get<T>(path, params?): Promise<T>`

- [ ] **Step 1: Write the failing test**

Create `tests/adapters/lark/larkClient.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { LarkClient } from "../../../src/adapters/lark/LarkClient";
import { LarkAuth } from "../../../src/adapters/lark/LarkAuth";
import type { IHttpClient } from "../../../src/shared/http/IHttpClient";

function authReturning(token: string): LarkAuth {
  const http: IHttpClient = {
    get: async () => { throw new Error("no"); },
    post: async () => ({ code: 0, tenant_access_token: token, expire: 7200 }) as unknown,
    patch: async () => { throw new Error("no"); },
    delete: async () => { throw new Error("no"); },
  } as IHttpClient;
  return new LarkAuth(http, "app", "secret");
}

class SpyHttp implements IHttpClient {
  public authHeaders: (string | undefined)[] = [];
  constructor(private readonly headers: Record<string, string>, private readonly responder: () => unknown) {}
  async get<T>(): Promise<T> {
    this.authHeaders.push(this.headers["Authorization"]);
    return this.responder() as T;
  }
  async post<T>(): Promise<T> { throw new Error("no"); }
  async patch<T>(): Promise<T> { throw new Error("no"); }
  async delete<T>(): Promise<T> { throw new Error("no"); }
}

describe("LarkClient", () => {
  it("injects the bearer token from LarkAuth on GET", async () => {
    const spies: SpyHttp[] = [];
    const client = new LarkClient("https://open.larksuite.com", authReturning("t-abc"), (_base, headers) => {
      const s = new SpyHttp(headers, () => ({ code: 0, data: {} }));
      spies.push(s);
      return s;
    });

    await client.get("/open-apis/im/v1/messages", { container_id: "oc_x" });

    expect(spies[0].authHeaders[0]).toBe("Bearer t-abc");
  });

  it("refreshes the token once and retries on an auth-error envelope", async () => {
    let call = 0;
    const client = new LarkClient("https://open.larksuite.com", authReturning("t-abc"), (_base, headers) => {
      return new SpyHttp(headers, () => (++call === 1 ? { code: 99991663, msg: "expired" } : { code: 0, data: {} }));
    });

    const res = await client.get<{ code: number }>("/open-apis/im/v1/messages", {});

    expect(res.code).toBe(0);
    expect(call).toBe(2);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm test tests/adapters/lark/larkClient.test.ts`
Expected: FAIL — cannot resolve `LarkClient`.

- [ ] **Step 3: Write `src/adapters/lark/LarkClient.ts`**

```ts
import { HttpClient } from "../../shared/http/HttpClient";
import type { IHttpClient } from "../../shared/http/IHttpClient";
import type { LarkAuth } from "./LarkAuth";

// Lark auth-error codes (invalid / expired tenant_access_token).
const AUTH_ERROR_CODES = new Set([99991661, 99991663, 99991664]);

type HttpFactory = (baseUrl: string, headers: Record<string, string>) => IHttpClient;

const defaultFactory: HttpFactory = (baseUrl, headers) => new HttpClient(baseUrl, headers);

export class LarkClient {
  constructor(
    private readonly baseUrl: string,
    private readonly auth: LarkAuth,
    private readonly makeHttp: HttpFactory = defaultFactory,
  ) {}

  async get<T>(path: string, params?: Record<string, string>): Promise<T> {
    let token = await this.auth.getToken();
    let res = await this.call<T>(path, params, token);
    if (this.isAuthError(res)) {
      token = await this.auth.getToken(true);
      res = await this.call<T>(path, params, token);
    }
    return res;
  }

  private call<T>(path: string, params: Record<string, string> | undefined, token: string): Promise<T> {
    const http = this.makeHttp(this.baseUrl, { Authorization: `Bearer ${token}` });
    return http.get<T>(path, params);
  }

  private isAuthError(res: unknown): boolean {
    const code = (res as { code?: number })?.code;
    return typeof code === "number" && AUTH_ERROR_CODES.has(code);
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm test tests/adapters/lark/larkClient.test.ts`
Expected: PASS (2 tests).

- [ ] **Step 5: Commit**

```bash
git add src/adapters/lark/LarkClient.ts tests/adapters/lark/larkClient.test.ts
git commit -m "feat: LarkClient bearer injection with auth-error retry"
```

---

## Task 8: LarkSourceGateway (im/v1/messages pagination)

**Files:**
- Create: `src/adapters/lark/LarkSourceGateway.ts`
- Test: `tests/adapters/lark/larkSourceGateway.test.ts`

**Interfaces:**
- Consumes: `LarkClient` (Task 7), `parseMessagesData` + `normalizeMessage` (Task 5), `LarkSourceGateway` + `LarkMessage` (Tasks 3–4)
- Produces: `LarkSourceGateway implements LarkSourceGatewayPort`, constructed with `(client: { get })`. Uses a minimal client shape `{ get<T>(path, params?): Promise<T> }`.

- [ ] **Step 1: Write the failing test**

Create `tests/adapters/lark/larkSourceGateway.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { LarkSourceGateway } from "../../../src/adapters/lark/LarkSourceGateway";

function rawMsg(id: string, msgType = "text", content = '{"text":"hi"}') {
  return {
    message_id: id,
    msg_type: msgType,
    create_time: "1750000000000",
    chat_id: "oc_x",
    body: { content },
  };
}

class FakeClient {
  public calls: { path: string; params?: Record<string, string> }[] = [];
  constructor(private readonly responder: (params?: Record<string, string>) => unknown) {}
  async get<T>(path: string, params?: Record<string, string>): Promise<T> {
    this.calls.push({ path, params });
    return this.responder(params) as T;
  }
}

describe("LarkSourceGateway", () => {
  it("paginates via page_token and yields normalized text/post messages", async () => {
    const client = new FakeClient((params) =>
      params?.page_token
        ? { code: 0, data: { items: [rawMsg("om_2")], has_more: false, page_token: "" } }
        : { code: 0, data: { items: [rawMsg("om_1")], has_more: true, page_token: "pt1" } },
    );
    const gw = new LarkSourceGateway(client);

    const ids: string[] = [];
    for await (const m of gw.fetchMessages("oc_x")) ids.push(m.messageId);

    expect(ids).toEqual(["om_1", "om_2"]);
    expect(client.calls[0].path).toBe("/open-apis/im/v1/messages");
    expect(client.calls[0].params?.container_id).toBe("oc_x");
    expect(client.calls[0].params?.container_id_type).toBe("chat");
    expect(client.calls[0].params?.sort_type).toBe("ByCreateTimeAsc");
  });

  it("filters out non text/post message types", async () => {
    const client = new FakeClient(() => ({
      code: 0,
      data: { items: [rawMsg("om_1", "image", '{"image_key":"i"}'), rawMsg("om_2", "post", '{"content":[]}')], has_more: false },
    }));
    const gw = new LarkSourceGateway(client);

    const ids: string[] = [];
    for await (const m of gw.fetchMessages("oc_x")) ids.push(m.messageId);

    expect(ids).toEqual(["om_2"]);
  });

  it("passes start_time (unix seconds) when sinceTime is given", async () => {
    const client = new FakeClient(() => ({ code: 0, data: { items: [], has_more: false } }));
    const gw = new LarkSourceGateway(client);
    for await (const _ of gw.fetchMessages("oc_x", "2026-06-01T00:00:00.000Z")) { /* drain */ }
    const expected = String(Math.floor(Date.parse("2026-06-01T00:00:00.000Z") / 1000));
    expect(client.calls[0].params?.start_time).toBe(expected);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm test tests/adapters/lark/larkSourceGateway.test.ts`
Expected: FAIL — cannot resolve `LarkSourceGateway`.

- [ ] **Step 3: Write `src/adapters/lark/LarkSourceGateway.ts`**

```ts
import type { LarkMessage } from "../../domain/larkMessage";
import type { LarkSourceGateway as LarkSourceGatewayPort } from "../../ports/LarkSourceGateway";
import { normalizeMessage, parseMessagesData } from "./schemas";

interface MessageClient {
  get<T>(path: string, params?: Record<string, string>): Promise<T>;
}

const COLLECTED_TYPES = new Set(["text", "post"]);

export class LarkSourceGateway implements LarkSourceGatewayPort {
  constructor(private readonly client: MessageClient) {}

  async *fetchMessages(chatId: string, sinceTime?: string): AsyncGenerator<LarkMessage> {
    const baseParams: Record<string, string> = {
      container_id_type: "chat",
      container_id: chatId,
      sort_type: "ByCreateTimeAsc",
      page_size: "50",
    };
    if (sinceTime) {
      baseParams["start_time"] = String(Math.floor(Date.parse(sinceTime) / 1000));
    }

    let pageToken = "";
    while (true) {
      const params = pageToken ? { ...baseParams, page_token: pageToken } : baseParams;
      const data = await this.client.get<unknown>("/open-apis/im/v1/messages", params);
      const { items, pageToken: next, hasMore } = parseMessagesData(data);
      for (const raw of items) {
        const message = normalizeMessage(raw);
        if (COLLECTED_TYPES.has(message.msgType)) yield message;
      }
      if (!hasMore || !next) break;
      pageToken = next;
    }
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm test tests/adapters/lark/larkSourceGateway.test.ts`
Expected: PASS (3 tests).

- [ ] **Step 5: Commit**

```bash
git add src/adapters/lark/LarkSourceGateway.ts tests/adapters/lark/larkSourceGateway.test.ts
git commit -m "feat: LarkSourceGateway over im/v1/messages with type filter"
```

---

## Task 9: LarkLocalStore (repository + per-chat watermark)

**Files:**
- Create: `src/adapters/lark/LarkLocalStore.ts`
- Test: `tests/adapters/lark/larkLocalStore.test.ts`

**Interfaces:**
- Consumes: `readJsonFile`/`writeJsonFileAtomic` (Task 2), `WatermarkStore` (Task 2), `LarkRepository` + `LarkMessage` (Tasks 3–4)
- Produces: `LarkLocalStore implements LarkRepository, WatermarkStore`, constructed with `(dir: string)`. Persists `<dir>/lark-items.json` and `<dir>/lark-state.json`.

- [ ] **Step 1: Write the failing test**

Create `tests/adapters/lark/larkLocalStore.test.ts`:

```ts
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LarkLocalStore } from "../../../src/adapters/lark/LarkLocalStore";
import type { LarkMessage } from "../../../src/domain/larkMessage";

function msg(id: string, over: Partial<LarkMessage> = {}): LarkMessage {
  return {
    messageId: id,
    chatId: over.chatId ?? "oc_x",
    msgType: "text",
    createdAt: over.createdAt ?? "2026-01-01T00:00:00.000Z",
    text: over.text ?? `t${id}`,
    rawContent: `{"text":"t${id}"}`,
  };
}

let dir: string;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "lark-store-"));
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe("LarkLocalStore", () => {
  it("upsert then loadAll round-trips", async () => {
    const store = new LarkLocalStore(dir);
    await store.upsert([msg("om_1")]);
    expect(await store.loadAll()).toHaveLength(1);
  });

  it("upsert merges by messageId (incoming wins) without dropping stored messages", async () => {
    const store = new LarkLocalStore(dir);
    await store.upsert([msg("om_1", { text: "old" }), msg("om_2")]);
    await store.upsert([msg("om_1", { text: "new" })]); // subset re-collect
    const all = await store.loadAll();
    expect(all.map((m) => m.messageId).sort()).toEqual(["om_1", "om_2"]);
    expect(all.find((m) => m.messageId === "om_1")?.text).toBe("new");
  });

  it("per-chat watermark get/set is isolated by key", async () => {
    const store = new LarkLocalStore(dir);
    expect(await store.get("oc_a")).toBeUndefined();
    await store.set("oc_a", "2026-02-02T00:00:00.000Z");
    await store.set("oc_b", "2026-03-03T00:00:00.000Z");
    expect(await store.get("oc_a")).toBe("2026-02-02T00:00:00.000Z");
    expect(await store.get("oc_b")).toBe("2026-03-03T00:00:00.000Z");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm test tests/adapters/lark/larkLocalStore.test.ts`
Expected: FAIL — cannot resolve `LarkLocalStore`.

- [ ] **Step 3: Write `src/adapters/lark/LarkLocalStore.ts`**

```ts
import { join } from "node:path";
import type { LarkMessage } from "../../domain/larkMessage";
import type { LarkRepository } from "../../ports/LarkRepository";
import type { WatermarkStore } from "../../shared/store/WatermarkStore";
import { readJsonFile, writeJsonFileAtomic } from "../../shared/store/jsonFile";

interface StateFile {
  watermarks?: Record<string, string>;
}

export class LarkLocalStore implements LarkRepository, WatermarkStore {
  private readonly itemsPath: string;
  private readonly statePath: string;

  constructor(private readonly dir: string) {
    this.itemsPath = join(dir, "lark-items.json");
    this.statePath = join(dir, "lark-state.json");
  }

  async loadAll(): Promise<LarkMessage[]> {
    return readJsonFile<LarkMessage[]>(this.itemsPath, []);
  }

  async upsert(messages: LarkMessage[]): Promise<void> {
    const existing = await this.loadAll();
    const byId = new Map(existing.map((m) => [m.messageId, m]));
    for (const incoming of messages) byId.set(incoming.messageId, incoming);
    const merged = [...byId.values()].sort(
      (a, b) => a.createdAt.localeCompare(b.createdAt) || a.messageId.localeCompare(b.messageId),
    );
    await writeJsonFileAtomic(this.dir, this.itemsPath, merged);
  }

  async get(key: string): Promise<string | undefined> {
    const state = await readJsonFile<StateFile>(this.statePath, {});
    return state.watermarks?.[key];
  }

  async set(key: string, time: string): Promise<void> {
    const state = await readJsonFile<StateFile>(this.statePath, {});
    const watermarks = { ...(state.watermarks ?? {}), [key]: time };
    await writeJsonFileAtomic(this.dir, this.statePath, { watermarks } satisfies StateFile);
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm test tests/adapters/lark/larkLocalStore.test.ts`
Expected: PASS (3 tests).

- [ ] **Step 5: Commit**

```bash
git add src/adapters/lark/LarkLocalStore.ts tests/adapters/lark/larkLocalStore.test.ts
git commit -m "feat: LarkLocalStore (repository + per-chat watermark)"
```

---

## Task 10: CollectLarkMessages use-case

**Files:**
- Create: `src/app/CollectLarkMessages.ts`
- Test: `tests/app/collectLarkMessages.test.ts`

**Interfaces:**
- Consumes: `LarkSourceGateway`, `LarkRepository` (Task 4), `WatermarkStore` (Task 2)
- Produces: `CollectLarkMessages(source, repo, watermark)`; `run(chatIds: string[]): Promise<{ collected: number }>`

- [ ] **Step 1: Write the failing test**

Create `tests/app/collectLarkMessages.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { CollectLarkMessages } from "../../src/app/CollectLarkMessages";
import type { LarkSourceGateway } from "../../src/ports/LarkSourceGateway";
import type { LarkRepository } from "../../src/ports/LarkRepository";
import type { WatermarkStore } from "../../src/shared/store/WatermarkStore";
import type { LarkMessage } from "../../src/domain/larkMessage";

function msg(id: string, chatId: string, createdAt: string): LarkMessage {
  return { messageId: id, chatId, msgType: "text", createdAt, text: `t${id}`, rawContent: "{}" };
}

class FakeGateway implements LarkSourceGateway {
  public sinceByChat = new Map<string, string | undefined>();
  constructor(private readonly byChat: Record<string, LarkMessage[]>) {}
  async *fetchMessages(chatId: string, sinceTime?: string): AsyncGenerator<LarkMessage> {
    this.sinceByChat.set(chatId, sinceTime);
    for (const m of this.byChat[chatId] ?? []) yield m;
  }
}

class InMemoryRepo implements LarkRepository {
  public saved: LarkMessage[] = [];
  async loadAll() {
    return this.saved;
  }
  async upsert(messages: LarkMessage[]) {
    this.saved.push(...messages);
  }
}

class InMemoryWatermark implements WatermarkStore {
  public marks = new Map<string, string>();
  async get(key: string) {
    return this.marks.get(key);
  }
  async set(key: string, time: string) {
    this.marks.set(key, time);
  }
}

describe("CollectLarkMessages", () => {
  it("collects each chat, saves, and advances per-chat watermark to max createdAt", async () => {
    const gw = new FakeGateway({
      oc_a: [msg("om_1", "oc_a", "2026-01-01T00:01:00.000Z"), msg("om_2", "oc_a", "2026-01-01T00:03:00.000Z")],
      oc_b: [msg("om_3", "oc_b", "2026-01-01T00:02:00.000Z")],
    });
    const repo = new InMemoryRepo();
    const wm = new InMemoryWatermark();
    const usecase = new CollectLarkMessages(gw, repo, wm);

    const result = await usecase.run(["oc_a", "oc_b"]);

    expect(result.collected).toBe(3);
    expect(repo.saved).toHaveLength(3);
    expect(wm.marks.get("oc_a")).toBe("2026-01-01T00:03:00.000Z");
    expect(wm.marks.get("oc_b")).toBe("2026-01-01T00:02:00.000Z");
  });

  it("passes the stored per-chat watermark as sinceTime", async () => {
    const gw = new FakeGateway({ oc_a: [] });
    const wm = new InMemoryWatermark();
    wm.marks.set("oc_a", "2026-05-05T00:00:00.000Z");
    const usecase = new CollectLarkMessages(gw, new InMemoryRepo(), wm);
    await usecase.run(["oc_a"]);
    expect(gw.sinceByChat.get("oc_a")).toBe("2026-05-05T00:00:00.000Z");
  });

  it("does not advance a chat's watermark when it collects nothing", async () => {
    const gw = new FakeGateway({ oc_a: [] });
    const wm = new InMemoryWatermark();
    wm.marks.set("oc_a", "2026-05-05T00:00:00.000Z");
    await new CollectLarkMessages(gw, new InMemoryRepo(), wm).run(["oc_a"]);
    expect(wm.marks.get("oc_a")).toBe("2026-05-05T00:00:00.000Z");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm test tests/app/collectLarkMessages.test.ts`
Expected: FAIL — cannot resolve `CollectLarkMessages`.

- [ ] **Step 3: Write `src/app/CollectLarkMessages.ts`**

```ts
import type { LarkMessage } from "../domain/larkMessage";
import type { LarkSourceGateway } from "../ports/LarkSourceGateway";
import type { LarkRepository } from "../ports/LarkRepository";
import type { WatermarkStore } from "../shared/store/WatermarkStore";

export interface CollectLarkResult {
  collected: number;
}

export class CollectLarkMessages {
  constructor(
    private readonly source: LarkSourceGateway,
    private readonly repo: LarkRepository,
    private readonly watermark: WatermarkStore,
  ) {}

  async run(chatIds: string[]): Promise<CollectLarkResult> {
    let collected = 0;

    for (const chatId of chatIds) {
      const since = await this.watermark.get(chatId);

      const messages: LarkMessage[] = [];
      for await (const m of this.source.fetchMessages(chatId, since)) messages.push(m);

      if (messages.length === 0) continue;

      await this.repo.upsert(messages);
      collected += messages.length;

      const maxCreatedAt = this.maxCreatedAt(messages);
      if (maxCreatedAt && (!since || maxCreatedAt > since)) {
        await this.watermark.set(chatId, maxCreatedAt);
      }
    }

    return { collected };
  }

  private maxCreatedAt(messages: LarkMessage[]): string | undefined {
    let max: string | undefined;
    for (const m of messages) {
      if (!max || m.createdAt > max) max = m.createdAt;
    }
    return max;
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm test tests/app/collectLarkMessages.test.ts`
Expected: PASS (3 tests).

- [ ] **Step 5: Commit**

```bash
git add src/app/CollectLarkMessages.ts tests/app/collectLarkMessages.test.ts
git commit -m "feat: CollectLarkMessages use-case (per-chat incremental)"
```

---

## Task 11: Lark config + CLI + live probe + README

**Files:**
- Modify: `src/config.ts`
- Create: `src/cli/collect-lark.ts`, `tests/adapters/lark/larkAuth.probe.test.ts`
- Modify: `package.json` (add `collect-lark` script), `README.md`
- Test: `tests/config.test.ts` (add Lark config cases)

**Interfaces:**
- Consumes: `LarkAuth`, `LarkClient`, `LarkSourceGateway`, `LarkLocalStore`, `CollectLarkMessages`, shared `HttpClient`
- Produces: `loadLarkConfig(): { appId: string; appSecret: string; baseUrl: string; chatIds: string[] }`; runnable `pnpm collect-lark`

- [ ] **Step 1: Write the failing config test**

Add to `tests/config.test.ts` (keep the existing `loadConfig` tests; append a new describe):

```ts
import { loadLarkConfig } from "../src/config";

describe("loadLarkConfig", () => {
  const keys = ["LARK_APP_ID", "LARK_APP_SECRET", "LARK_CHAT_IDS", "LARK_BASE_URL"];
  const original: Record<string, string | undefined> = {};
  beforeEach(() => {
    for (const k of keys) original[k] = process.env[k];
  });
  afterEach(() => {
    for (const k of keys) {
      if (original[k] === undefined) delete process.env[k];
      else process.env[k] = original[k];
    }
  });

  it("parses app id/secret, comma-separated chat ids, and defaults the base url", () => {
    process.env.LARK_APP_ID = "cli_x";
    process.env.LARK_APP_SECRET = "sec";
    process.env.LARK_CHAT_IDS = "oc_a, oc_b";
    delete process.env.LARK_BASE_URL;
    expect(loadLarkConfig()).toEqual({
      appId: "cli_x",
      appSecret: "sec",
      chatIds: ["oc_a", "oc_b"],
      baseUrl: "https://open.larksuite.com",
    });
  });

  it("throws when app id or secret is missing", () => {
    delete process.env.LARK_APP_ID;
    process.env.LARK_APP_SECRET = "sec";
    process.env.LARK_CHAT_IDS = "oc_a";
    expect(() => loadLarkConfig()).toThrow(/LARK_APP_ID/);
  });

  it("throws when no chat ids are configured", () => {
    process.env.LARK_APP_ID = "cli_x";
    process.env.LARK_APP_SECRET = "sec";
    process.env.LARK_CHAT_IDS = "";
    expect(() => loadLarkConfig()).toThrow(/LARK_CHAT_IDS/);
  });
});
```

Add `beforeEach`/`afterEach` to the vitest import at the top of the file if not already present:
```ts
import { describe, it, expect, afterEach, beforeEach } from "vitest";
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm test tests/config.test.ts`
Expected: FAIL — `loadLarkConfig` is not exported.

- [ ] **Step 3: Add `loadLarkConfig` to `src/config.ts`**

Append to the existing `src/config.ts` (keep `loadConfig`):

```ts
export interface LarkConfig {
  appId: string;
  appSecret: string;
  baseUrl: string;
  chatIds: string[];
}

export function loadLarkConfig(): LarkConfig {
  const appId = process.env.LARK_APP_ID;
  const appSecret = process.env.LARK_APP_SECRET;
  if (!appId) throw new Error("Missing required environment variable: LARK_APP_ID");
  if (!appSecret) throw new Error("Missing required environment variable: LARK_APP_SECRET");

  const chatIds = (process.env.LARK_CHAT_IDS ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
  if (chatIds.length === 0) {
    throw new Error("Missing required environment variable: LARK_CHAT_IDS (comma-separated chat_id list)");
  }

  const baseUrl = process.env.LARK_BASE_URL?.trim() || "https://open.larksuite.com";
  return { appId, appSecret, baseUrl, chatIds };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm test tests/config.test.ts`
Expected: PASS (existing + 3 new).

- [ ] **Step 5: Write `src/cli/collect-lark.ts`**

```ts
import { loadLarkConfig } from "../config";
import { HttpClient } from "../shared/http/HttpClient";
import { LarkAuth } from "../adapters/lark/LarkAuth";
import { LarkClient } from "../adapters/lark/LarkClient";
import { LarkSourceGateway } from "../adapters/lark/LarkSourceGateway";
import { LarkLocalStore } from "../adapters/lark/LarkLocalStore";
import { CollectLarkMessages } from "../app/CollectLarkMessages";

const config = loadLarkConfig();
const authHttp = new HttpClient(config.baseUrl);
const auth = new LarkAuth(authHttp, config.appId, config.appSecret);
const client = new LarkClient(config.baseUrl, auth);
const source = new LarkSourceGateway(client);
const store = new LarkLocalStore("output");
const usecase = new CollectLarkMessages(source, store, store);

const result = await usecase.run(config.chatIds);
console.log(`collected ${result.collected} Lark message(s) from ${config.chatIds.length} chat(s)`);
```

- [ ] **Step 6: Add the `collect-lark` script to `package.json`**

In the `"scripts"` block add:
```json
    "collect-lark": "tsx --env-file-if-exists=.env src/cli/collect-lark.ts",
```

- [ ] **Step 7: Write the live probe test**

Create `tests/adapters/lark/larkAuth.probe.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { HttpClient } from "../../../src/shared/http/HttpClient";
import { LarkAuth } from "../../../src/adapters/lark/LarkAuth";
import { LarkClient } from "../../../src/adapters/lark/LarkClient";
import { LarkSourceGateway } from "../../../src/adapters/lark/LarkSourceGateway";

const appId = process.env.LARK_APP_ID;
const appSecret = process.env.LARK_APP_SECRET;
const chatId = (process.env.LARK_CHAT_IDS ?? "").split(",")[0]?.trim();
const baseUrl = process.env.LARK_BASE_URL?.trim() || "https://open.larksuite.com";
const ready = Boolean(appId && appSecret && chatId);

// Skipped unless Lark credentials + a chat id are present (real network + auth).
describe.skipIf(!ready)("PROBE: Lark auth + message list shape", () => {
  it("obtains a token and reads the target chat's message shape", async () => {
    const auth = new LarkAuth(new HttpClient(baseUrl), appId!, appSecret!);
    const token = await auth.getToken();
    expect(token.length).toBeGreaterThan(0);

    const gw = new LarkSourceGateway(new LarkClient(baseUrl, auth));
    let count = 0;
    for await (const m of gw.fetchMessages(chatId!)) {
      count += 1;
      if (count >= 5) break; // cap cost
    }
    // eslint-disable-next-line no-console
    console.log(`[probe] Lark chat ${chatId}: read ${count} text/post message(s)`);
    expect(count).toBeGreaterThanOrEqual(0);
  }, 60000);
});
```

- [ ] **Step 8: Verify probe skips + full suite green**

Run: `pnpm test tests/adapters/lark/larkAuth.probe.test.ts`
Expected: reports the probe as **skipped** (no Lark creds), exit 0.
Run: `pnpm test && pnpm typecheck`
Expected: all pass; typecheck exit 0.

- [ ] **Step 9: Update `README.md`**

Add a section after the module A section:

```markdown
## Subsystem B — Lark data collection

Collects text/post messages from target Lark group chats into local JSON, incrementally per chat.

### Setup

See `docs/lark-setup-guide.md` for how to create the Lark app and find `chat_id`s. Then fill `.env`:
`LARK_APP_ID`, `LARK_APP_SECRET`, `LARK_CHAT_IDS` (comma-separated), and optionally `LARK_BASE_URL`.

### Commands

```bash
pnpm collect-lark       # collect new messages from all configured chats
```

Output is written to `output/` (git-ignored): `lark-items.json` and `lark-state.json` (per-chat watermarks).
```

- [ ] **Step 10: Commit**

```bash
git add -A
git commit -m "feat: Lark config, collect-lark CLI, live probe, and README"
```

---

## Self-Review (completed during authoring)

- **Spec coverage:** shared extraction (§3-1) → Tasks 1–2; LarkMessage + extractText (§4) → Task 3; ports (§5) → Task 4; schemas/normalize + envelope check (§4/§9) → Task 5; auth token caching (§6-1) → Task 6; Bearer + envelope + refresh (§6-2) → Task 7; pagination + type filter (§7-2) → Task 8; per-chat store + watermark (§8) → Task 9; use-case (§7-1) → Task 10; config/secrets/CLI/probe (§11/§13/§12) → Task 11. Every spec section maps to a task.
- **Placeholder scan:** every code/test step has complete code and exact commands. No TBD/TODO.
- **Type consistency:** `LarkMessage`, `WatermarkStore` (keyed), `LarkSourceGateway`, `LarkRepository`, `LarkAuth.getToken`, `LarkClient.get`, `normalizeMessage`/`parseMessagesData`, `loadLarkConfig` are defined once and consumed with matching signatures across tasks. Module A's `WatermarkStore` migration (single→keyed) is applied consistently in Task 2 (store, use-case, and both affected tests).

## Notes / Deferred (out of scope for subsystem B)

- Chat discovery (list chats to find chat_id) is manual/provisioning (`docs/lark-setup-guide.md`), not built.
- Rich `post` structures beyond text nodes (e.g. @mentions rendered specially) flatten to their `text` field only.
- Drive/Sheet output → new `LarkRepository` adapter (subsystem D/G).
- Unifying `SourceTweet` + `LarkMessage` under one content abstraction → deferred to translation (subsystem C).
