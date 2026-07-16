# Lark chat listing + message send — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship two productionized Lark CLIs — `lark:chats` (list the chats the bot is in) and `lark:send` (send a text message to a chat) — as the foundation for §10 (Lark bot).

**Architecture:** Hexagonal, mirroring the existing Lark adapters (`LarkSourceGateway`, `LarkClient`, `schemas.ts`): port → adapter → (app use-case) → cli. `lark:chats` is a read utility whose CLI calls its adapter directly; `lark:send` adds a `LarkClient.post`, a sender adapter, and a thin `SendLarkMessage` use-case (the §10 growth seam).

**Tech Stack:** TypeScript ESM, `zod` (only runtime dep), native `fetch` via the existing `HttpClient`, `tsx` CLIs, `vitest`.

## Global Constraints

- Code and comments in **English**.
- `zod` is the **only** runtime dependency — no new deps.
- ESM `moduleResolution: bundler` — **no `.js` extensions** in imports.
- Reuse `loadLarkConfig()` (`appId` / `appSecret` / `baseUrl` / `chatIds`), `LarkAuth`, `LarkClient`, `src/cli/registerErrorHandler.ts` (import first line of every CLI), `src/cli/args.ts` (`argValue`).
- Validate every Lark API envelope and **throw on `code !== 0`** (as `parseMessagesData` does).
- Text messages only (v1). No new OAuth scope or config.
- TDD: failing test first, minimal code, commit per task.

---

### Task 1: `lark:chats` — list chats end-to-end

**Files:**
- Create: `src/domain/larkChat.ts`
- Modify: `src/adapters/lark/schemas.ts` (add `ChatRaw` + `parseChatsData`)
- Create: `src/ports/LarkChatGateway.ts`
- Create: `src/adapters/lark/LarkChatGateway.ts`
- Create: `src/cli/lark-chats.ts`
- Modify: `package.json` (add `lark:chats` script)
- Test: `tests/adapters/lark/schemas.test.ts` (new), `tests/adapters/lark/larkChatGateway.test.ts` (new)

**Interfaces:**
- Consumes: `LarkClient.get<T>(path, params?)`, `MessagesEnvelope` (already in `schemas.ts`).
- Produces: `LarkChatSummary { chatId: string; name: string }`; `parseChatsData(response): { items: LarkChatSummary[]; pageToken: string; hasMore: boolean }`; port `LarkChatGateway.listChats(): Promise<LarkChatSummary[]>`; adapter class `LarkChatGateway`.

- [ ] **Step 1: Write the failing schema test** — `tests/adapters/lark/schemas.test.ts`

```ts
import { describe, it, expect } from "vitest";
import { parseChatsData } from "../../../src/adapters/lark/schemas";

describe("parseChatsData", () => {
  it("maps chat items and pagination fields", () => {
    const r = parseChatsData({
      code: 0,
      data: { items: [{ chat_id: "oc_1", name: "Group A" }], page_token: "pt", has_more: true },
    });
    expect(r.items).toEqual([{ chatId: "oc_1", name: "Group A" }]);
    expect(r.pageToken).toBe("pt");
    expect(r.hasMore).toBe(true);
  });

  it("defaults a missing name to an empty string", () => {
    const r = parseChatsData({ code: 0, data: { items: [{ chat_id: "oc_1" }], has_more: false } });
    expect(r.items).toEqual([{ chatId: "oc_1", name: "" }]);
  });

  it("throws on a non-zero code", () => {
    expect(() => parseChatsData({ code: 230002, msg: "no permission" })).toThrow(/230002/);
  });
});
```

- [ ] **Step 2: Run it — verify it fails**

Run: `pnpm vitest run tests/adapters/lark/schemas.test.ts`
Expected: FAIL — `parseChatsData` is not exported.

- [ ] **Step 3: Add `ChatRaw` + `parseChatsData` to `src/adapters/lark/schemas.ts`**

Append after the existing `parseMessagesData` function:

```ts
const ChatRaw = z
  .object({
    chat_id: z.string(),
    name: z.string().nullish(),
  })
  .passthrough();

/** Validate a chats-list envelope; throw on code !== 0. */
export function parseChatsData(response: unknown): {
  items: { chatId: string; name: string }[];
  pageToken: string;
  hasMore: boolean;
} {
  const env = MessagesEnvelope.parse(response);
  if (env.code !== 0) {
    throw new Error(`Lark API error: code=${env.code} ${env.msg ?? ""}`.trim());
  }
  const items = (env.data?.items ?? []).map((raw) => {
    const c = ChatRaw.parse(raw);
    return { chatId: c.chat_id, name: c.name ?? "" };
  });
  return {
    items,
    pageToken: env.data?.page_token ?? "",
    hasMore: env.data?.has_more ?? false,
  };
}
```

- [ ] **Step 4: Run it — verify it passes**

Run: `pnpm vitest run tests/adapters/lark/schemas.test.ts`
Expected: PASS (3 tests).

- [ ] **Step 5: Create the domain type** — `src/domain/larkChat.ts`

```ts
/** A chat (group / p2p) the bot is a member of. */
export interface LarkChatSummary {
  chatId: string;
  name: string;
}
```

- [ ] **Step 6: Create the port** — `src/ports/LarkChatGateway.ts`

```ts
import type { LarkChatSummary } from "../domain/larkChat";

export interface LarkChatGateway {
  /** All chats (groups / p2p) the bot is a member of. */
  listChats(): Promise<LarkChatSummary[]>;
}
```

- [ ] **Step 7: Write the failing adapter test** — `tests/adapters/lark/larkChatGateway.test.ts`

```ts
import { describe, it, expect } from "vitest";
import { LarkChatGateway } from "../../../src/adapters/lark/LarkChatGateway";

class FakeClient {
  public calls: Record<string, string>[] = [];
  constructor(private readonly responder: (params?: Record<string, string>) => unknown) {}
  async get<T>(_path: string, params?: Record<string, string>): Promise<T> {
    this.calls.push(params ?? {});
    return this.responder(params) as T;
  }
}

describe("LarkChatGateway", () => {
  it("paginates via page_token and returns all chat summaries", async () => {
    const client = new FakeClient((params) =>
      params?.page_token
        ? { code: 0, data: { items: [{ chat_id: "oc_2", name: "B" }], has_more: false } }
        : { code: 0, data: { items: [{ chat_id: "oc_1", name: "A" }], has_more: true, page_token: "pt1" } },
    );
    const gw = new LarkChatGateway(client);

    const chats = await gw.listChats();

    expect(chats).toEqual([
      { chatId: "oc_1", name: "A" },
      { chatId: "oc_2", name: "B" },
    ]);
    expect(client.calls[0].page_size).toBe("100");
    expect(client.calls[1].page_token).toBe("pt1");
  });
});
```

- [ ] **Step 8: Run it — verify it fails**

Run: `pnpm vitest run tests/adapters/lark/larkChatGateway.test.ts`
Expected: FAIL — `LarkChatGateway` module not found.

- [ ] **Step 9: Create the adapter** — `src/adapters/lark/LarkChatGateway.ts`

```ts
import type { LarkChatSummary } from "../../domain/larkChat";
import type { LarkChatGateway as LarkChatGatewayPort } from "../../ports/LarkChatGateway";
import { parseChatsData } from "./schemas";

interface ChatClient {
  get<T>(path: string, params?: Record<string, string>): Promise<T>;
}

export class LarkChatGateway implements LarkChatGatewayPort {
  constructor(private readonly client: ChatClient) {}

  async listChats(): Promise<LarkChatSummary[]> {
    const chats: LarkChatSummary[] = [];
    let pageToken = "";
    while (true) {
      const params: Record<string, string> = { page_size: "100" };
      if (pageToken) params["page_token"] = pageToken;
      const data = await this.client.get<unknown>("/open-apis/im/v1/chats", params);
      const { items, pageToken: next, hasMore } = parseChatsData(data);
      for (const c of items) chats.push(c);
      if (!hasMore || !next) break;
      pageToken = next;
    }
    return chats;
  }
}
```

- [ ] **Step 10: Run it — verify it passes**

Run: `pnpm vitest run tests/adapters/lark/larkChatGateway.test.ts`
Expected: PASS.

- [ ] **Step 11: Create the CLI** — `src/cli/lark-chats.ts`

```ts
import "./registerErrorHandler";
import { loadLarkConfig } from "../config";
import { HttpClient } from "../shared/http/HttpClient";
import { LarkAuth } from "../adapters/lark/LarkAuth";
import { LarkClient } from "../adapters/lark/LarkClient";
import { LarkChatGateway } from "../adapters/lark/LarkChatGateway";

const config = loadLarkConfig();
const auth = new LarkAuth(new HttpClient(config.baseUrl), config.appId, config.appSecret);
const client = new LarkClient(config.baseUrl, auth);
const gateway = new LarkChatGateway(client);

const chats = await gateway.listChats();
if (chats.length === 0) {
  console.log("The bot is not in any chats yet. Add it to a group in Lark, then re-run.");
} else {
  console.log(`bot is in ${chats.length} chat(s):`);
  for (const c of chats) console.log(`  ${c.chatId}  ${c.name}`);
}
```

- [ ] **Step 12: Add the `package.json` script**

In the `"scripts"` block, next to `"collect-lark"`, add:

```json
    "lark:chats": "tsx --env-file-if-exists=.env src/cli/lark-chats.ts",
```

- [ ] **Step 13: Typecheck**

Run: `pnpm exec tsc --noEmit`
Expected: no errors.

- [ ] **Step 14: Commit**

```bash
git add src/domain/larkChat.ts src/ports/LarkChatGateway.ts src/adapters/lark/LarkChatGateway.ts src/adapters/lark/schemas.ts src/cli/lark-chats.ts package.json tests/adapters/lark/schemas.test.ts tests/adapters/lark/larkChatGateway.test.ts
git commit -m "feat(lark): add lark:chats to list the bot's chats"
```

---

### Task 2: `LarkClient.post` with auth-retry

**Files:**
- Modify: `src/adapters/lark/LarkClient.ts` (add `post` + `callPost`)
- Test: `tests/adapters/lark/larkClient.test.ts` (extend `SpyHttp`, add 2 tests)

**Interfaces:**
- Consumes: `IHttpClient.post<T>(path, body?)` (already exists), `LarkAuth.getToken(force?)`.
- Produces: `LarkClient.post<T>(path: string, body?: unknown): Promise<T>` — injects the bearer token and, on a Lark auth-error envelope (code 99991661/99991663/99991664), refreshes the token once and retries.

- [ ] **Step 1: Make `SpyHttp.post` record, and add the failing tests** — edit `tests/adapters/lark/larkClient.test.ts`

Replace the `SpyHttp` class body's `post` line so it records like `get`:

```ts
class SpyHttp implements IHttpClient {
  public authHeaders: (string | undefined)[] = [];
  public bodies: unknown[] = [];
  constructor(private readonly headers: Record<string, string>, private readonly responder: () => unknown) {}
  async get<T>(): Promise<T> {
    this.authHeaders.push(this.headers["Authorization"]);
    return this.responder() as T;
  }
  async post<T>(_path: string, body?: unknown): Promise<T> {
    this.authHeaders.push(this.headers["Authorization"]);
    this.bodies.push(body);
    return this.responder() as T;
  }
  async patch<T>(): Promise<T> { throw new Error("no"); }
  async delete<T>(): Promise<T> { throw new Error("no"); }
}
```

Then add these two tests inside the `describe("LarkClient", …)` block:

```ts
  it("injects the bearer token and passes the body on POST", async () => {
    const spies: SpyHttp[] = [];
    const client = new LarkClient("https://open.larksuite.com", authReturning("t-abc"), (_base, headers) => {
      const s = new SpyHttp(headers, () => ({ code: 0, data: { message_id: "om_1" } }));
      spies.push(s);
      return s;
    });

    await client.post("/open-apis/im/v1/messages", { receive_id: "oc_x" });

    expect(spies[0].authHeaders[0]).toBe("Bearer t-abc");
    expect(spies[0].bodies[0]).toEqual({ receive_id: "oc_x" });
  });

  it("refreshes the token once and retries on an auth-error envelope (POST)", async () => {
    let call = 0;
    const client = new LarkClient("https://open.larksuite.com", authReturning("t-abc"), (_base, headers) => {
      return new SpyHttp(headers, () => (++call === 1 ? { code: 99991663, msg: "expired" } : { code: 0, data: {} }));
    });

    const res = await client.post<{ code: number }>("/open-apis/im/v1/messages", {});

    expect(res.code).toBe(0);
    expect(call).toBe(2);
  });
```

- [ ] **Step 2: Run it — verify it fails**

Run: `pnpm vitest run tests/adapters/lark/larkClient.test.ts`
Expected: FAIL — `client.post` is not a function.

- [ ] **Step 3: Add `post` + `callPost` to `src/adapters/lark/LarkClient.ts`**

After the existing `private call<T>(…)` method, add:

```ts
  async post<T>(path: string, body?: unknown): Promise<T> {
    let token = await this.auth.getToken();
    let res = await this.callPost<T>(path, body, token);
    if (this.isAuthError(res)) {
      token = await this.auth.getToken(true);
      res = await this.callPost<T>(path, body, token);
    }
    return res;
  }

  private callPost<T>(path: string, body: unknown, token: string): Promise<T> {
    const http = this.makeHttp(this.baseUrl, { Authorization: `Bearer ${token}` });
    return http.post<T>(path, body);
  }
```

- [ ] **Step 4: Run it — verify it passes**

Run: `pnpm vitest run tests/adapters/lark/larkClient.test.ts`
Expected: PASS (all 4 tests — 2 existing GET + 2 new POST).

- [ ] **Step 5: Typecheck + commit**

```bash
pnpm exec tsc --noEmit
git add src/adapters/lark/LarkClient.ts tests/adapters/lark/larkClient.test.ts
git commit -m "feat(lark): add LarkClient.post with auth-retry"
```

---

### Task 3: Message sender (schema + port + adapter)

**Files:**
- Modify: `src/adapters/lark/schemas.ts` (add `SendEnvelope` + `parseSendResult`)
- Create: `src/ports/LarkMessageSender.ts`
- Create: `src/adapters/lark/LarkMessageSender.ts`
- Test: `tests/adapters/lark/schemas.test.ts` (add `parseSendResult` tests), `tests/adapters/lark/larkMessageSender.test.ts` (new)

**Interfaces:**
- Consumes: `LarkClient.post<T>(path, body?)` (Task 2).
- Produces: `parseSendResult(response): string` (the created `message_id`); port `LarkMessageSender.sendText(chatId, text): Promise<string>`; adapter class `LarkMessageSender` that POSTs to `/open-apis/im/v1/messages?receive_id_type=chat_id`.

- [ ] **Step 1: Add the failing `parseSendResult` tests** — append to `tests/adapters/lark/schemas.test.ts`

```ts
import { parseSendResult } from "../../../src/adapters/lark/schemas";

describe("parseSendResult", () => {
  it("returns the created message_id", () => {
    expect(parseSendResult({ code: 0, data: { message_id: "om_9" } })).toBe("om_9");
  });

  it("throws on a non-zero code", () => {
    expect(() => parseSendResult({ code: 230002, msg: "no permission" })).toThrow(/230002/);
  });
});
```

(Add the `parseSendResult` name to the existing top import from `schemas` if you prefer a single import line; a second `import` statement is also fine.)

- [ ] **Step 2: Run it — verify it fails**

Run: `pnpm vitest run tests/adapters/lark/schemas.test.ts`
Expected: FAIL — `parseSendResult` is not exported.

- [ ] **Step 3: Add `SendEnvelope` + `parseSendResult` to `src/adapters/lark/schemas.ts`**

```ts
const SendEnvelope = z.object({
  code: z.number(),
  msg: z.string().optional(),
  data: z.object({ message_id: z.string() }).nullish(),
});

/** Validate a message-send envelope; throw on code !== 0; return the created message_id. */
export function parseSendResult(response: unknown): string {
  const env = SendEnvelope.parse(response);
  if (env.code !== 0 || !env.data?.message_id) {
    throw new Error(`Lark API error: code=${env.code} ${env.msg ?? ""}`.trim());
  }
  return env.data.message_id;
}
```

- [ ] **Step 4: Run it — verify it passes**

Run: `pnpm vitest run tests/adapters/lark/schemas.test.ts`
Expected: PASS.

- [ ] **Step 5: Create the port** — `src/ports/LarkMessageSender.ts`

```ts
export interface LarkMessageSender {
  /** Send a plain-text message to a chat; resolves to the created message_id. */
  sendText(chatId: string, text: string): Promise<string>;
}
```

- [ ] **Step 6: Write the failing adapter test** — `tests/adapters/lark/larkMessageSender.test.ts`

```ts
import { describe, it, expect } from "vitest";
import { LarkMessageSender } from "../../../src/adapters/lark/LarkMessageSender";

class FakeClient {
  public calls: { path: string; body?: unknown }[] = [];
  constructor(private readonly responder: () => unknown) {}
  async post<T>(path: string, body?: unknown): Promise<T> {
    this.calls.push({ path, body });
    return this.responder() as T;
  }
}

describe("LarkMessageSender", () => {
  it("posts a text message and returns the message_id", async () => {
    const client = new FakeClient(() => ({ code: 0, data: { message_id: "om_1" } }));
    const sender = new LarkMessageSender(client);

    const id = await sender.sendText("oc_x", "hello");

    expect(id).toBe("om_1");
    expect(client.calls[0].path).toBe("/open-apis/im/v1/messages?receive_id_type=chat_id");
    expect(client.calls[0].body).toEqual({
      receive_id: "oc_x",
      msg_type: "text",
      content: JSON.stringify({ text: "hello" }),
    });
  });

  it("throws on a non-zero code", async () => {
    const client = new FakeClient(() => ({ code: 230002, msg: "no permission" }));
    const sender = new LarkMessageSender(client);
    await expect(sender.sendText("oc_x", "hi")).rejects.toThrow(/230002/);
  });
});
```

- [ ] **Step 7: Run it — verify it fails**

Run: `pnpm vitest run tests/adapters/lark/larkMessageSender.test.ts`
Expected: FAIL — `LarkMessageSender` module not found.

- [ ] **Step 8: Create the adapter** — `src/adapters/lark/LarkMessageSender.ts`

```ts
import type { LarkMessageSender as LarkMessageSenderPort } from "../../ports/LarkMessageSender";
import { parseSendResult } from "./schemas";

interface SendClient {
  post<T>(path: string, body?: unknown): Promise<T>;
}

export class LarkMessageSender implements LarkMessageSenderPort {
  constructor(private readonly client: SendClient) {}

  async sendText(chatId: string, text: string): Promise<string> {
    const body = {
      receive_id: chatId,
      msg_type: "text",
      content: JSON.stringify({ text }),
    };
    const res = await this.client.post<unknown>(
      "/open-apis/im/v1/messages?receive_id_type=chat_id",
      body,
    );
    return parseSendResult(res);
  }
}
```

- [ ] **Step 9: Run it — verify it passes**

Run: `pnpm vitest run tests/adapters/lark/larkMessageSender.test.ts`
Expected: PASS.

- [ ] **Step 10: Typecheck + commit**

```bash
pnpm exec tsc --noEmit
git add src/adapters/lark/schemas.ts src/ports/LarkMessageSender.ts src/adapters/lark/LarkMessageSender.ts tests/adapters/lark/schemas.test.ts tests/adapters/lark/larkMessageSender.test.ts
git commit -m "feat(lark): add LarkMessageSender (send text via im/v1/messages)"
```

---

### Task 4: `SendLarkMessage` use-case + `lark:send` CLI + packaging

**Files:**
- Create: `src/app/SendLarkMessage.ts`
- Create: `src/cli/lark-send.ts`
- Modify: `package.json` (add `lark:send` script)
- Modify: `CHANGELOG.md` (`[Unreleased] → Added`: both commands)
- Test: `tests/app/sendLarkMessage.test.ts` (new)

**Interfaces:**
- Consumes: port `LarkMessageSender` (Task 3), adapter `LarkMessageSender`, `LarkClient` (Task 2), `argValue` from `src/cli/args.ts`, `loadLarkConfig()`.
- Produces: `SendLarkMessage.run(chatId, text): Promise<{ messageId: string }>`; CLI `lark:send --chat <id> --text <...>`.

- [ ] **Step 1: Write the failing use-case test** — `tests/app/sendLarkMessage.test.ts`

```ts
import { describe, it, expect } from "vitest";
import { SendLarkMessage } from "../../src/app/SendLarkMessage";
import type { LarkMessageSender } from "../../src/ports/LarkMessageSender";

class FakeSender implements LarkMessageSender {
  public calls: { chatId: string; text: string }[] = [];
  async sendText(chatId: string, text: string): Promise<string> {
    this.calls.push({ chatId, text });
    return "om_sent";
  }
}

describe("SendLarkMessage", () => {
  it("delegates to the sender and returns the message id", async () => {
    const sender = new FakeSender();
    const result = await new SendLarkMessage(sender).run("oc_x", "hello");
    expect(result).toEqual({ messageId: "om_sent" });
    expect(sender.calls).toEqual([{ chatId: "oc_x", text: "hello" }]);
  });
});
```

- [ ] **Step 2: Run it — verify it fails**

Run: `pnpm vitest run tests/app/sendLarkMessage.test.ts`
Expected: FAIL — `SendLarkMessage` module not found.

- [ ] **Step 3: Create the use-case** — `src/app/SendLarkMessage.ts`

```ts
import type { LarkMessageSender } from "../ports/LarkMessageSender";

export interface SendLarkResult {
  messageId: string;
}

export class SendLarkMessage {
  constructor(private readonly sender: LarkMessageSender) {}

  async run(chatId: string, text: string): Promise<SendLarkResult> {
    const messageId = await this.sender.sendText(chatId, text);
    return { messageId };
  }
}
```

- [ ] **Step 4: Run it — verify it passes**

Run: `pnpm vitest run tests/app/sendLarkMessage.test.ts`
Expected: PASS.

- [ ] **Step 5: Create the CLI** — `src/cli/lark-send.ts`

```ts
import "./registerErrorHandler";
import { argValue } from "./args";
import { loadLarkConfig } from "../config";
import { HttpClient } from "../shared/http/HttpClient";
import { LarkAuth } from "../adapters/lark/LarkAuth";
import { LarkClient } from "../adapters/lark/LarkClient";
import { LarkMessageSender } from "../adapters/lark/LarkMessageSender";
import { SendLarkMessage } from "../app/SendLarkMessage";

const config = loadLarkConfig();
const text = argValue("--text");
if (!text) throw new Error("Missing --text. Usage: pnpm lark:send --chat <id> --text <message>");
const chatId = argValue("--chat") ?? config.chatIds[0];
if (!chatId) throw new Error("No chat id. Pass --chat <id> or set LARK_CHAT_IDS in .env");

const auth = new LarkAuth(new HttpClient(config.baseUrl), config.appId, config.appSecret);
const client = new LarkClient(config.baseUrl, auth);
const usecase = new SendLarkMessage(new LarkMessageSender(client));

const { messageId } = await usecase.run(chatId, text);
console.log(`sent message ${messageId} to ${chatId}`);
```

- [ ] **Step 6: Add the `package.json` script**

Next to `"lark:chats"`, add:

```json
    "lark:send": "tsx --env-file-if-exists=.env src/cli/lark-send.ts",
```

- [ ] **Step 7: Add the CHANGELOG entries**

In `CHANGELOG.md`, under `## [Unreleased]` → `### Added`, add:

```markdown
- **`pnpm lark:chats`** — lists the chats the Lark bot is a member of (id + name), so you can find a
  chat id for `LARK_CHAT_IDS` without a raw API call.
- **`pnpm lark:send --chat <id> --text <…>`** — sends a text message to a Lark chat (defaults the
  chat to the first `LARK_CHAT_IDS` entry). The foundation for §10 (Lark bot); pipeline-content
  wiring is a follow-up.
```

- [ ] **Step 8: Typecheck + full suite**

Run: `pnpm exec tsc --noEmit && pnpm vitest run`
Expected: typecheck clean; all tests pass (existing + the new Lark tests).

- [ ] **Step 9: Commit**

```bash
git add src/app/SendLarkMessage.ts src/cli/lark-send.ts package.json CHANGELOG.md tests/app/sendLarkMessage.test.ts
git commit -m "feat(lark): add lark:send CLI + SendLarkMessage use-case"
```

---

## Manual acceptance (after all tasks, live)

With the test group joined and `LARK_CHAT_IDS` set:

```bash
pnpm lark:chats                                   # prints oc_0a6b7f…  🧪 Mantle KR Herald — Collection Test
pnpm lark:send --text "lark:send CLI 동작 확인"    # prints: sent message om_… to oc_0a6b7f…
```

Confirm the message appears in the Lark group.

## Self-review notes

- **Spec coverage:** #1 (domain/schema/port/adapter/cli/script) → Task 1. #2 `LarkClient.post` → Task 2; sender schema/port/adapter → Task 3; use-case + CLI + scripts + CHANGELOG → Task 4. Testing section → each task's TDD steps. ✓
- **Type consistency:** `LarkChatSummary`, `parseChatsData` return shape, `LarkClient.post` signature, `LarkMessageSender.sendText`, and `SendLarkMessage.run` names/shapes are consistent across the tasks that produce and consume them. ✓
- **No placeholders:** every code step shows complete code. ✓
