# X Data Collection (Module A) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Collect `Mantle_Official`'s own authored tweets (with threads reconstructed) from twitterapi.io into local JSON, incrementally, with soft-mark deletion handling.

**Architecture:** Hexagonal (ports & adapters). Pure `domain` (models + thread assembly) at the center; `ports` (SourceGateway, CollectionRepository, WatermarkStore) as interfaces; `adapters` (twitterapi.io HTTP + local JSON store) implementing them; `app` use-cases (`CollectAuthoredContent`, `ReconcileDeletions`) composing ports; `cli` composition roots wiring concrete adapters. Dependencies always point inward. See `docs/architecture/hexagonal-architecture.md`.

**Tech Stack:** TypeScript (ESM), pnpm, Node 24, native `fetch`, `zod` (runtime response validation), `vitest` (tests), `tsx` (run).

## Global Constraints

- **Language:** All code, identifiers, and comments in English. (Chat is Korean; code is English.)
- **Runtime dependency limit:** exactly one — `zod`. No HTTP library (use native `fetch`). No `dotenv` (use Node's `--env-file-if-exists`).
- **Module system:** ESM (`"type": "module"`), `moduleResolution: bundler` — imports do NOT need `.js` extensions.
- **Node floor:** Node 24 (native `fetch`, `--env-file-if-exists`). pnpm 11.9.
- **Secrets:** read `TWITTERAPI_IO_KEY` from env only. Never log or commit keys. `output/`, `.env`, `design/` are git-ignored (already in `.gitignore`).
- **Target account:** `Mantle_Official`. Collect only its own authored tweets; exclude retweets, mentions, others' replies.
- **Thread key:** group tweets into a thread by `conversationId` (root tweet's id). A standalone tweet has `conversationId === id`.
- **Deletion policy:** soft-mark only. Never delete stored items; set thread `status = "deleted"` + `deletedAt`. Marking is at thread granularity (a thread is the pipeline unit).
- **Watermark:** advance only after a successful save; store as the max tweet `createdAt` (ISO 8601 UTC).
- **TDD:** write the failing test first for every unit with logic. Commit after each green task.

---

## File Structure

| File | Responsibility |
|---|---|
| `package.json`, `tsconfig.json` | Project config, scripts, deps |
| `.env.example` | Documents `TWITTERAPI_IO_KEY` |
| `src/domain/models.ts` | Domain types: `SourceTweet`, `AssembledThread`, `CollectedThread`, etc. (no I/O) |
| `src/domain/threadAssembler.ts` | Pure: `SourceTweet[]` → `AssembledThread[]` grouped by `conversationId` |
| `src/ports/SourceGateway.ts` | Interface: fetch authored tweets / thread / by-ids |
| `src/ports/CollectionRepository.ts` | Interface: persist & query collected threads |
| `src/ports/WatermarkStore.ts` | Interface: get/set incremental watermark |
| `src/ports/Clock.ts` | `Clock` type for injectable `now()` (testability) |
| `src/adapters/twitterapi/IHttpClient.ts` | HTTP port (ported from twitterapi-io) |
| `src/adapters/twitterapi/HttpClient.ts` | HTTP impl: retry/backoff/error-map (ported) |
| `src/adapters/twitterapi/TwitterClient.ts` | x-api-key adapter (ported) |
| `src/adapters/twitterapi/schemas.ts` | zod schemas + `normalizeTweet(raw) → SourceTweet` |
| `src/adapters/twitterapi/TwitterApiSourceGateway.ts` | `SourceGateway` impl over `IHttpClient` |
| `src/adapters/store/LocalJsonStore.ts` | `CollectionRepository` + `WatermarkStore` over `output/` |
| `src/app/CollectAuthoredContent.ts` | Use-case: incremental collect + gap-fill + watermark |
| `src/app/ReconcileDeletions.ts` | Use-case: batch existence check + soft-mark |
| `src/config.ts` | `loadConfig()` — reads `TWITTERAPI_IO_KEY` |
| `src/cli/collect.ts`, `src/cli/reconcile.ts` | Composition roots |
| `tests/**` | vitest unit tests + quote-retweet probe |

---

## Task 1: Project scaffolding

**Files:**
- Create: `package.json`, `tsconfig.json`, `.env.example`
- Test: `tests/smoke.test.ts`

**Interfaces:**
- Consumes: nothing
- Produces: `pnpm test`, `pnpm typecheck`, `pnpm collect`, `pnpm reconcile` scripts; ESM+TS toolchain

- [ ] **Step 1: Create `package.json`**

```json
{
  "name": "mantle-kr-herald",
  "version": "0.1.0",
  "private": true,
  "type": "module",
  "packageManager": "pnpm@11.9.0",
  "scripts": {
    "collect": "tsx --env-file-if-exists=.env src/cli/collect.ts",
    "reconcile": "tsx --env-file-if-exists=.env src/cli/reconcile.ts",
    "test": "vitest run",
    "test:watch": "vitest",
    "typecheck": "tsc --noEmit"
  },
  "dependencies": {
    "zod": "^3.24.1"
  },
  "devDependencies": {
    "@types/node": "^22.10.5",
    "tsx": "^4.19.2",
    "typescript": "^5.7.3",
    "vitest": "^2.1.8"
  }
}
```

- [ ] **Step 2: Create `tsconfig.json`**

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "ESNext",
    "moduleResolution": "bundler",
    "lib": ["ES2022"],
    "types": ["node"],
    "strict": true,
    "esModuleInterop": true,
    "skipLibCheck": true,
    "resolveJsonModule": true,
    "noEmit": true
  },
  "include": ["src", "tests"]
}
```

- [ ] **Step 3: Create `.env.example`**

```bash
# Required for all twitterapi.io reads
TWITTERAPI_IO_KEY=
```

- [ ] **Step 4: Install dependencies**

Run: `pnpm install`
Expected: lockfile created, `node_modules/` populated (git-ignored).

- [ ] **Step 5: Write the smoke test**

Create `tests/smoke.test.ts`:

```ts
import { describe, it, expect } from "vitest";

describe("toolchain", () => {
  it("runs vitest with TypeScript + ESM", () => {
    const value: number = 1 + 1;
    expect(value).toBe(2);
  });
});
```

- [ ] **Step 6: Run the smoke test**

Run: `pnpm test`
Expected: PASS (1 test).

- [ ] **Step 7: Verify typecheck**

Run: `pnpm typecheck`
Expected: no errors (exit 0).

- [ ] **Step 8: Commit**

```bash
git add package.json tsconfig.json .env.example tests/smoke.test.ts pnpm-lock.yaml
git commit -m "chore: scaffold TypeScript/pnpm project for module A"
```

---

## Task 2: Domain models + thread assembler (pure)

**Files:**
- Create: `src/domain/models.ts`, `src/domain/threadAssembler.ts`
- Test: `tests/domain/threadAssembler.test.ts`

**Interfaces:**
- Consumes: nothing
- Produces:
  - `SourceTweet { id: string; conversationId: string; text: string; createdAt: string; url: string; authorUserName: string; isReply: boolean; isQuote: boolean; media?: MediaItem[]; metrics?: TweetMetrics }`
  - `MediaItem { type: "photo" | "video" | "animated_gif"; url: string }`
  - `TweetMetrics { likeCount?: number; retweetCount?: number; replyCount?: number; quoteCount?: number; viewCount?: number; bookmarkCount?: number }`
  - `AssembledThread { rootId: string; tweets: SourceTweet[] }`
  - `CollectionStatus = "active" | "deleted"`
  - `CollectedThread { rootId: string; tweets: SourceTweet[]; status: CollectionStatus; firstSeenAt: string; deletedAt?: string }`
  - `assembleThreads(tweets: SourceTweet[]): AssembledThread[]`

- [ ] **Step 1: Write the failing test**

Create `tests/domain/threadAssembler.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { assembleThreads } from "../../src/domain/threadAssembler";
import type { SourceTweet } from "../../src/domain/models";

function tweet(partial: Partial<SourceTweet> & { id: string }): SourceTweet {
  return {
    id: partial.id,
    conversationId: partial.conversationId ?? partial.id,
    text: partial.text ?? "text",
    createdAt: partial.createdAt ?? "2026-01-01T00:00:00.000Z",
    url: partial.url ?? `https://x.com/Mantle_Official/status/${partial.id}`,
    authorUserName: partial.authorUserName ?? "Mantle_Official",
    isReply: partial.isReply ?? false,
    isQuote: partial.isQuote ?? false,
    media: partial.media,
    metrics: partial.metrics,
  };
}

describe("assembleThreads", () => {
  it("wraps a standalone tweet as a length-1 thread", () => {
    const result = assembleThreads([tweet({ id: "1" })]);
    expect(result).toEqual([{ rootId: "1", tweets: [expect.objectContaining({ id: "1" })] }]);
  });

  it("groups a self-thread by conversationId, sorted chronologically", () => {
    const t2 = tweet({ id: "2", conversationId: "1", createdAt: "2026-01-01T00:02:00.000Z" });
    const t1 = tweet({ id: "1", conversationId: "1", createdAt: "2026-01-01T00:01:00.000Z" });
    const result = assembleThreads([t2, t1]);
    expect(result).toHaveLength(1);
    expect(result[0].rootId).toBe("1");
    expect(result[0].tweets.map((t) => t.id)).toEqual(["1", "2"]);
  });

  it("dedups tweets by id (last wins)", () => {
    const result = assembleThreads([tweet({ id: "1", text: "old" }), tweet({ id: "1", text: "new" })]);
    expect(result).toHaveLength(1);
    expect(result[0].tweets).toHaveLength(1);
    expect(result[0].tweets[0].text).toBe("new");
  });

  it("returns separate threads ordered by earliest createdAt", () => {
    const a = tweet({ id: "10", createdAt: "2026-01-01T00:05:00.000Z" });
    const b = tweet({ id: "20", createdAt: "2026-01-01T00:01:00.000Z" });
    const result = assembleThreads([a, b]);
    expect(result.map((t) => t.rootId)).toEqual(["20", "10"]);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm test tests/domain/threadAssembler.test.ts`
Expected: FAIL — cannot resolve `assembleThreads` / `models`.

- [ ] **Step 3: Write `src/domain/models.ts`**

```ts
export type CollectionStatus = "active" | "deleted";

export interface MediaItem {
  type: "photo" | "video" | "animated_gif";
  url: string;
}

export interface TweetMetrics {
  likeCount?: number;
  retweetCount?: number;
  replyCount?: number;
  quoteCount?: number;
  viewCount?: number;
  bookmarkCount?: number;
}

export interface SourceTweet {
  id: string;
  conversationId: string; // thread key; the root tweet's id
  text: string;
  createdAt: string; // ISO 8601 UTC
  url: string;
  authorUserName: string;
  isReply: boolean;
  isQuote: boolean; // quoted_tweet present in the raw payload
  media?: MediaItem[];
  metrics?: TweetMetrics;
}

export interface AssembledThread {
  rootId: string;
  tweets: SourceTweet[]; // chronological
}

export interface CollectedThread {
  rootId: string;
  tweets: SourceTweet[];
  status: CollectionStatus;
  firstSeenAt: string; // when we first stored it (ISO)
  deletedAt?: string; // set only when status === "deleted"
}
```

- [ ] **Step 4: Write `src/domain/threadAssembler.ts`**

```ts
import type { AssembledThread, SourceTweet } from "./models";

/**
 * Group tweets into threads by conversationId (root tweet id) and sort each
 * thread chronologically. Pure — no I/O. Dedups by tweet id (last wins).
 */
export function assembleThreads(tweets: SourceTweet[]): AssembledThread[] {
  const byId = new Map<string, SourceTweet>();
  for (const t of tweets) byId.set(t.id, t);

  const groups = new Map<string, SourceTweet[]>();
  for (const t of byId.values()) {
    const key = t.conversationId || t.id;
    const group = groups.get(key);
    if (group) group.push(t);
    else groups.set(key, [t]);
  }

  const threads: AssembledThread[] = [];
  for (const [rootId, group] of groups) {
    group.sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id));
    threads.push({ rootId, tweets: group });
  }

  threads.sort(
    (a, b) =>
      a.tweets[0].createdAt.localeCompare(b.tweets[0].createdAt) ||
      a.rootId.localeCompare(b.rootId),
  );
  return threads;
}
```

- [ ] **Step 5: Run test to verify it passes**

Run: `pnpm test tests/domain/threadAssembler.test.ts`
Expected: PASS (4 tests).

- [ ] **Step 6: Commit**

```bash
git add src/domain tests/domain
git commit -m "feat: domain models and pure thread assembler"
```

---

## Task 3: Port interfaces

**Files:**
- Create: `src/ports/SourceGateway.ts`, `src/ports/CollectionRepository.ts`, `src/ports/WatermarkStore.ts`, `src/ports/Clock.ts`

**Interfaces:**
- Consumes: `SourceTweet`, `CollectedThread` from Task 2
- Produces (relied on by Tasks 6, 8, 9, 10):
  - `SourceGateway.fetchAuthoredTweets(userName: string, sinceTime?: string): AsyncGenerator<SourceTweet>`
  - `SourceGateway.fetchThread(tweetId: string): Promise<SourceTweet[]>`
  - `SourceGateway.fetchByIds(ids: string[]): Promise<SourceTweet[]>`
  - `CollectionRepository.loadAll(): Promise<CollectedThread[]>`
  - `CollectionRepository.upsert(threads: CollectedThread[]): Promise<void>`
  - `CollectionRepository.listActiveTweetIds(): Promise<string[]>`
  - `CollectionRepository.markDeleted(tweetIds: string[], deletedAt: string): Promise<void>`
  - `WatermarkStore.get(): Promise<string | undefined>`
  - `WatermarkStore.set(time: string): Promise<void>`
  - `Clock = () => string`

- [ ] **Step 1: Write `src/ports/SourceGateway.ts`**

```ts
import type { SourceTweet } from "../domain/models";

export interface SourceGateway {
  /** Authored tweets newer than sinceTime (ISO), streamed via pagination. */
  fetchAuthoredTweets(userName: string, sinceTime?: string): AsyncGenerator<SourceTweet>;
  /** Full thread for a conversation/root tweet id. */
  fetchThread(tweetId: string): Promise<SourceTweet[]>;
  /** Existence check: returns only tweets still alive among the given ids. */
  fetchByIds(ids: string[]): Promise<SourceTweet[]>;
}
```

- [ ] **Step 2: Write `src/ports/CollectionRepository.ts`**

```ts
import type { CollectedThread } from "../domain/models";

export interface CollectionRepository {
  loadAll(): Promise<CollectedThread[]>;
  /** Merge by rootId; preserve existing firstSeenAt. */
  upsert(threads: CollectedThread[]): Promise<void>;
  /** All tweet ids belonging to active (non-deleted) threads. */
  listActiveTweetIds(): Promise<string[]>;
  /** Mark every active thread containing any of these ids as deleted. */
  markDeleted(tweetIds: string[], deletedAt: string): Promise<void>;
}
```

- [ ] **Step 3: Write `src/ports/WatermarkStore.ts`**

```ts
export interface WatermarkStore {
  /** Last collected point (ISO time), or undefined if never run. */
  get(): Promise<string | undefined>;
  set(time: string): Promise<void>;
}
```

- [ ] **Step 4: Write `src/ports/Clock.ts`**

```ts
/** Injectable current-time source (ISO 8601). Enables deterministic tests. */
export type Clock = () => string;

export const systemClock: Clock = () => new Date().toISOString();
```

- [ ] **Step 5: Verify typecheck**

Run: `pnpm typecheck`
Expected: no errors.

- [ ] **Step 6: Commit**

```bash
git add src/ports
git commit -m "feat: port interfaces (SourceGateway, CollectionRepository, WatermarkStore, Clock)"
```

---

## Task 4: HTTP client (ported from twitterapi-io)

**Files:**
- Create: `src/adapters/twitterapi/IHttpClient.ts`, `src/adapters/twitterapi/HttpClient.ts`, `src/adapters/twitterapi/TwitterClient.ts`
- Test: `tests/adapters/httpClient.test.ts`

**Interfaces:**
- Consumes: nothing
- Produces:
  - `IHttpClient.get<T>(path, params?): Promise<T>` / `post<T>(path, body?)` / `patch<T>` / `delete<T>`
  - `HttpClient(baseUrl: string, defaultHeaders?: Record<string,string>)`
  - `TwitterClient(apiKey: string)` implementing `IHttpClient` against `https://api.twitterapi.io`

- [ ] **Step 1: Write the failing test**

Create `tests/adapters/httpClient.test.ts`:

```ts
import { describe, it, expect, vi, afterEach } from "vitest";
import { HttpClient } from "../../src/adapters/twitterapi/HttpClient";

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

afterEach(() => vi.restoreAllMocks());

describe("HttpClient", () => {
  it("GET returns parsed JSON and sets query params + headers", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(jsonResponse(200, { ok: 1 }));
    const client = new HttpClient("https://api.example.com", { "x-api-key": "k" });

    const result = await client.get<{ ok: number }>("/path", { a: "1", empty: "" });

    expect(result).toEqual({ ok: 1 });
    const url = new URL(fetchMock.mock.calls[0][0] as string);
    expect(url.searchParams.get("a")).toBe("1");
    expect(url.searchParams.has("empty")).toBe(false); // empty params dropped
    const init = fetchMock.mock.calls[0][1] as RequestInit;
    expect((init.headers as Record<string, string>)["x-api-key"]).toBe("k");
  });

  it("retries on 429 then succeeds", async () => {
    const fetchMock = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(jsonResponse(429, { detail: "slow down" }))
      .mockResolvedValueOnce(jsonResponse(200, { ok: 2 }));
    vi.spyOn(globalThis, "setTimeout").mockImplementation(((fn: () => void) => {
      fn();
      return 0 as unknown as ReturnType<typeof setTimeout>;
    }) as typeof setTimeout);
    const client = new HttpClient("https://api.example.com");

    const result = await client.get<{ ok: number }>("/x");

    expect(result).toEqual({ ok: 2 });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("throws a clear error on 401", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(jsonResponse(401, { detail: "bad key" }));
    const client = new HttpClient("https://api.example.com");
    await expect(client.get("/x")).rejects.toThrow(/API key/i);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm test tests/adapters/httpClient.test.ts`
Expected: FAIL — cannot resolve `HttpClient`.

- [ ] **Step 3: Write `src/adapters/twitterapi/IHttpClient.ts`**

```ts
export interface IHttpClient {
  get<T>(path: string, params?: Record<string, string>): Promise<T>;
  post<T>(path: string, body?: unknown): Promise<T>;
  patch<T>(path: string, body?: unknown): Promise<T>;
  delete<T>(path: string, body?: unknown): Promise<T>;
}
```

- [ ] **Step 4: Write `src/adapters/twitterapi/HttpClient.ts`**

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
        if (res.status === 401) throw new Error("Invalid API key or expired login cookies");
        if (res.status === 402)
          throw new Error("Insufficient credits — top up at twitterapi.io/dashboard");
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

- [ ] **Step 5: Write `src/adapters/twitterapi/TwitterClient.ts`**

```ts
import { HttpClient } from "./HttpClient";
import type { IHttpClient } from "./IHttpClient";

const BASE_URL = "https://api.twitterapi.io";

export class TwitterClient implements IHttpClient {
  private readonly client: HttpClient;

  constructor(apiKey: string) {
    this.client = new HttpClient(BASE_URL, { "x-api-key": apiKey });
  }

  get<T>(path: string, params?: Record<string, string>): Promise<T> {
    return this.client.get<T>(path, params);
  }
  post<T>(path: string, body?: unknown): Promise<T> {
    return this.client.post<T>(path, body);
  }
  patch<T>(path: string, body?: unknown): Promise<T> {
    return this.client.patch<T>(path, body);
  }
  delete<T>(path: string, body?: unknown): Promise<T> {
    return this.client.delete<T>(path, body);
  }
}
```

- [ ] **Step 6: Run test to verify it passes**

Run: `pnpm test tests/adapters/httpClient.test.ts`
Expected: PASS (3 tests).

- [ ] **Step 7: Commit**

```bash
git add src/adapters/twitterapi/IHttpClient.ts src/adapters/twitterapi/HttpClient.ts src/adapters/twitterapi/TwitterClient.ts tests/adapters/httpClient.test.ts
git commit -m "feat: HTTP client with retry/backoff and error mapping (ported)"
```

---

## Task 5: Response schemas + tweet normalization (zod)

**Files:**
- Create: `src/adapters/twitterapi/schemas.ts`
- Test: `tests/adapters/schemas.test.ts`

**Interfaces:**
- Consumes: `SourceTweet`, `MediaItem`, `TweetMetrics` from Task 2
- Produces:
  - `TweetListResponse` zod schema for `{ tweets, has_next_page?, next_cursor? }`
  - `parseTweetList(data: unknown): { tweets: unknown[]; hasNextPage: boolean; nextCursor: string }`
  - `normalizeTweet(raw: unknown): SourceTweet`

- [ ] **Step 1: Write the failing test**

Create `tests/adapters/schemas.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { normalizeTweet, parseTweetList } from "../../src/adapters/twitterapi/schemas";

const rawTweet = {
  id: "2071473308198158423",
  url: "https://x.com/Mantle_Official/status/2071473308198158423",
  text: "Mantle update",
  createdAt: "Mon Jun 29 05:58:17 +0000 2026",
  conversationId: "2071473308198158423",
  isReply: false,
  author: { userName: "Mantle_Official", name: "Mantle" },
  quoted_tweet: { id: "999", url: "https://x.com/x/status/999" },
  likeCount: 2,
  viewCount: 156,
  extendedEntities: {
    media: [{ type: "photo", media_url_https: "https://pbs.twimg.com/media/x.jpg" }],
  },
};

describe("normalizeTweet", () => {
  it("maps a raw twitterapi.io tweet to SourceTweet with ISO createdAt", () => {
    const t = normalizeTweet(rawTweet);
    expect(t.id).toBe("2071473308198158423");
    expect(t.conversationId).toBe("2071473308198158423");
    expect(t.authorUserName).toBe("Mantle_Official");
    expect(t.createdAt).toBe("2026-06-29T05:58:17.000Z");
    expect(t.isQuote).toBe(true);
    expect(t.metrics?.likeCount).toBe(2);
    expect(t.media).toEqual([{ type: "photo", url: "https://pbs.twimg.com/media/x.jpg" }]);
  });

  it("defaults conversationId to id and isQuote to false when absent", () => {
    const t = normalizeTweet({
      id: "5",
      url: "u",
      text: "hi",
      createdAt: "Mon Jun 29 05:58:17 +0000 2026",
      author: { userName: "Mantle_Official" },
    });
    expect(t.conversationId).toBe("5");
    expect(t.isQuote).toBe(false);
    expect(t.isReply).toBe(false);
  });

  it("throws when a required field is missing", () => {
    expect(() => normalizeTweet({ url: "u", text: "t" })).toThrow();
  });
});

describe("parseTweetList", () => {
  it("extracts tweets, hasNextPage, nextCursor with defaults", () => {
    const parsed = parseTweetList({ tweets: [rawTweet], has_next_page: true, next_cursor: "c1" });
    expect(parsed.tweets).toHaveLength(1);
    expect(parsed.hasNextPage).toBe(true);
    expect(parsed.nextCursor).toBe("c1");
  });

  it("defaults missing pagination fields", () => {
    const parsed = parseTweetList({ tweets: [] });
    expect(parsed.hasNextPage).toBe(false);
    expect(parsed.nextCursor).toBe("");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm test tests/adapters/schemas.test.ts`
Expected: FAIL — cannot resolve `schemas`.

- [ ] **Step 3: Write `src/adapters/twitterapi/schemas.ts`**

```ts
import { z } from "zod";
import type { MediaItem, SourceTweet, TweetMetrics } from "../../domain/models";

const MediaRaw = z
  .object({ type: z.string(), media_url_https: z.string().optional() })
  .passthrough();

const TweetRaw = z
  .object({
    id: z.string(),
    url: z.string(),
    text: z.string(),
    createdAt: z.string(),
    conversationId: z.string().optional(),
    isReply: z.boolean().optional(),
    author: z.object({ userName: z.string() }).passthrough(),
    quoted_tweet: z.unknown().nullable().optional(),
    likeCount: z.number().optional(),
    retweetCount: z.number().optional(),
    replyCount: z.number().optional(),
    quoteCount: z.number().optional(),
    viewCount: z.number().optional(),
    bookmarkCount: z.number().optional(),
    extendedEntities: z.object({ media: z.array(MediaRaw).optional() }).passthrough().optional(),
  })
  .passthrough();

const TweetListResponse = z.object({
  tweets: z.array(z.unknown()).optional(),
  has_next_page: z.boolean().optional(),
  next_cursor: z.string().optional(),
});

function toMedia(raw: z.infer<typeof TweetRaw>): MediaItem[] | undefined {
  const media = raw.extendedEntities?.media;
  if (!media || media.length === 0) return undefined;
  const items: MediaItem[] = [];
  for (const m of media) {
    if (!m.media_url_https) continue;
    const type = m.type === "video" || m.type === "animated_gif" ? m.type : "photo";
    items.push({ type, url: m.media_url_https });
  }
  return items.length ? items : undefined;
}

function toMetrics(raw: z.infer<typeof TweetRaw>): TweetMetrics | undefined {
  const metrics: TweetMetrics = {
    likeCount: raw.likeCount,
    retweetCount: raw.retweetCount,
    replyCount: raw.replyCount,
    quoteCount: raw.quoteCount,
    viewCount: raw.viewCount,
    bookmarkCount: raw.bookmarkCount,
  };
  return Object.values(metrics).some((v) => v !== undefined) ? metrics : undefined;
}

/** Validate and convert a raw twitterapi.io tweet into a domain SourceTweet. */
export function normalizeTweet(raw: unknown): SourceTweet {
  const t = TweetRaw.parse(raw);
  return {
    id: t.id,
    conversationId: t.conversationId ?? t.id,
    text: t.text,
    createdAt: new Date(t.createdAt).toISOString(),
    url: t.url,
    authorUserName: t.author.userName,
    isReply: t.isReply ?? false,
    isQuote: t.quoted_tweet !== null && t.quoted_tweet !== undefined,
    media: toMedia(t),
    metrics: toMetrics(t),
  };
}

/** Validate a list-shaped response ({tweets, has_next_page, next_cursor}). */
export function parseTweetList(data: unknown): {
  tweets: unknown[];
  hasNextPage: boolean;
  nextCursor: string;
} {
  const parsed = TweetListResponse.parse(data);
  return {
    tweets: parsed.tweets ?? [],
    hasNextPage: parsed.has_next_page ?? false,
    nextCursor: parsed.next_cursor ?? "",
  };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm test tests/adapters/schemas.test.ts`
Expected: PASS (5 tests).

- [ ] **Step 5: Commit**

```bash
git add src/adapters/twitterapi/schemas.ts tests/adapters/schemas.test.ts
git commit -m "feat: zod schemas and tweet normalization"
```

---

## Task 6: TwitterApiSourceGateway

**Files:**
- Create: `src/adapters/twitterapi/TwitterApiSourceGateway.ts`
- Test: `tests/adapters/twitterApiSourceGateway.test.ts`

**Interfaces:**
- Consumes: `IHttpClient` (Task 4), `parseTweetList` + `normalizeTweet` (Task 5), `SourceGateway` + `SourceTweet` (Tasks 2–3)
- Produces: `TwitterApiSourceGateway implements SourceGateway`, constructed with `(client: IHttpClient)`

- [ ] **Step 1: Write the failing test**

Create `tests/adapters/twitterApiSourceGateway.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { TwitterApiSourceGateway } from "../../src/adapters/twitterapi/TwitterApiSourceGateway";
import type { IHttpClient } from "../../src/adapters/twitterapi/IHttpClient";

function raw(id: string, extra: Record<string, unknown> = {}) {
  return {
    id,
    url: `https://x.com/Mantle_Official/status/${id}`,
    text: `t${id}`,
    createdAt: "Mon Jun 29 05:58:17 +0000 2026",
    conversationId: id,
    author: { userName: "Mantle_Official" },
    ...extra,
  };
}

class FakeHttpClient implements IHttpClient {
  public calls: { path: string; params?: Record<string, string> }[] = [];
  constructor(private readonly responder: (path: string, params?: Record<string, string>) => unknown) {}
  async get<T>(path: string, params?: Record<string, string>): Promise<T> {
    this.calls.push({ path, params });
    return this.responder(path, params) as T;
  }
  async post<T>(): Promise<T> {
    throw new Error("not used");
  }
  async patch<T>(): Promise<T> {
    throw new Error("not used");
  }
  async delete<T>(): Promise<T> {
    throw new Error("not used");
  }
}

describe("TwitterApiSourceGateway", () => {
  it("fetchAuthoredTweets builds from: + since_time query and paginates via cursor", async () => {
    const http = new FakeHttpClient((_path, params) => {
      if (!params?.cursor) {
        return { tweets: [raw("1")], has_next_page: true, next_cursor: "c1" };
      }
      return { tweets: [raw("2")], has_next_page: false, next_cursor: "" };
    });
    const gw = new TwitterApiSourceGateway(http);

    const ids: string[] = [];
    for await (const t of gw.fetchAuthoredTweets("Mantle_Official", "2026-06-29T00:00:00.000Z")) {
      ids.push(t.id);
    }

    expect(ids).toEqual(["1", "2"]);
    expect(http.calls[0].path).toBe("/twitter/tweet/advanced_search");
    const query = http.calls[0].params?.query ?? "";
    expect(query).toContain("from:Mantle_Official");
    expect(query).toContain("since_time:"); // watermark converted to unix seconds
  });

  it("fetchAuthoredTweets omits since_time when no watermark", async () => {
    const http = new FakeHttpClient(() => ({ tweets: [raw("1")], has_next_page: false, next_cursor: "" }));
    const gw = new TwitterApiSourceGateway(http);
    for await (const _ of gw.fetchAuthoredTweets("Mantle_Official")) { /* drain */ }
    expect(http.calls[0].params?.query).toBe("from:Mantle_Official");
  });

  it("fetchThread paginates thread_context and returns normalized tweets", async () => {
    const http = new FakeHttpClient((_path, params) =>
      params?.cursor
        ? { tweets: [raw("b")], has_next_page: false, next_cursor: "" }
        : { tweets: [raw("a")], has_next_page: true, next_cursor: "c" },
    );
    const gw = new TwitterApiSourceGateway(http);
    const tweets = await gw.fetchThread("a");
    expect(tweets.map((t) => t.id)).toEqual(["a", "b"]);
    expect(http.calls[0].path).toBe("/twitter/tweet/thread_context");
    expect(http.calls[0].params?.tweetId).toBe("a");
  });

  it("fetchByIds sends comma-separated tweet_ids and returns alive tweets", async () => {
    const http = new FakeHttpClient(() => ({ tweets: [raw("1")], status: "success" }));
    const gw = new TwitterApiSourceGateway(http);
    const tweets = await gw.fetchByIds(["1", "2"]);
    expect(tweets.map((t) => t.id)).toEqual(["1"]);
    expect(http.calls[0].path).toBe("/twitter/tweets");
    expect(http.calls[0].params?.tweet_ids).toBe("1,2");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm test tests/adapters/twitterApiSourceGateway.test.ts`
Expected: FAIL — cannot resolve `TwitterApiSourceGateway`.

- [ ] **Step 3: Write `src/adapters/twitterapi/TwitterApiSourceGateway.ts`**

```ts
import type { SourceTweet } from "../../domain/models";
import type { SourceGateway } from "../../ports/SourceGateway";
import type { IHttpClient } from "./IHttpClient";
import { normalizeTweet, parseTweetList } from "./schemas";

export class TwitterApiSourceGateway implements SourceGateway {
  constructor(private readonly client: IHttpClient) {}

  async *fetchAuthoredTweets(
    userName: string,
    sinceTime?: string,
  ): AsyncGenerator<SourceTweet> {
    let query = `from:${userName}`;
    if (sinceTime) {
      const unixSeconds = Math.floor(new Date(sinceTime).getTime() / 1000);
      query += ` since_time:${unixSeconds}`;
    }
    let cursor = "";
    while (true) {
      const data = await this.client.get<unknown>("/twitter/tweet/advanced_search", {
        query,
        queryType: "Latest",
        cursor,
      });
      const { tweets, hasNextPage, nextCursor } = parseTweetList(data);
      for (const raw of tweets) yield normalizeTweet(raw);
      if (!hasNextPage || !nextCursor) break;
      cursor = nextCursor;
    }
  }

  async fetchThread(tweetId: string): Promise<SourceTweet[]> {
    const out: SourceTweet[] = [];
    let cursor = "";
    while (true) {
      const data = await this.client.get<unknown>("/twitter/tweet/thread_context", {
        tweetId,
        cursor,
      });
      const { tweets, hasNextPage, nextCursor } = parseTweetList(data);
      for (const raw of tweets) out.push(normalizeTweet(raw));
      if (!hasNextPage || !nextCursor) break;
      cursor = nextCursor;
    }
    return out;
  }

  async fetchByIds(ids: string[]): Promise<SourceTweet[]> {
    if (ids.length === 0) return [];
    const data = await this.client.get<unknown>("/twitter/tweets", {
      tweet_ids: ids.join(","),
    });
    const { tweets } = parseTweetList(data);
    return tweets.map((raw) => normalizeTweet(raw));
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm test tests/adapters/twitterApiSourceGateway.test.ts`
Expected: PASS (4 tests).

- [ ] **Step 5: Commit**

```bash
git add src/adapters/twitterapi/TwitterApiSourceGateway.ts tests/adapters/twitterApiSourceGateway.test.ts
git commit -m "feat: TwitterApiSourceGateway over twitterapi.io endpoints"
```

---

## Task 7: Quote-retweet probe test

**Files:**
- Create: `tests/adapters/quoteRetweet.probe.test.ts`

**Interfaces:**
- Consumes: `TwitterClient` (Task 4), `TwitterApiSourceGateway` (Task 6), `loadConfig` is NOT used (read env directly to keep the probe standalone)

**Purpose:** Answer the open question — do quote-retweets (and pure retweets) come through `from:Mantle_Official` advanced search? This hits the live API, so it runs only when `TWITTERAPI_IO_KEY` is set and is skipped otherwise (safe in CI). It documents findings via console output; assertions only check the call succeeds.

- [ ] **Step 1: Write the probe test**

Create `tests/adapters/quoteRetweet.probe.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { TwitterClient } from "../../src/adapters/twitterapi/TwitterClient";
import { TwitterApiSourceGateway } from "../../src/adapters/twitterapi/TwitterApiSourceGateway";

const apiKey = process.env.TWITTERAPI_IO_KEY;

// Skipped unless a real API key is present (network + credits required).
describe.skipIf(!apiKey)("PROBE: quote-retweet inclusion in authored search", () => {
  it("reports whether quote tweets appear in from:Mantle_Official", async () => {
    const gw = new TwitterApiSourceGateway(new TwitterClient(apiKey!));

    let total = 0;
    let quotes = 0;
    for await (const t of gw.fetchAuthoredTweets("Mantle_Official")) {
      total += 1;
      if (t.isQuote) quotes += 1;
      if (total >= 50) break; // cap cost
    }

    // eslint-disable-next-line no-console
    console.log(`[probe] scanned ${total} authored tweets; ${quotes} are quote-tweets (isQuote=true)`);
    expect(total).toBeGreaterThan(0);
  });
});
```

- [ ] **Step 2: Run without key (verify skip)**

Run: `pnpm test tests/adapters/quoteRetweet.probe.test.ts`
Expected: test suite reports the probe as **skipped** (no `TWITTERAPI_IO_KEY`), exit 0.

- [ ] **Step 3: (Manual, optional) Run with key and record the finding**

Run: `TWITTERAPI_IO_KEY=... pnpm test tests/adapters/quoteRetweet.probe.test.ts`
Expected: PASS with a `[probe] scanned N ... quote-tweets` line. Record the observed answer (do quote-tweets/pure-retweets appear?) in the spec's "미확정 → probe" section.

- [ ] **Step 4: Commit**

```bash
git add tests/adapters/quoteRetweet.probe.test.ts
git commit -m "test: quote-retweet inclusion probe (skipped without API key)"
```

---

## Task 8: LocalJsonStore (repository + watermark)

**Files:**
- Create: `src/adapters/store/LocalJsonStore.ts`
- Test: `tests/adapters/localJsonStore.test.ts`

**Interfaces:**
- Consumes: `CollectionRepository`, `WatermarkStore` (Task 3), `CollectedThread` (Task 2)
- Produces: `LocalJsonStore implements CollectionRepository, WatermarkStore`, constructed with `(dir: string)`. Persists `<dir>/items.json` (CollectedThread[]) and `<dir>/state.json` (`{ watermark?: string }`).

- [ ] **Step 1: Write the failing test**

Create `tests/adapters/localJsonStore.test.ts`:

```ts
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LocalJsonStore } from "../../src/adapters/store/LocalJsonStore";
import type { CollectedThread } from "../../src/domain/models";

function thread(rootId: string, ids: string[], overrides: Partial<CollectedThread> = {}): CollectedThread {
  return {
    rootId,
    tweets: ids.map((id) => ({
      id,
      conversationId: rootId,
      text: `t${id}`,
      createdAt: "2026-01-01T00:00:00.000Z",
      url: `u/${id}`,
      authorUserName: "Mantle_Official",
      isReply: false,
      isQuote: false,
    })),
    status: "active",
    firstSeenAt: "2026-01-01T00:00:00.000Z",
    ...overrides,
  };
}

let dir: string;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "herald-store-"));
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe("LocalJsonStore", () => {
  it("upsert then loadAll round-trips", async () => {
    const store = new LocalJsonStore(dir);
    await store.upsert([thread("1", ["1"])]);
    expect(await store.loadAll()).toHaveLength(1);
  });

  it("upsert merges by rootId and preserves original firstSeenAt", async () => {
    const store = new LocalJsonStore(dir);
    await store.upsert([thread("1", ["1"], { firstSeenAt: "2026-01-01T00:00:00.000Z" })]);
    await store.upsert([thread("1", ["1", "2"], { firstSeenAt: "2026-02-02T00:00:00.000Z" })]);
    const all = await store.loadAll();
    expect(all).toHaveLength(1);
    expect(all[0].tweets).toHaveLength(2);
    expect(all[0].firstSeenAt).toBe("2026-01-01T00:00:00.000Z"); // preserved
  });

  it("listActiveTweetIds returns ids of active threads only", async () => {
    const store = new LocalJsonStore(dir);
    await store.upsert([thread("1", ["1", "2"]), thread("9", ["9"], { status: "deleted" })]);
    expect((await store.listActiveTweetIds()).sort()).toEqual(["1", "2"]);
  });

  it("markDeleted flags the containing thread with deletedAt", async () => {
    const store = new LocalJsonStore(dir);
    await store.upsert([thread("1", ["1", "2"])]);
    await store.markDeleted(["2"], "2026-03-03T00:00:00.000Z");
    const all = await store.loadAll();
    expect(all[0].status).toBe("deleted");
    expect(all[0].deletedAt).toBe("2026-03-03T00:00:00.000Z");
  });

  it("watermark get returns undefined initially, then the set value", async () => {
    const store = new LocalJsonStore(dir);
    expect(await store.get()).toBeUndefined();
    await store.set("2026-04-04T00:00:00.000Z");
    expect(await store.get()).toBe("2026-04-04T00:00:00.000Z");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm test tests/adapters/localJsonStore.test.ts`
Expected: FAIL — cannot resolve `LocalJsonStore`.

- [ ] **Step 3: Write `src/adapters/store/LocalJsonStore.ts`**

```ts
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { CollectedThread } from "../../domain/models";
import type { CollectionRepository } from "../../ports/CollectionRepository";
import type { WatermarkStore } from "../../ports/WatermarkStore";

interface StateFile {
  watermark?: string;
}

export class LocalJsonStore implements CollectionRepository, WatermarkStore {
  private readonly itemsPath: string;
  private readonly statePath: string;

  constructor(private readonly dir: string) {
    this.itemsPath = join(dir, "items.json");
    this.statePath = join(dir, "state.json");
  }

  private async readJson<T>(path: string, fallback: T): Promise<T> {
    try {
      return JSON.parse(await readFile(path, "utf8")) as T;
    } catch {
      return fallback;
    }
  }

  private async writeJson(path: string, data: unknown): Promise<void> {
    await mkdir(this.dir, { recursive: true });
    await writeFile(path, `${JSON.stringify(data, null, 2)}\n`, "utf8");
  }

  async loadAll(): Promise<CollectedThread[]> {
    return this.readJson<CollectedThread[]>(this.itemsPath, []);
  }

  async upsert(threads: CollectedThread[]): Promise<void> {
    const existing = await this.loadAll();
    const byRoot = new Map(existing.map((t) => [t.rootId, t]));
    for (const incoming of threads) {
      const prev = byRoot.get(incoming.rootId);
      byRoot.set(incoming.rootId, {
        ...incoming,
        firstSeenAt: prev?.firstSeenAt ?? incoming.firstSeenAt,
      });
    }
    await this.writeJson(this.itemsPath, [...byRoot.values()]);
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
    if (changed) await this.writeJson(this.itemsPath, all);
  }

  async get(): Promise<string | undefined> {
    const state = await this.readJson<StateFile>(this.statePath, {});
    return state.watermark;
  }

  async set(time: string): Promise<void> {
    await this.writeJson(this.statePath, { watermark: time } satisfies StateFile);
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm test tests/adapters/localJsonStore.test.ts`
Expected: PASS (5 tests).

- [ ] **Step 5: Commit**

```bash
git add src/adapters/store/LocalJsonStore.ts tests/adapters/localJsonStore.test.ts
git commit -m "feat: LocalJsonStore (repository + watermark) over output/"
```

---

## Task 9: CollectAuthoredContent use-case

**Files:**
- Create: `src/app/CollectAuthoredContent.ts`
- Test: `tests/app/collectAuthoredContent.test.ts`

**Interfaces:**
- Consumes: `SourceGateway`, `CollectionRepository`, `WatermarkStore`, `Clock` (Task 3); `assembleThreads` (Task 2)
- Produces: `CollectAuthoredContent`, constructed with `(source, repo, watermark, now: Clock = systemClock)`; `run(userName: string): Promise<{ fetchedCount: number; threadCount: number }>`

- [ ] **Step 1: Write the failing test**

Create `tests/app/collectAuthoredContent.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { CollectAuthoredContent } from "../../src/app/CollectAuthoredContent";
import type { SourceGateway } from "../../src/ports/SourceGateway";
import type { CollectionRepository } from "../../src/ports/CollectionRepository";
import type { WatermarkStore } from "../../src/ports/WatermarkStore";
import type { CollectedThread, SourceTweet } from "../../src/domain/models";

function tw(id: string, over: Partial<SourceTweet> = {}): SourceTweet {
  return {
    id,
    conversationId: over.conversationId ?? id,
    text: `t${id}`,
    createdAt: over.createdAt ?? "2026-01-01T00:00:00.000Z",
    url: `u/${id}`,
    authorUserName: over.authorUserName ?? "Mantle_Official",
    isReply: over.isReply ?? false,
    isQuote: false,
  };
}

class FakeGateway implements SourceGateway {
  public threadCalls: string[] = [];
  constructor(
    private readonly authored: SourceTweet[],
    private readonly threads: Record<string, SourceTweet[]> = {},
  ) {}
  async *fetchAuthoredTweets(): AsyncGenerator<SourceTweet> {
    for (const t of this.authored) yield t;
  }
  async fetchThread(id: string): Promise<SourceTweet[]> {
    this.threadCalls.push(id);
    return this.threads[id] ?? [];
  }
  async fetchByIds(): Promise<SourceTweet[]> {
    return [];
  }
}

class InMemoryRepo implements CollectionRepository {
  public saved: CollectedThread[] = [];
  async loadAll() {
    return this.saved;
  }
  async upsert(threads: CollectedThread[]) {
    this.saved = threads;
  }
  async listActiveTweetIds() {
    return [];
  }
  async markDeleted() {}
}

class InMemoryWatermark implements WatermarkStore {
  constructor(public value?: string) {}
  async get() {
    return this.value;
  }
  async set(time: string) {
    this.value = time;
  }
}

describe("CollectAuthoredContent", () => {
  it("collects, assembles, saves, and advances the watermark to max createdAt", async () => {
    const gw = new FakeGateway([
      tw("1", { createdAt: "2026-01-01T00:01:00.000Z" }),
      tw("2", { conversationId: "1", createdAt: "2026-01-01T00:02:00.000Z" }),
    ]);
    const repo = new InMemoryRepo();
    const wm = new InMemoryWatermark();
    const usecase = new CollectAuthoredContent(gw, repo, wm, () => "2026-05-05T00:00:00.000Z");

    const result = await usecase.run("Mantle_Official");

    expect(result.threadCount).toBe(1);
    expect(repo.saved[0].tweets.map((t) => t.id)).toEqual(["1", "2"]);
    expect(repo.saved[0].status).toBe("active");
    expect(repo.saved[0].firstSeenAt).toBe("2026-05-05T00:00:00.000Z");
    expect(wm.value).toBe("2026-01-01T00:02:00.000Z");
  });

  it("gap-fills via fetchThread when a thread root is missing from the batch", async () => {
    // Only a later reply (conversationId=100) is in the batch; root 100 is absent.
    const reply = tw("101", { conversationId: "100", isReply: true, createdAt: "2026-01-01T00:03:00.000Z" });
    const root = tw("100", { conversationId: "100", createdAt: "2026-01-01T00:00:30.000Z" });
    const gw = new FakeGateway([reply], { "100": [root, reply] });
    const usecase = new CollectAuthoredContent(gw, new InMemoryRepo(), new InMemoryWatermark(), () => "now");

    await usecase.run("Mantle_Official");

    expect(gw.threadCalls).toContain("100");
  });

  it("does not advance the watermark when nothing is fetched", async () => {
    const wm = new InMemoryWatermark("2026-01-01T00:00:00.000Z");
    const usecase = new CollectAuthoredContent(new FakeGateway([]), new InMemoryRepo(), wm, () => "now");
    await usecase.run("Mantle_Official");
    expect(wm.value).toBe("2026-01-01T00:00:00.000Z");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm test tests/app/collectAuthoredContent.test.ts`
Expected: FAIL — cannot resolve `CollectAuthoredContent`.

- [ ] **Step 3: Write `src/app/CollectAuthoredContent.ts`**

```ts
import { assembleThreads } from "../domain/threadAssembler";
import type { CollectedThread, SourceTweet } from "../domain/models";
import type { SourceGateway } from "../ports/SourceGateway";
import type { CollectionRepository } from "../ports/CollectionRepository";
import type { WatermarkStore } from "../ports/WatermarkStore";
import { systemClock, type Clock } from "../ports/Clock";

export interface CollectResult {
  fetchedCount: number;
  threadCount: number;
}

export class CollectAuthoredContent {
  constructor(
    private readonly source: SourceGateway,
    private readonly repo: CollectionRepository,
    private readonly watermark: WatermarkStore,
    private readonly now: Clock = systemClock,
  ) {}

  async run(userName: string): Promise<CollectResult> {
    const since = await this.watermark.get();

    const fetched: SourceTweet[] = [];
    for await (const t of this.source.fetchAuthoredTweets(userName, since)) fetched.push(t);

    await this.gapFillMissingRoots(fetched, userName);

    const assembled = assembleThreads(fetched);
    const timestamp = this.now();
    const collected: CollectedThread[] = assembled.map((thread) => ({
      rootId: thread.rootId,
      tweets: thread.tweets,
      status: "active",
      firstSeenAt: timestamp,
    }));

    await this.repo.upsert(collected);

    const maxCreatedAt = this.maxCreatedAt(fetched);
    if (maxCreatedAt && (!since || maxCreatedAt > since)) {
      await this.watermark.set(maxCreatedAt);
    }

    return { fetchedCount: fetched.length, threadCount: collected.length };
  }

  /** Pull earlier thread parts (via thread_context) for threads whose root is absent. */
  private async gapFillMissingRoots(fetched: SourceTweet[], userName: string): Promise<void> {
    const presentIds = new Set(fetched.map((t) => t.id));
    const missingRoots = new Set<string>();
    for (const t of fetched) {
      if (t.conversationId !== t.id && !presentIds.has(t.conversationId)) {
        missingRoots.add(t.conversationId);
      }
    }
    for (const rootId of missingRoots) {
      const threadTweets = await this.source.fetchThread(rootId);
      for (const t of threadTweets) {
        if (t.authorUserName === userName && !presentIds.has(t.id)) {
          fetched.push(t);
          presentIds.add(t.id);
        }
      }
    }
  }

  private maxCreatedAt(tweets: SourceTweet[]): string | undefined {
    let max: string | undefined;
    for (const t of tweets) {
      if (!max || t.createdAt > max) max = t.createdAt;
    }
    return max;
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm test tests/app/collectAuthoredContent.test.ts`
Expected: PASS (3 tests).

- [ ] **Step 5: Commit**

```bash
git add src/app/CollectAuthoredContent.ts tests/app/collectAuthoredContent.test.ts
git commit -m "feat: CollectAuthoredContent use-case with gap-fill and watermark"
```

---

## Task 10: ReconcileDeletions use-case

**Files:**
- Create: `src/app/ReconcileDeletions.ts`
- Test: `tests/app/reconcileDeletions.test.ts`

**Interfaces:**
- Consumes: `SourceGateway`, `CollectionRepository`, `Clock` (Task 3)
- Produces: `ReconcileDeletions`, constructed with `(source, repo, now: Clock = systemClock, batchSize = 100)`; `run(): Promise<{ checked: number; deleted: number }>`

- [ ] **Step 1: Write the failing test**

Create `tests/app/reconcileDeletions.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { ReconcileDeletions } from "../../src/app/ReconcileDeletions";
import type { SourceGateway } from "../../src/ports/SourceGateway";
import type { CollectionRepository } from "../../src/ports/CollectionRepository";
import type { SourceTweet } from "../../src/domain/models";

function tw(id: string): SourceTweet {
  return {
    id,
    conversationId: id,
    text: `t${id}`,
    createdAt: "2026-01-01T00:00:00.000Z",
    url: `u/${id}`,
    authorUserName: "Mantle_Official",
    isReply: false,
    isQuote: false,
  };
}

class FakeGateway implements SourceGateway {
  public batches: string[][] = [];
  constructor(private readonly alive: Set<string>) {}
  async *fetchAuthoredTweets(): AsyncGenerator<SourceTweet> {}
  async fetchThread(): Promise<SourceTweet[]> {
    return [];
  }
  async fetchByIds(ids: string[]): Promise<SourceTweet[]> {
    this.batches.push(ids);
    return ids.filter((id) => this.alive.has(id)).map(tw);
  }
}

class RecordingRepo implements CollectionRepository {
  public deleted: { ids: string[]; at: string } | undefined;
  constructor(private readonly activeIds: string[]) {}
  async loadAll() {
    return [];
  }
  async upsert() {}
  async listActiveTweetIds() {
    return this.activeIds;
  }
  async markDeleted(tweetIds: string[], deletedAt: string) {
    this.deleted = { ids: tweetIds, at: deletedAt };
  }
}

describe("ReconcileDeletions", () => {
  it("marks ids that are no longer alive as deleted", async () => {
    const gw = new FakeGateway(new Set(["1", "3"])); // "2" was deleted upstream
    const repo = new RecordingRepo(["1", "2", "3"]);
    const usecase = new ReconcileDeletions(gw, repo, () => "2026-06-06T00:00:00.000Z");

    const result = await usecase.run();

    expect(result).toEqual({ checked: 3, deleted: 1 });
    expect(repo.deleted).toEqual({ ids: ["2"], at: "2026-06-06T00:00:00.000Z" });
  });

  it("does not call markDeleted when nothing is missing (idempotent)", async () => {
    const gw = new FakeGateway(new Set(["1", "2"]));
    const repo = new RecordingRepo(["1", "2"]);
    const usecase = new ReconcileDeletions(gw, repo, () => "now");
    const result = await usecase.run();
    expect(result.deleted).toBe(0);
    expect(repo.deleted).toBeUndefined();
  });

  it("checks ids in batches of batchSize", async () => {
    const gw = new FakeGateway(new Set(["1", "2", "3"]));
    const repo = new RecordingRepo(["1", "2", "3"]);
    const usecase = new ReconcileDeletions(gw, repo, () => "now", 2);
    await usecase.run();
    expect(gw.batches).toEqual([["1", "2"], ["3"]]);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm test tests/app/reconcileDeletions.test.ts`
Expected: FAIL — cannot resolve `ReconcileDeletions`.

- [ ] **Step 3: Write `src/app/ReconcileDeletions.ts`**

```ts
import type { SourceGateway } from "../ports/SourceGateway";
import type { CollectionRepository } from "../ports/CollectionRepository";
import { systemClock, type Clock } from "../ports/Clock";

export interface ReconcileResult {
  checked: number;
  deleted: number;
}

export class ReconcileDeletions {
  constructor(
    private readonly source: SourceGateway,
    private readonly repo: CollectionRepository,
    private readonly now: Clock = systemClock,
    private readonly batchSize = 100,
  ) {}

  async run(): Promise<ReconcileResult> {
    const activeIds = await this.repo.listActiveTweetIds();

    const alive = new Set<string>();
    for (let i = 0; i < activeIds.length; i += this.batchSize) {
      const batch = activeIds.slice(i, i + this.batchSize);
      const tweets = await this.source.fetchByIds(batch);
      for (const t of tweets) alive.add(t.id);
    }

    const missing = activeIds.filter((id) => !alive.has(id));
    if (missing.length > 0) {
      await this.repo.markDeleted(missing, this.now());
    }

    return { checked: activeIds.length, deleted: missing.length };
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm test tests/app/reconcileDeletions.test.ts`
Expected: PASS (3 tests).

- [ ] **Step 5: Commit**

```bash
git add src/app/ReconcileDeletions.ts tests/app/reconcileDeletions.test.ts
git commit -m "feat: ReconcileDeletions use-case (soft-mark, idempotent, batched)"
```

---

## Task 11: Config + CLI composition roots

**Files:**
- Create: `src/config.ts`, `src/cli/collect.ts`, `src/cli/reconcile.ts`
- Test: `tests/config.test.ts`

**Interfaces:**
- Consumes: `TwitterClient` (Task 4), `TwitterApiSourceGateway` (Task 6), `LocalJsonStore` (Task 8), `CollectAuthoredContent` (Task 9), `ReconcileDeletions` (Task 10)
- Produces: `loadConfig(): { apiKey: string }`; runnable `pnpm collect` / `pnpm reconcile`

- [ ] **Step 1: Write the failing test**

Create `tests/config.test.ts`:

```ts
import { describe, it, expect, afterEach } from "vitest";
import { loadConfig } from "../src/config";

const original = process.env.TWITTERAPI_IO_KEY;
afterEach(() => {
  if (original === undefined) delete process.env.TWITTERAPI_IO_KEY;
  else process.env.TWITTERAPI_IO_KEY = original;
});

describe("loadConfig", () => {
  it("returns the apiKey from env", () => {
    process.env.TWITTERAPI_IO_KEY = "abc";
    expect(loadConfig()).toEqual({ apiKey: "abc" });
  });

  it("throws a clear error when the key is missing", () => {
    delete process.env.TWITTERAPI_IO_KEY;
    expect(() => loadConfig()).toThrow(/TWITTERAPI_IO_KEY/);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm test tests/config.test.ts`
Expected: FAIL — cannot resolve `config`.

- [ ] **Step 3: Write `src/config.ts`**

```ts
export interface Config {
  apiKey: string;
}

export function loadConfig(): Config {
  const apiKey = process.env.TWITTERAPI_IO_KEY;
  if (!apiKey) {
    throw new Error("Missing required environment variable: TWITTERAPI_IO_KEY");
  }
  return { apiKey };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm test tests/config.test.ts`
Expected: PASS (2 tests).

- [ ] **Step 5: Write `src/cli/collect.ts`**

```ts
import { loadConfig } from "../config";
import { TwitterClient } from "../adapters/twitterapi/TwitterClient";
import { TwitterApiSourceGateway } from "../adapters/twitterapi/TwitterApiSourceGateway";
import { LocalJsonStore } from "../adapters/store/LocalJsonStore";
import { CollectAuthoredContent } from "../app/CollectAuthoredContent";

const target = process.argv[2] ?? "Mantle_Official";

const client = new TwitterClient(loadConfig().apiKey);
const source = new TwitterApiSourceGateway(client);
const store = new LocalJsonStore("output");
const usecase = new CollectAuthoredContent(source, store, store);

const result = await usecase.run(target);
console.log(
  `collected ${result.threadCount} threads (${result.fetchedCount} tweets) for @${target}`,
);
```

- [ ] **Step 6: Write `src/cli/reconcile.ts`**

```ts
import { loadConfig } from "../config";
import { TwitterClient } from "../adapters/twitterapi/TwitterClient";
import { TwitterApiSourceGateway } from "../adapters/twitterapi/TwitterApiSourceGateway";
import { LocalJsonStore } from "../adapters/store/LocalJsonStore";
import { ReconcileDeletions } from "../app/ReconcileDeletions";

const client = new TwitterClient(loadConfig().apiKey);
const source = new TwitterApiSourceGateway(client);
const store = new LocalJsonStore("output");
const usecase = new ReconcileDeletions(source, store);

const result = await usecase.run();
console.log(`reconciled ${result.checked} tweets; marked ${result.deleted} thread(s) deleted`);
```

- [ ] **Step 7: Verify full test suite + typecheck**

Run: `pnpm test && pnpm typecheck`
Expected: all suites PASS; typecheck exits 0.

- [ ] **Step 8: (Manual) End-to-end smoke with a real key**

Run: `cp .env.example .env` then fill `TWITTERAPI_IO_KEY`, then `pnpm collect`
Expected: `output/items.json` + `output/state.json` created; console prints the collected count. Re-running `pnpm collect` fetches only newer tweets (watermark honored). `pnpm reconcile` prints a reconcile summary.

- [ ] **Step 9: Commit**

```bash
git add src/config.ts src/cli tests/config.test.ts
git commit -m "feat: config loader and collect/reconcile CLI composition roots"
```

---

## Task 12: README usage docs

**Files:**
- Modify: `README.md`

**Interfaces:**
- Consumes: everything above
- Produces: developer-facing run instructions

- [ ] **Step 1: Update `README.md`**

```markdown
# mantle-kr-herald

Social media automation pipeline for the Mantle KR team. See `docs/superpowers/specs/` for designs and `docs/architecture/hexagonal-architecture.md` for the architecture.

## Module A — X data collection (twitterapi.io)

Collects `Mantle_Official`'s authored tweets (threads reconstructed) into local JSON, incrementally, with soft-mark deletion handling.

### Setup

```bash
pnpm install
cp .env.example .env   # then fill TWITTERAPI_IO_KEY
```

### Commands

```bash
pnpm collect            # collect new authored tweets (default @Mantle_Official)
pnpm collect <handle>   # collect a different account
pnpm reconcile          # re-check stored tweets; soft-mark deletions
pnpm test               # run unit tests
pnpm typecheck          # type-check
```

Output is written to `output/` (git-ignored): `items.json` (collected threads) and `state.json` (watermark).
```

- [ ] **Step 2: Verify tests still green**

Run: `pnpm test`
Expected: all PASS.

- [ ] **Step 3: Commit**

```bash
git add README.md
git commit -m "docs: README usage for module A collection"
```

---

## Self-Review (completed during authoring)

- **Spec coverage:** §2 scope → Tasks 6/9 (authored + threads, exclude others via `from:` query); incremental watermark → Tasks 8/9; soft-mark deletion → Tasks 8/10; probe → Task 7; hexagonal layout → Tasks 2–11; zod validation → Task 5; local JSON output → Task 8; CLI → Task 11; libraries (`zod`/`vitest`/`tsx`, native fetch, native env) → Task 1. No spec section left without a task.
- **Placeholder scan:** every code/test step contains complete code and exact commands. No TBD/TODO.
- **Type consistency:** `SourceTweet`, `AssembledThread`, `CollectedThread`, `CollectResult`, `ReconcileResult`, and port signatures are defined once (Tasks 2–3) and consumed verbatim in Tasks 5–11. `fetchAuthoredTweets/fetchThread/fetchByIds`, `upsert/loadAll/listActiveTweetIds/markDeleted`, `get/set` names match across producer and consumer tasks.

## Notes / Deferred (out of scope for module A)

- **twitterapi.io access:** module A calls the REST API directly (typed client). twitterapi.io also ships a **skill** (`kaitoInfra/twitterapi-io`, a markdown knowledge doc — use it to confirm exact endpoint params/response shapes) and a read-only **MCP server** (`@twitterapi_io/mcp-server`), but the MCP is unsuitable here (no `thread_context`, strips `extendedEntities`/media) and is meant for chat clients that can't run code. See spec §10-1.
- Drive/Sheet output → new `CollectionRepository` adapter (subsystem D/G).
- Lark source → new `SourceGateway` adapter (subsystem B).
- Scheduling/automation of `collect`/`reconcile`.
- Per-tweet (vs per-thread) deletion granularity, if the pipeline later needs it.
