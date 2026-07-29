# Typefully quota, retries and automatic reconcile — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Stop the Typefully integration from silently over-publishing or silently under-reporting — enforce the monthly publishing quota before a send, retry transient failures without ever duplicating a draft, fix the article-id parse, and reconcile scheduled posts without a human clicking.

**Architecture:** Two new adapters (`typefullyFetch`, `TypefullyQuota`) sit under the existing Typefully senders, which keep their constructor shapes so no call site changes. `SendChannels` gains one optional dependency — a quota reader — and one new result field. `serve` gains a testable interval scheduler extracted to its own module, plus a cached quota endpoint the board renders as a banner.

**Tech Stack:** TypeScript (ESM, `tsx`), vitest, React 18 for `web/`.

## Global Constraints

- Spec: `docs/superpowers/specs/2026-07-29-typefully-quota-and-resilience-design.md`.
- Code, comments, commit messages and PR titles in **English**. User-facing dashboard copy in **Korean** (existing board convention).
- Retry budget: **3 attempts**, backoff **1000ms · 2000ms** — same as `src/shared/http/HttpClient.ts:29-30`, so the two read alike.
- Low-quota threshold: **`remaining <= 3`**, one exported constant shared by doctor and the board.
- Quota endpoint cache TTL: **60 seconds**.
- Reconcile interval: **2 minutes** — matches `PUBLISH_DELAY_MS` in `src/adapters/send/typefullyPublish.ts:7`.
- Typefully API base: `https://api.typefully.com/v2`. `GET /v2/social-sets/{id}` **requires a trailing slash** — without it the API answers `301` with an empty body.
- Draft creation (`POST /v2/social-sets/{id}/drafts`) is the **only** Typefully call marked non-idempotent.
- Run `pnpm test` and `pnpm typecheck` before every commit.

---

### Task 1: `parseArticleId` accepts the URL Typefully actually returns

**Files:**
- Modify: `src/adapters/send/typefullyPublish.ts:19-23`
- Test: `tests/adapters/send/typefullyPublish.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces: `parseArticleId(url: string | undefined): string | undefined` — unchanged signature, wider match.

Live evidence: draft `10097410` on social set `283589` returned
`x_article_published_url: "https://x.com/bcd_kyle/status/2082141042959401225"`. The current regex
wants `/article/(\d+)`, misses, and `ReconcilePublished.ts:77` then leaves a Typefully draft id in
the article ledger's `postId`.

- [ ] **Step 1: Write the failing test**

Append to `tests/adapters/send/typefullyPublish.test.ts`:

```ts
describe("parseArticleId — the shape Typefully actually returns", () => {
  /** Live value from draft 10097410 (social set 283589, 2026-07-29). */
  it("parses a /status/ article url", () => {
    expect(parseArticleId("https://x.com/bcd_kyle/status/2082141042959401225")).toBe("2082141042959401225");
  });

  it("still parses the /i/article/ form", () => {
    expect(parseArticleId("https://x.com/i/article/2082141")).toBe("2082141");
  });

  it("is undefined for a url with no id and for no url at all", () => {
    expect(parseArticleId("https://x.com/bcd_kyle")).toBeUndefined();
    expect(parseArticleId(undefined)).toBeUndefined();
  });
});
```

Make sure `parseArticleId` is in the file's import list.

- [ ] **Step 2: Run the test and confirm it fails**

Run: `pnpm vitest run tests/adapters/send/typefullyPublish.test.ts`
Expected: FAIL — `parses a /status/ article url` gets `undefined`, expected `"2082141601427456241"`-shaped id.

- [ ] **Step 3: Widen the regex**

Replace `src/adapters/send/typefullyPublish.ts:19-23` with:

```ts
/**
 * The X article id in a published article url.
 *
 * Typefully returns `https://x.com/<handle>/status/<id>` for `x_article_published_url` — the same
 * shape as a tweet url, not the `https://x.com/i/article/<id>` this used to assume. Both are
 * accepted: the `/i/article/` form is what X shows in a browser, and a draft reconciled before this
 * fix may still carry one. `parseTweetId` matches the same `/status/` pattern, but the two read
 * different fields (`x_published_url` vs `x_article_published_url`), so there is nothing to confuse.
 */
export function parseArticleId(url: string | undefined): string | undefined {
  const m = url ? /\/(?:i\/article|status)\/(\d+)/.exec(url) : null;
  return m ? m[1] : undefined;
}
```

- [ ] **Step 4: Run the tests and confirm they pass**

Run: `pnpm vitest run tests/adapters/send/typefullyPublish.test.ts tests/adapters/send/typefullyDraftLookup.test.ts tests/app/reconcilePublished.test.ts`
Expected: PASS — including the existing `typefullyDraftLookup` case that feeds an `/i/article/` url.

- [ ] **Step 5: Commit**

```bash
git add src/adapters/send/typefullyPublish.ts tests/adapters/send/typefullyPublish.test.ts
git commit -m "fix(send): parse the /status/ article url Typefully actually returns"
```

---

### Task 2: `typefullyFetch` — the retry wrapper

**Files:**
- Create: `src/adapters/send/typefullyFetch.ts`
- Test: `tests/adapters/send/typefullyFetch.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces:
  - `type TypefullyFetch = (url: string, init?: RequestInit, opts?: { idempotent?: boolean }) => Promise<Response>`
  - `createTypefullyFetch(fetchFn?: typeof fetch, sleep?: (ms: number) => Promise<void>, log?: (msg: string) => void): TypefullyFetch`
  - `RETRY_ATTEMPTS: 3`, `RETRY_BASE_MS: 1000`

`opts.idempotent` defaults to `true`. Only draft creation passes `false`.

- [ ] **Step 1: Write the failing tests**

Create `tests/adapters/send/typefullyFetch.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { createTypefullyFetch } from "../../../src/adapters/send/typefullyFetch";

/** Returns the queued responses in order; a queued Error is thrown instead (network failure). */
function fakeFetch(queue: (Partial<Response> | Error)[]) {
  const calls: string[] = [];
  const fn = (async (url: string) => {
    calls.push(String(url));
    const next = queue.shift();
    if (next instanceof Error) throw next;
    return { ok: (next?.status ?? 200) < 400, status: 200, ...next } as Response;
  }) as unknown as typeof fetch;
  return { fn, calls };
}

function fakeSleep() {
  const slept: number[] = [];
  return { slept, sleep: async (ms: number) => void slept.push(ms) };
}

describe("createTypefullyFetch", () => {
  it("retries a 429 and returns the eventual success", async () => {
    const { fn, calls } = fakeFetch([{ status: 429 }, { status: 200 }]);
    const { slept, sleep } = fakeSleep();
    const res = await createTypefullyFetch(fn, sleep, () => {})("https://api.typefully.com/v2/me");
    expect(res.status).toBe(200);
    expect(calls).toHaveLength(2);
    expect(slept).toEqual([1000]);
  });

  it("retries an idempotent 5xx and gives up after three attempts", async () => {
    const { fn, calls } = fakeFetch([{ status: 503 }, { status: 503 }, { status: 503 }]);
    const { slept, sleep } = fakeSleep();
    const res = await createTypefullyFetch(fn, sleep, () => {})("https://api.typefully.com/v2/me");
    expect(res.status).toBe(503);
    expect(calls).toHaveLength(3);
    // No sleep after the final attempt — it would only delay the return.
    expect(slept).toEqual([1000, 2000]);
  });

  it("retries a network failure and returns the eventual success", async () => {
    const { fn, calls } = fakeFetch([new Error("ECONNRESET"), { status: 200 }]);
    const { sleep } = fakeSleep();
    const res = await createTypefullyFetch(fn, sleep, () => {})("https://api.typefully.com/v2/me");
    expect(res.status).toBe(200);
    expect(calls).toHaveLength(2);
  });

  it("does not retry a 4xx that is not 429", async () => {
    const { fn, calls } = fakeFetch([{ status: 400 }]);
    const { slept, sleep } = fakeSleep();
    const res = await createTypefullyFetch(fn, sleep, () => {})("https://api.typefully.com/v2/me");
    expect(res.status).toBe(400);
    expect(calls).toHaveLength(1);
    expect(slept).toEqual([]);
  });

  // The whole point of the option: a lost response on draft creation is indistinguishable from a
  // rejected one, and replaying it publishes the same post twice.
  it("does NOT retry a 5xx on a non-idempotent call", async () => {
    const { fn, calls } = fakeFetch([{ status: 502 }, { status: 200 }]);
    const { sleep } = fakeSleep();
    const res = await createTypefullyFetch(fn, sleep, () => {})("https://x/drafts", { method: "POST" }, { idempotent: false });
    expect(res.status).toBe(502);
    expect(calls).toHaveLength(1);
  });

  it("does NOT retry a network failure on a non-idempotent call, and says the request may have landed", async () => {
    const { fn, calls } = fakeFetch([new Error("ECONNRESET")]);
    const { sleep } = fakeSleep();
    const call = createTypefullyFetch(fn, sleep, () => {})("https://x/drafts", { method: "POST" }, { idempotent: false });
    await expect(call).rejects.toThrow(/may still have been processed/);
    expect(calls).toHaveLength(1);
  });

  // A 429 was rejected before it was processed, so replaying it cannot duplicate anything.
  it("DOES retry a 429 even on a non-idempotent call", async () => {
    const { fn, calls } = fakeFetch([{ status: 429 }, { status: 200 }]);
    const { sleep } = fakeSleep();
    const res = await createTypefullyFetch(fn, sleep, () => {})("https://x/drafts", { method: "POST" }, { idempotent: false });
    expect(res.status).toBe(200);
    expect(calls).toHaveLength(2);
  });

  it("logs the rate-limit headers on a 429", async () => {
    const headers = new Map([
      ["x-ratelimit-user-limit", "5000"],
      ["x-ratelimit-user-remaining", "0"],
      ["x-ratelimit-socialset-resource", "drafts.create"],
    ]);
    const { fn } = fakeFetch([
      { status: 429, headers: { get: (h: string) => headers.get(h) ?? null } as unknown as Headers },
      { status: 200 },
    ]);
    const logged: string[] = [];
    await createTypefullyFetch(fn, async () => {}, (m) => logged.push(m))("https://api.typefully.com/v2/me");
    expect(logged[0]).toContain("user-remaining=0");
    expect(logged[0]).toContain("socialset-resource=drafts.create");
  });
});
```

- [ ] **Step 2: Run the tests and confirm they fail**

Run: `pnpm vitest run tests/adapters/send/typefullyFetch.test.ts`
Expected: FAIL — cannot resolve `../../../src/adapters/send/typefullyFetch`.

- [ ] **Step 3: Write the wrapper**

Create `src/adapters/send/typefullyFetch.ts`:

```ts
export const RETRY_ATTEMPTS = 3;
export const RETRY_BASE_MS = 1000;

export interface TypefullyCallOptions {
  /**
   * Whether replaying this request is harmless. Defaults to true.
   *
   * Draft creation is the one call where it is not: a lost response is indistinguishable from a
   * rejected one, so replaying it can publish the same post twice — and the account's ceiling is
   * fifteen published posts a month, so a duplicate costs two of them.
   */
  idempotent?: boolean;
}

export type TypefullyFetch = (
  url: string,
  init?: RequestInit,
  opts?: TypefullyCallOptions,
) => Promise<Response>;

const RATE_LIMIT_HEADERS = [
  "x-ratelimit-user-limit",
  "x-ratelimit-user-remaining",
  "x-ratelimit-user-reset",
  "x-ratelimit-socialset-limit",
  "x-ratelimit-socialset-remaining",
  "x-ratelimit-socialset-reset",
  "x-ratelimit-socialset-resource",
];

/**
 * Typefully documents per-user and per-social-set buckets but publishes no numbers, and the
 * social-set headers have never appeared on any read we have made. Logging whatever is present on
 * the first real 429 is how we find out what they say.
 *
 * `headers?.get?.()` rather than `headers.get()`: a fake Response in a test need not carry headers,
 * and a missing header must not turn a rate-limit log into a crash inside the retry loop.
 */
function rateLimitSummary(res: Response): string {
  const parts = RATE_LIMIT_HEADERS.map((h) => [h, res.headers?.get?.(h)] as const)
    .filter(([, v]) => v)
    .map(([h, v]) => `${h.replace("x-ratelimit-", "")}=${v}`);
  return parts.length > 0 ? parts.join(" ") : "(no rate-limit headers)";
}

/**
 * `fetch` with Typefully's failure modes handled: transient errors are retried with the same budget
 * and backoff as `HttpClient`, and the one call that must never be replayed can say so.
 *
 * Returns the `Response` untouched, so an adapter's existing `if (!res.ok)` handling is unchanged —
 * this only decides how many times the request is made.
 */
export function createTypefullyFetch(
  fetchFn: typeof fetch = fetch,
  sleep: (ms: number) => Promise<void> = (ms) => new Promise((r) => setTimeout(r, ms)),
  log: (msg: string) => void = console.warn,
): TypefullyFetch {
  return async (url, init, opts = {}) => {
    const idempotent = opts.idempotent ?? true;
    for (let attempt = 0; ; attempt++) {
      const last = attempt === RETRY_ATTEMPTS - 1;
      let res: Response;
      try {
        res = await fetchFn(url, init);
      } catch (err) {
        // A connection that died mid-flight is not proof the server did nothing. For a call that
        // must not be replayed, say so in the message — the operator, not a retry loop, decides.
        if (!idempotent) {
          throw new Error(
            `${(err as Error).message} — the request may still have been processed; check the Typefully queue before re-running`,
            { cause: err },
          );
        }
        if (last) throw err;
        await sleep(RETRY_BASE_MS * 2 ** attempt);
        continue;
      }

      if (res.status === 429) log(`[typefully] 429 rate-limited · ${rateLimitSummary(res)}`);
      // A 429 replays safely even when the call is not idempotent: it was rejected before it was
      // processed, so there is nothing on the far side to duplicate.
      const retryable = res.status === 429 || (idempotent && res.status >= 500);
      if (!retryable || last) return res;
      await sleep(RETRY_BASE_MS * 2 ** attempt);
    }
  };
}
```

- [ ] **Step 4: Run the tests and confirm they pass**

Run: `pnpm vitest run tests/adapters/send/typefullyFetch.test.ts && pnpm typecheck`
Expected: PASS, 8 tests.

- [ ] **Step 5: Commit**

```bash
git add src/adapters/send/typefullyFetch.ts tests/adapters/send/typefullyFetch.test.ts
git commit -m "feat(send): add a Typefully fetch wrapper that retries without replaying a draft create"
```

---

### Task 3: Wire the wrapper into the four Typefully adapters

**Files:**
- Modify: `src/adapters/send/TypefullySender.ts`
- Modify: `src/adapters/send/TypefullyArticleSender.ts`
- Modify: `src/adapters/send/TypefullyMedia.ts`
- Modify: `src/adapters/send/TypefullyDraftLookup.ts`
- Test: `tests/adapters/send/typefullySender.test.ts`, `tests/adapters/send/typefullyArticleSender.test.ts`

**Interfaces:**
- Consumes: `createTypefullyFetch`, `TypefullyFetch` from Task 2.
- Produces: no constructor signature changes — every existing call site and test keeps working. Each adapter gains a private `http: TypefullyFetch` assigned in the constructor body.

`TypefullyDraftLookup` has no `sleep` parameter today; add one as the **last** parameter (default
provided) so the existing 3-argument call sites in `serve.ts` and `send-reconcile.ts` are unaffected.

- [ ] **Step 1: Write the failing tests**

Append to `tests/adapters/send/typefullySender.test.ts`:

```ts
describe("TypefullySender — retry behaviour", () => {
  it("does not retry a 5xx on draft creation: the draft may already exist", async () => {
    const calls: string[] = [];
    const fn = (async (url: string) => {
      calls.push(String(url));
      return { ok: false, status: 502, text: async () => "bad gateway" } as Response;
    }) as unknown as typeof fetch;
    const sender = new TypefullySender("KEY", "42", fn, async () => {});
    await expect(
      sender.send({ itemId: "x:1", type: "announcement", channel: "x", segments: ["hi"] }),
    ).rejects.toThrow(/may have been created/);
    expect(calls).toHaveLength(1);
  });

  it("retries a 429 on draft creation — it was rejected, not processed", async () => {
    const calls: string[] = [];
    const fn = (async (url: string) => {
      calls.push(String(url));
      return calls.length === 1
        ? ({ ok: false, status: 429, text: async () => "" } as Response)
        : ({ ok: true, status: 200, json: async () => ({ id: 7, share_url: "https://typefully.com/s/7" }) } as Response);
    }) as unknown as typeof fetch;
    const sender = new TypefullySender("KEY", "42", fn, async () => {});
    expect(await sender.send({ itemId: "x:1", type: "announcement", channel: "x", segments: ["hi"] })).toEqual({
      postId: "7",
      url: "https://typefully.com/s/7",
    });
    expect(calls).toHaveLength(2);
  });
});
```

- [ ] **Step 2: Run the tests and confirm they fail**

Run: `pnpm vitest run tests/adapters/send/typefullySender.test.ts`
Expected: FAIL — the 5xx case throws without `may have been created`; the 429 case makes one call, not two.

- [ ] **Step 3: Wire the wrapper into all four adapters**

`src/adapters/send/TypefullySender.ts` — add the import, the field, the constructor body, and route
both calls:

```ts
import { createTypefullyFetch, type TypefullyFetch } from "./typefullyFetch";
```

```ts
export class TypefullySender implements ChannelSender {
  readonly name = "x";
  private readonly http: TypefullyFetch;
  constructor(
    private readonly apiKey: string,
    private readonly socialSetId: string,
    private readonly fetchFn: typeof fetch = fetch,
    private readonly sleep: (ms: number) => Promise<void> = (ms) => new Promise((r) => setTimeout(r, ms)),
    private readonly now: () => number = () => Date.now(),
  ) {
    this.http = createTypefullyFetch(fetchFn, sleep);
  }
```

Replace the `create` call and its error branch:

```ts
    // The one Typefully call that must never be replayed: a lost response may still have left a
    // scheduled draft behind, and a second one publishes the same post twice.
    const create = await this.http(
      `${API}/social-sets/${this.socialSetId}/drafts`,
      { method: "POST", headers: this.headers(), body: JSON.stringify({ platforms: { x: { enabled: true, posts } }, publish_at: scheduledPublishAt(this.now) }) },
      { idempotent: false },
    );
    if (!create.ok) {
      const detail = await create.text().catch(() => "");
      // A 5xx is the ambiguous case — a 4xx definitively created nothing, so only the former
      // sends the operator to the queue.
      const ambiguous = create.status >= 500 ? " — the draft may have been created; check the Typefully queue before re-running" : "";
      throw new Error(`Typefully create draft failed: HTTP ${create.status}${detail ? ` — ${detail}` : ""}${ambiguous}`);
    }
```

`src/adapters/send/TypefullyArticleSender.ts` — same three edits (field, constructor body, call), with
the error message reading `Typefully create x_article draft failed: …` and the same `ambiguous` suffix.

`src/adapters/send/TypefullyMedia.ts` — add the field and constructor body, then replace every
`this.fetchFn(` with `this.http(`. All four calls stay idempotent (default): the source download and
the status poll are `GET`s, the S3 `PUT` overwrites one presigned object, and a duplicate
`media/upload` record is inert because media is never published on its own.

`src/adapters/send/TypefullyDraftLookup.ts` — add the field, add a trailing `sleep` parameter, and
route the one `GET` through `this.http`:

```ts
export class TypefullyDraftLookup {
  private readonly http: TypefullyFetch;
  constructor(
    private readonly apiKey: string,
    private readonly socialSetId: string,
    fetchFn: typeof fetch = fetch,
    sleep: (ms: number) => Promise<void> = (ms) => new Promise((r) => setTimeout(r, ms)),
  ) {
    this.http = createTypefullyFetch(fetchFn, sleep);
  }
```

- [ ] **Step 4: Run the full suite**

Run: `pnpm test && pnpm typecheck`
Expected: PASS. The existing adapter tests must still pass unchanged — if one now hangs, it is
sleeping on a real timer, so pass `async () => {}` as its `sleep` argument.

- [ ] **Step 5: Commit**

```bash
git add src/adapters/send/ tests/adapters/send/
git commit -m "feat(send): route every Typefully call through the retry wrapper"
```

---

### Task 4: `TypefullyQuota` — read the social set's monthly publishing quota

**Files:**
- Create: `src/adapters/send/TypefullyQuota.ts`
- Test: `tests/adapters/send/typefullyQuota.test.ts`

**Interfaces:**
- Consumes: `createTypefullyFetch`, `TypefullyFetch` from Task 2.
- Produces:
  - `interface PublishingQuota { used: number; remaining: number; resetsAt: string }`
  - `class TypefullyQuota { constructor(apiKey: string, socialSetId: string, fetchFn?: typeof fetch, sleep?: (ms: number) => Promise<void>); read(): Promise<PublishingQuota> }`

- [ ] **Step 1: Write the failing tests**

Create `tests/adapters/send/typefullyQuota.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { TypefullyQuota } from "../../../src/adapters/send/TypefullyQuota";

/** The live payload shape, trimmed to what this adapter reads (social set 283589, 2026-07-29). */
const LIVE = {
  id: 283589,
  username: "bcd_kyle",
  publishing_quota: { used: 9, remaining: 6, resets_at: "2026-08-01T00:00:00+09:00" },
};

function fakeFetch(body: unknown, ok = true, status = 200) {
  const calls: { url: string; auth?: string }[] = [];
  const fn = (async (url: string, init?: any) => {
    calls.push({ url: String(url), auth: init?.headers?.Authorization });
    return { ok, status, json: async () => body } as Response;
  }) as unknown as typeof fetch;
  return { fn, calls };
}

describe("TypefullyQuota", () => {
  it("reads the quota off the social set", async () => {
    const { fn, calls } = fakeFetch(LIVE);
    const quota = await new TypefullyQuota("KEY", "283589", fn, async () => {}).read();
    expect(quota).toEqual({ used: 9, remaining: 6, resetsAt: "2026-08-01T00:00:00+09:00" });
    expect(calls[0].auth).toBe("Bearer KEY");
  });

  /** Without it the API answers 301 with an empty body, which would parse as a quota of nothing. */
  it("requests the trailing-slash url", async () => {
    const { fn, calls } = fakeFetch(LIVE);
    await new TypefullyQuota("KEY", "283589", fn, async () => {}).read();
    expect(calls[0].url).toBe("https://api.typefully.com/v2/social-sets/283589/");
  });

  it("throws on a non-ok response", async () => {
    const { fn } = fakeFetch({}, false, 401);
    await expect(new TypefullyQuota("KEY", "283589", fn, async () => {}).read()).rejects.toThrow(/HTTP 401/);
  });

  // Silently reporting "0 remaining" for a payload that simply lacks the field would block every
  // send on the account for no reason.
  it("throws when the payload carries no publishing_quota", async () => {
    const { fn } = fakeFetch({ id: 283589 });
    await expect(new TypefullyQuota("KEY", "283589", fn, async () => {}).read()).rejects.toThrow(/publishing_quota/);
  });
});
```

- [ ] **Step 2: Run the tests and confirm they fail**

Run: `pnpm vitest run tests/adapters/send/typefullyQuota.test.ts`
Expected: FAIL — cannot resolve `../../../src/adapters/send/TypefullyQuota`.

- [ ] **Step 3: Write the adapter**

Create `src/adapters/send/TypefullyQuota.ts`:

```ts
import { createTypefullyFetch, type TypefullyFetch } from "./typefullyFetch";

const API = "https://api.typefully.com/v2";

export interface PublishingQuota {
  used: number;
  remaining: number;
  /** ISO-8601 with offset, e.g. `2026-08-01T00:00:00+09:00`. Empty when the API omits it. */
  resetsAt: string;
}

/**
 * The social set's monthly publishing quota — the real ceiling on X delivery.
 *
 * Not to be confused with the hourly rate limits, which are orders of magnitude looser than
 * anything this pipeline does (5000/hr on `/me`, 2500/hr on drafts, 500/hr here). The quota is
 * fifteen published posts a month on the current plan, resetting on the 1st.
 */
export class TypefullyQuota {
  private readonly http: TypefullyFetch;
  constructor(
    private readonly apiKey: string,
    private readonly socialSetId: string,
    fetchFn: typeof fetch = fetch,
    sleep: (ms: number) => Promise<void> = (ms) => new Promise((r) => setTimeout(r, ms)),
  ) {
    this.http = createTypefullyFetch(fetchFn, sleep);
  }

  async read(): Promise<PublishingQuota> {
    // The trailing slash is required. Without it the API answers 301 with an empty body — which
    // would parse as a quota of nothing and block every X send. Confirmed live 2026-07-29.
    const res = await this.http(`${API}/social-sets/${this.socialSetId}/`, {
      headers: { Authorization: `Bearer ${this.apiKey}` },
    });
    if (!res.ok) throw new Error(`Typefully social-set read failed: HTTP ${res.status}`);
    const body = (await res.json()) as {
      publishing_quota?: { used?: number; remaining?: number; resets_at?: string };
    };
    const q = body.publishing_quota;
    // "Absent" and "zero" are different answers, and only one of them should stop a send.
    if (!q || typeof q.remaining !== "number") {
      throw new Error("Typefully social-set response carried no publishing_quota");
    }
    return { used: q.used ?? 0, remaining: q.remaining, resetsAt: q.resets_at ?? "" };
  }
}
```

- [ ] **Step 4: Run the tests and confirm they pass**

Run: `pnpm vitest run tests/adapters/send/typefullyQuota.test.ts && pnpm typecheck`
Expected: PASS, 4 tests.

- [ ] **Step 5: Commit**

```bash
git add src/adapters/send/TypefullyQuota.ts tests/adapters/send/typefullyQuota.test.ts
git commit -m "feat(send): read the Typefully social set's monthly publishing quota"
```

---

### Task 5: The quota gate in `SendChannels`

**Files:**
- Modify: `src/app/SendChannels.ts` — result type ~`:38-60`, constructor ~`:69-97`, `run` ~`:138-218`
- Test: `tests/app/sendChannels.test.ts`

**Interfaces:**
- Consumes: `PublishingQuota` from Task 4; `awaitingPublish` from `src/domain/send/awaitingPublish.ts`.
- Produces:
  - `SendChannelsResult.quotaBlocked?: { needed: number; available: number; resetsAt: string }`
  - a 12th constructor parameter `quota?: () => Promise<PublishingQuota>` (last position, optional)

**Note on the constructor:** it reaches twelve parameters with this change. That is the ceiling —
if a thirteenth dependency ever appears, convert it to an options object rather than extending the
list again. Do not do that refactor in this task.

- [ ] **Step 1: Write the failing tests**

The file already has the fixtures you need — use them, do not invent parallel ones:
`rendering()` (`:18`), `source()`/`fakeTranslations()` (`:29`, `:34`), `fakeStore()` (`:42`),
`fakeLedger()` (`:45`), `okSender()` (`:61`), `sentEntry()` (`:88`), and the `TG_CHAT_IDS` constant.
Every test constructs `SendChannels` positionally, e.g.

```ts
new SendChannels(store, { telegram: undefined, x: okSender("x") }, ledger, fakeTranslations(),
  undefined, undefined, undefined, undefined, outletsForChannel, TG_CHAT_IDS)
```

The quota reader is the **12th** argument, so it goes after an `undefined` for `overrides`. Append:

```ts
describe("SendChannels — publishing quota gate", () => {
  const quotaOf = (remaining: number) => async () => ({ used: 15 - remaining, remaining, resetsAt: "2026-08-01T00:00:00+09:00" });

  it("blocks every X room when the batch needs more than the quota allows", async () => {
    // Build the same fixture the file's other X-sending tests use, but pass `quotaOf(0)` as the
    // last constructor argument.
    const result = await sendChannelsWithQuota(quotaOf(0));
    expect(result.sent).toBe(0);
    // A quota refusal is an account state, not a fault — `failed` must stay clean.
    expect(result.failed).toBe(0);
    expect(result.failures).toEqual([]);
    expect(result.quotaBlocked).toEqual({ needed: 1, available: 0, resetsAt: "2026-08-01T00:00:00+09:00" });
  });

  it("sends normally when the quota covers the batch", async () => {
    const result = await sendChannelsWithQuota(quotaOf(6));
    expect(result.sent).toBe(1);
    expect(result.quotaBlocked).toBeUndefined();
  });

  /**
   * A draft created two minutes ago has not published yet, so it is in neither `used` nor a lower
   * `remaining`. Without this term two runs inside the scheduling window each see the same headroom
   * and together overshoot the account's monthly ceiling.
   */
  it("counts rows still awaiting publish against the remaining quota", async () => {
    const result = await sendChannelsWithQuota(quotaOf(1), {
      ledgerSeed: [{ itemId: "x:9", type: "announcement", outletId: "x-post", status: "sent", at: "2026-07-29T00:00:00Z", by: "auto", postId: "10104901" }],
    });
    expect(result.sent).toBe(0);
    expect(result.quotaBlocked).toEqual({ needed: 1, available: 0, resetsAt: "2026-08-01T00:00:00+09:00" });
  });

  it("leaves telegram rooms alone when X is over quota", async () => {
    const result = await sendChannelsWithBothChannels(quotaOf(0));
    expect(result.quotaBlocked).toBeDefined();
    expect(result.sent).toBe(1); // the telegram room
  });

  // A monitoring call must never become a new way for delivery to fail.
  it("sends anyway when the quota lookup itself throws", async () => {
    const result = await sendChannelsWithQuota(async () => { throw new Error("network down"); });
    expect(result.sent).toBe(1);
    expect(result.quotaBlocked).toBeUndefined();
  });

  it("never calls the quota reader when the batch has no X rooms", async () => {
    let called = 0;
    await sendChannelsTelegramOnly(async () => { called += 1; return { used: 0, remaining: 15, resetsAt: "" }; });
    expect(called).toBe(0);
  });
});
```

Write `sendChannelsWithQuota`, `sendChannelsWithBothChannels` and `sendChannelsTelegramOnly` as thin
local helpers over those existing builders — one X rendering approved for one X room, one Telegram
room where the test needs it, and the quota reader passed as the 12th argument. `sendChannelsWithQuota`
takes an optional `{ ledgerSeed }` so the awaiting-publish test can pre-load the ledger via
`fakeLedger(seed)`; seed it with `sentEntry({ outletId: "x-post", postId: "10104901" })` so
`awaitingPublish` recognises it (an X room, `status: "sent"`, a `postId`, and no `x.com` url).

- [ ] **Step 2: Run the tests and confirm they fail**

Run: `pnpm vitest run tests/app/sendChannels.test.ts`
Expected: FAIL — `quotaBlocked` is `undefined` on a result type that does not declare it.

- [ ] **Step 3: Extend the result type and the constructor**

In `src/app/SendChannels.ts`, add the import:

```ts
import { awaitingPublish } from "../domain/send/awaitingPublish";
import type { PublishingQuota } from "../adapters/send/TypefullyQuota";
```

Add to `SendChannelsResult` after `withheld`:

```ts
  /**
   * Set when the account's monthly Typefully publishing quota could not cover this batch, in which
   * case **no** X room was delivered to. Deliberately not `failed`, for the same reason
   * `unconfigured` is not: an account at its plan's ceiling is behaving exactly as intended, and a
   * `failed N` that grows every run reads as breakage. The reason is carried here and nowhere else —
   * duplicating it into `failures` would report one event in two vocabularies.
   */
  quotaBlocked?: { needed: number; available: number; resetsAt: string };
```

Add the last constructor parameter, after `overrides`:

```ts
    /**
     * Reads the social set's monthly publishing quota. Optional: a Telegram-only install has no
     * Typefully credentials, and every pre-quota call site stays valid without it. When absent the
     * gate does not run, which is the pre-existing behaviour.
     */
    private readonly quota?: () => Promise<PublishingQuota>,
```

- [ ] **Step 4: Extract the pending-rooms filter so the gate counts what the loop sends**

Add this private method to `SendChannels`:

```ts
  /**
   * The rooms this run would deliver `r` to, and which of them have not already received it.
   *
   * Extracted so the quota gate counts exactly what the send loop will send. A second copy of this
   * filter would drift, and a gate that miscounts either refuses a legal batch or lets an
   * over-quota one through — both of which are worse than the duplication it saves.
   */
  private roomsFor(
    r: SendableRendering,
    blocked: Set<string>,
    already: Set<string>,
    deliverable: (r: ChannelRendering, o: Outlet) => boolean,
  ): { outlets: Outlet[]; pending: Outlet[] } {
    const outlets = this.outletsFor(r.channel).filter((o) => deliverable(r, o) && !blocked.has(o.id));
    const pending = outlets.filter((o) => !already.has(deliveryKey({ itemId: r.itemId, type: r.type, outletId: o.id })));
    return { outlets, pending };
  }
```

Then replace the first three lines inside the `for (const r of candidates)` loop
(`SendChannels.ts:145-148`) with:

```ts
      const { outlets, pending } = this.roomsFor(r, blocked, already, deliverable);
      const keyFor = (outlet: Outlet) => deliveryKey({ itemId: r.itemId, type: r.type, outletId: outlet.id });
      skipped += outlets.length - pending.length;
```

- [ ] **Step 5: Run the tests and confirm the extraction changed nothing**

Run: `pnpm vitest run tests/app/sendChannels.test.ts`
Expected: the pre-existing tests still PASS; the six new quota tests still FAIL.

- [ ] **Step 6: Add the gate**

Insert immediately after the `planRooms` call (`SendChannels.ts:136`) and before the send loop:

```ts
    // Before a single draft is created: can the account still publish what this batch needs?
    //
    // All-or-nothing for X, on purpose. A partial batch leaves an operator reconstructing how far
    // it got from a room-by-room ledger, and the answer changes under them as the queue publishes.
    let quotaBlocked: SendChannelsResult["quotaBlocked"];
    const xCandidates = candidates.filter((r) => r.channel === "x");
    if (this.quota && xCandidates.length > 0) {
      const needed = xCandidates.reduce((n, r) => n + this.roomsFor(r, blocked, already, deliverable).pending.length, 0);
      if (needed > 0) {
        try {
          const q = await this.quota();
          // A draft scheduled minutes ago has not published yet, so it is in neither `used` nor a
          // lower `remaining`. These rows are already in memory, so the correction is free.
          const inFlight = ledgered.filter((row) => awaitingPublish(row)).length;
          const available = q.remaining - inFlight;
          if (needed > available) {
            quotaBlocked = { needed, available, resetsAt: q.resetsAt };
            for (const o of this.outletsFor("x")) blocked.add(o.id);
            console.warn(`[send] X withheld: the batch needs ${needed} publish(es), ${available} left before ${q.resetsAt || "the next reset"}`);
          }
        } catch (err) {
          // A monitoring call must not become a new way for delivery to fail.
          console.warn(`[send] could not read the Typefully publishing quota, sending anyway: ${(err as Error).message}`);
        }
      }
    }
```

Add `quotaBlocked` to the returned object at `SendChannels.ts:218`:

```ts
    return { sent, skipped, failed, unconfigured: unconfiguredEnv.length, unconfiguredEnv, withheld, failures, quotaBlocked };
```

- [ ] **Step 7: Run the full suite**

Run: `pnpm test && pnpm typecheck`
Expected: PASS.

- [ ] **Step 8: Commit**

```bash
git add src/app/SendChannels.ts tests/app/sendChannels.test.ts
git commit -m "feat(send): refuse an X batch the monthly publishing quota cannot cover"
```

---

### Task 6: Pass the quota reader from the CLI and the dashboard

**Files:**
- Modify: `src/cli/send-channels.ts`
- Modify: `src/cli/serve.ts` — the `SendChannels` construction inside `sendToOutlet` (~`:303`)
- Create: `src/cli/typefullyQuotaReader.ts`
- Test: `tests/cli/typefullyQuotaReader.test.ts`

**Interfaces:**
- Consumes: `TypefullyQuota`, `PublishingQuota` (Task 4); `loadTypefullyConfig` from `src/config.ts:201`.
- Produces: `quotaReader(targets: SendableChannel[]): (() => Promise<PublishingQuota>) | undefined` — `undefined` when X is not a target or Typefully is unconfigured, so a Telegram-only install never constructs a Typefully client.

- [ ] **Step 1: Write the failing test**

Create `tests/cli/typefullyQuotaReader.test.ts`:

```ts
import { describe, it, expect, afterEach } from "vitest";
import { quotaReader } from "../../src/cli/typefullyQuotaReader";

const env = { ...process.env };
afterEach(() => { process.env = { ...env }; });

describe("quotaReader", () => {
  it("is undefined when X is not a target", () => {
    process.env.TYPEFULLY_API_KEY = "KEY";
    process.env.TYPEFULLY_SOCIAL_SET_ID = "42";
    expect(quotaReader(["telegram"])).toBeUndefined();
  });

  // A Telegram-only install has no Typefully credentials; it must not fail to start over a gate
  // that has nothing to guard.
  it("is undefined when Typefully is unconfigured", () => {
    delete process.env.TYPEFULLY_API_KEY;
    delete process.env.TYPEFULLY_SOCIAL_SET_ID;
    expect(quotaReader(["x"])).toBeUndefined();
  });

  it("is a reader when X is a target and Typefully is configured", () => {
    process.env.TYPEFULLY_API_KEY = "KEY";
    process.env.TYPEFULLY_SOCIAL_SET_ID = "42";
    expect(typeof quotaReader(["x"])).toBe("function");
  });
});
```

- [ ] **Step 2: Run the test and confirm it fails**

Run: `pnpm vitest run tests/cli/typefullyQuotaReader.test.ts`
Expected: FAIL — cannot resolve `../../src/cli/typefullyQuotaReader`.

- [ ] **Step 3: Write the reader**

Create `src/cli/typefullyQuotaReader.ts`:

```ts
import { TypefullyQuota, type PublishingQuota } from "../adapters/send/TypefullyQuota";
import { loadTypefullyConfig } from "../config";
import type { SendableChannel } from "../domain/send/channels";

/**
 * The quota reader `SendChannels` gates X sends with — or `undefined` when there is nothing to gate.
 *
 * Mirrors how `createSenders` only builds the senders it was asked for: a Telegram-only install has
 * no Typefully credentials and must not fail to start over a guard it does not need.
 */
export function quotaReader(targets: SendableChannel[]): (() => Promise<PublishingQuota>) | undefined {
  if (!targets.includes("x")) return undefined;
  let cfg;
  try {
    cfg = loadTypefullyConfig();
  } catch {
    // Unconfigured — `createSenders` will not build an X sender either, so there is no send to gate.
    return undefined;
  }
  const quota = new TypefullyQuota(cfg.apiKey, cfg.socialSetId);
  return () => quota.read();
}
```

- [ ] **Step 4: Wire both call sites**

In `src/cli/send-channels.ts`, import `quotaReader` and pass `quotaReader(targets)` as the **last**
argument to the `SendChannels` constructor (after `overrides`). Read the file first to get the
existing argument list exactly right.

In `src/cli/serve.ts`, do the same for the `new SendChannels(...)` inside `sendToOutlet` (~`:303`),
passing `quotaReader([channel])`.

Then surface the refusal. In `send-channels.ts`, after the run, add to the summary output:

```ts
  if (result.quotaBlocked) {
    const { needed, available, resetsAt } = result.quotaBlocked;
    console.warn(`⚠ X was not sent: this batch needs ${needed} publish(es) and the account has ${available} left${resetsAt ? ` until ${resetsAt}` : ""}.`);
  }
```

In `serve.ts`'s `sendToOutlet`, turn it into the `error` the board already renders:

```ts
    if (result.quotaBlocked) {
      const { needed, available, resetsAt } = result.quotaBlocked;
      const when = resetsAt ? ` (${resetsAt.slice(0, 10)} 리셋)` : "";
      return { sent: 0, failed: 0, error: `Typefully 월간 발행 쿼터가 부족합니다 — 필요 ${needed}건, 잔여 ${available}건${when}` };
    }
```

Place that check before the existing return so a quota refusal is never reported as a plain
zero-send.

- [ ] **Step 5: Run the full suite**

Run: `pnpm test && pnpm typecheck`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/cli/typefullyQuotaReader.ts src/cli/send-channels.ts src/cli/serve.ts tests/cli/typefullyQuotaReader.test.ts
git commit -m "feat(send): gate CLI and dashboard X sends on the publishing quota"
```

---

### Task 7: Automatic reconcile in `serve`

**Files:**
- Create: `src/cli/reconcileScheduler.ts`
- Modify: `src/cli/serve.ts` — near the `startServer(...)` call at the end
- Test: `tests/cli/reconcileScheduler.test.ts`

**Interfaces:**
- Consumes: `reconcilePublished` as already defined in `serve.ts:247` — `() => Promise<{ reconciled: number; pending: number; error?: string }>`.
- Produces: `startReconcileScheduler(run, opts?): () => void` — returns a `stop()`. `opts` is `{ intervalMs?: number; log?: (msg: string) => void }`.

`ReconcilePublished` already `continue`s past every row that is not awaiting publish **before**
calling Typefully (`ReconcilePublished.ts:51`, `:68`), so an idle tick costs zero API calls. The
scheduler needs no "is anything pending" guard of its own.

- [ ] **Step 1: Write the failing tests**

Create `tests/cli/reconcileScheduler.test.ts`:

```ts
import { describe, it, expect, vi, afterEach } from "vitest";
import { startReconcileScheduler } from "../../src/cli/reconcileScheduler";

afterEach(() => vi.useRealTimers());

describe("startReconcileScheduler", () => {
  it("runs a pass on each tick", async () => {
    vi.useFakeTimers();
    let runs = 0;
    const stop = startReconcileScheduler(async () => { runs += 1; return { reconciled: 0, pending: 0 }; }, { intervalMs: 1000, log: () => {} });
    await vi.advanceTimersByTimeAsync(2500);
    stop();
    expect(runs).toBe(2);
  });

  /** Typefully is slow sometimes; overlapping passes would double every lookup for no gain. */
  it("skips a tick while the previous pass is still running", async () => {
    vi.useFakeTimers();
    let started = 0;
    let release!: () => void;
    const gate = new Promise<void>((r) => { release = r; });
    const stop = startReconcileScheduler(async () => { started += 1; await gate; return { reconciled: 0, pending: 0 }; }, { intervalMs: 1000, log: () => {} });
    await vi.advanceTimersByTimeAsync(3500);
    expect(started).toBe(1);
    release();
    await vi.advanceTimersByTimeAsync(1000);
    stop();
    expect(started).toBe(2);
  });

  // An unhandled rejection here would take the whole dashboard down.
  it("does not propagate a throwing pass, and keeps ticking", async () => {
    vi.useFakeTimers();
    let runs = 0;
    const logged: string[] = [];
    const stop = startReconcileScheduler(async () => { runs += 1; throw new Error("boom"); }, { intervalMs: 1000, log: (m) => logged.push(m) });
    await vi.advanceTimersByTimeAsync(2500);
    stop();
    expect(runs).toBe(2);
    expect(logged.join(" ")).toContain("boom");
  });

  it("stops ticking after stop()", async () => {
    vi.useFakeTimers();
    let runs = 0;
    const stop = startReconcileScheduler(async () => { runs += 1; return { reconciled: 0, pending: 0 }; }, { intervalMs: 1000, log: () => {} });
    await vi.advanceTimersByTimeAsync(1500);
    stop();
    await vi.advanceTimersByTimeAsync(5000);
    expect(runs).toBe(1);
  });
});
```

- [ ] **Step 2: Run the tests and confirm they fail**

Run: `pnpm vitest run tests/cli/reconcileScheduler.test.ts`
Expected: FAIL — cannot resolve `../../src/cli/reconcileScheduler`.

- [ ] **Step 3: Write the scheduler**

Create `src/cli/reconcileScheduler.ts`:

```ts
import { PUBLISH_DELAY_MS } from "../adapters/send/typefullyPublish";

type ReconcilePass = () => Promise<{ reconciled: number; pending: number; error?: string }>;

/**
 * Poll Typefully for scheduled drafts that have gone live, so the board stops showing `예약됨` for
 * a post that published minutes ago without anyone clicking [게시 확인].
 *
 * The interval matches the delay a send schedules with: checking faster than posts can publish only
 * spends rate limit. An idle tick is genuinely free — `ReconcilePublished` skips every row that is
 * not awaiting publish before it calls Typefully, so a board with nothing pending makes no requests.
 */
export function startReconcileScheduler(
  run: ReconcilePass,
  opts: { intervalMs?: number; log?: (msg: string) => void } = {},
): () => void {
  const intervalMs = opts.intervalMs ?? PUBLISH_DELAY_MS;
  const log = opts.log ?? console.warn;
  let running = false;

  const timer = setInterval(() => {
    // Typefully can be slow; a second pass over the same rows would only double the lookups.
    if (running) return;
    running = true;
    void run()
      .then((r) => {
        if (r.error) log(`[reconcile] pass reported an error: ${r.error}`);
        else if (r.reconciled > 0) log(`[reconcile] ${r.reconciled} row(s) now carry their x.com url`);
      })
      .catch((err) => log(`[reconcile] pass failed: ${(err as Error).message}`))
      .finally(() => { running = false; });
  }, intervalMs);

  // Never hold the process open for a background poll.
  timer.unref?.();
  return () => clearInterval(timer);
}
```

- [ ] **Step 4: Run the tests and confirm they pass**

Run: `pnpm vitest run tests/cli/reconcileScheduler.test.ts && pnpm typecheck`
Expected: PASS, 4 tests.

- [ ] **Step 5: Start it from `serve.ts`**

Add the import and, immediately after the existing `startServer(deps, …)` call, add:

```ts
// The board's [게시 확인] button stays — this only means an operator who never clicks it still
// sees real x.com links, a couple of minutes after the post goes out.
const stopReconcile = startReconcileScheduler(reconcilePublished, { log: (m) => console.log(m) });
for (const sig of ["SIGINT", "SIGTERM"] as const) process.once(sig, () => { stopReconcile(); process.exit(0); });
```

- [ ] **Step 6: Verify the server still boots**

Run: `pnpm build:web && timeout 12 pnpm serve 2>&1 | head -20`
Expected: the `Review dashboard on http://localhost:…` line, no crash, no reconcile error within
the first ticks. (The first tick is two minutes out, so this only proves the wiring is sound.)

- [ ] **Step 7: Commit**

```bash
git add src/cli/reconcileScheduler.ts src/cli/serve.ts tests/cli/reconcileScheduler.test.ts
git commit -m "feat(send): reconcile scheduled X posts on a timer instead of on a click"
```

---

### Task 8: doctor checks for Typefully

**Files:**
- Modify: `src/doctor/checks.ts`
- Modify: `src/cli/doctor.ts` — offline block ~`:41-56`, live block ~`:130-146`
- Test: `tests/doctor/checks.test.ts`

**Interfaces:**
- Consumes: `PublishingQuota` (Task 4), `CheckResult` from `src/doctor/report.ts:3`.
- Produces: `LOW_PUBLISHING_QUOTA = 3` and `quotaResult(name: string, q: PublishingQuota): CheckResult`, both exported from `src/doctor/checks.ts`. Task 9 imports `LOW_PUBLISHING_QUOTA`.

- [ ] **Step 1: Write the failing tests**

Append to `tests/doctor/checks.test.ts`:

```ts
describe("quotaResult", () => {
  it("is ok with headroom, and names the total and the reset date", () => {
    const r = quotaResult("Typefully  live", { used: 9, remaining: 6, resetsAt: "2026-08-01T00:00:00+09:00" });
    expect(r.status).toBe("ok");
    expect(r.detail).toContain("6 left of 15");
    expect(r.detail).toContain("2026-08-01");
  });

  it("warns at the low-quota threshold", () => {
    expect(quotaResult("t", { used: 12, remaining: 3, resetsAt: "" }).status).toBe("warn");
    expect(quotaResult("t", { used: 11, remaining: 4, resetsAt: "" }).status).toBe("ok");
  });

  it("warns at zero rather than failing — an exhausted plan is not a broken install", () => {
    expect(quotaResult("t", { used: 15, remaining: 0, resetsAt: "" }).status).toBe("warn");
  });

  it("omits the reset clause when the API did not give one", () => {
    expect(quotaResult("t", { used: 0, remaining: 15, resetsAt: "" }).detail).not.toContain("resets");
  });
});
```

Add `quotaResult` to the file's import from `../../src/doctor/checks`.

- [ ] **Step 2: Run the tests and confirm they fail**

Run: `pnpm vitest run tests/doctor/checks.test.ts`
Expected: FAIL — `quotaResult` is not exported.

- [ ] **Step 3: Add the check helper**

Append to `src/doctor/checks.ts`:

```ts
/**
 * Below this many remaining publishes, say so. Roughly a day's sends at the current cadence — late
 * enough not to nag, early enough to upgrade or reschedule before a batch is refused outright.
 * Shared with the dashboard banner so the CLI and the screen never disagree about when to worry.
 */
export const LOW_PUBLISHING_QUOTA = 3;

/**
 * The social set's monthly publishing quota. Never `fail`: an account at its plan's ceiling is
 * working exactly as sold, and doctor exiting non-zero over it would be wrong.
 */
export function quotaResult(
  name: string,
  q: { used: number; remaining: number; resetsAt: string },
): CheckResult {
  const resets = q.resetsAt ? ` · resets ${q.resetsAt.slice(0, 10)}` : "";
  return {
    name,
    status: q.remaining <= LOW_PUBLISHING_QUOTA ? "warn" : "ok",
    detail: `publishing quota ${q.remaining} left of ${q.used + q.remaining}${resets}`,
  };
}
```

- [ ] **Step 4: Run the tests and confirm they pass**

Run: `pnpm vitest run tests/doctor/checks.test.ts`
Expected: PASS.

- [ ] **Step 5: Wire both doctor blocks**

In `src/cli/doctor.ts`, add imports for `loadTypefullyConfig`, `TypefullyQuota` and `quotaResult`.

Offline, next to the other optional credentials (after the Google Sheet line, ~`:56`):

```ts
// X delivery is opt-in — a Telegram-only install is a valid setup, not a broken one.
results.push(optionalCheck("Typefully (X)", () => loadTypefullyConfig(), "only needed to send to X"));
```

Live, inside the `if (live)` block after the Lark check (~`:145`):

```ts
try {
  const t = loadTypefullyConfig();
  // Two calls on purpose: /me proves the key, the social set proves the id and carries the quota.
  // Reporting "quota unreadable" for what is really a bad key would send the operator the wrong way.
  const me = await fetch("https://api.typefully.com/v2/me", { headers: { Authorization: `Bearer ${t.apiKey}` } });
  if (!me.ok) {
    results.push({ name: "Typefully  live", status: "fail", detail: `GET /v2/me → HTTP ${me.status} — check TYPEFULLY_API_KEY` });
  } else {
    try {
      results.push(quotaResult("Typefully  live", await new TypefullyQuota(t.apiKey, t.socialSetId).read()));
    } catch (err) {
      results.push({ name: "Typefully  live", status: "fail", detail: `key OK, social set unreadable — check TYPEFULLY_SOCIAL_SET_ID (${(err as Error).message})` });
    }
  }
} catch {
  // TYPEFULLY_* not set — the offline check above already reported it as a warn.
}
```

- [ ] **Step 6: Run doctor for real**

Run: `pnpm test && pnpm typecheck && pnpm doctor --live 2>&1 | grep -i typefully`
Expected: a `✓ Typefully  live  publishing quota N left of 15 · resets 2026-08-01` line (or `⚠` if
`N <= 3` — at the time of writing the account has 6 remaining, so `✓`).

- [ ] **Step 7: Commit**

```bash
git add src/doctor/checks.ts src/cli/doctor.ts tests/doctor/checks.test.ts
git commit -m "feat(doctor): check the Typefully key and report the publishing quota"
```

---

### Task 9: Quota endpoint and the board banner

**Files:**
- Modify: `src/cli/serve.ts` — add `loadQuota` next to `reconcilePublished` (~`:263`) and to `deps`
- Modify: `src/adapters/web/apiHandlers.ts` — `ApiDeps` (~`:56-80`) and a new route
- Modify: `web/src/api.ts`
- Modify: `web/src/types.ts`
- Modify: `web/src/components/OutletBoard.tsx`
- Test: `tests/adapters/web/apiHandlers.test.ts`

**Interfaces:**
- Consumes: `TypefullyQuota`/`PublishingQuota` (Task 4), `LOW_PUBLISHING_QUOTA` (Task 8).
- Produces: `GET /api/typefully/quota` → `200 { quota: { used, remaining, resetsAt } }` or `200 { error: string }`. Always `200`: an unreadable quota is information for the banner, not a client error.

- [ ] **Step 1: Write the failing test**

The file builds deps with `makeDeps(...)` (`:36`) and calls `handleApi(deps, method, path, body)`
(imported at `:3`). `makeDeps` will need a default `loadQuota` so its other callers keep type-checking —
add one returning `{ error: "not configured" }`. Append:

```ts
describe("GET /api/typefully/quota", () => {
  const QUOTA = { used: 9, remaining: 6, resetsAt: "2026-08-01T00:00:00+09:00" };

  it("returns the quota", async () => {
    const d = makeDeps();
    d.loadQuota = async () => ({ quota: QUOTA });
    const res = await handleApi(d, "GET", "/api/typefully/quota", undefined);
    expect(res.status).toBe(200);
    expect(res.json).toEqual({ quota: QUOTA });
  });

  // The banner must be able to tell "unknown" from "exhausted" — rendering an error as 0 would
  // paint a healthy account as blocked.
  it("returns the error rather than a zero quota", async () => {
    const d = makeDeps();
    d.loadQuota = async () => ({ error: "HTTP 401" });
    const res = await handleApi(d, "GET", "/api/typefully/quota", undefined);
    expect(res.status).toBe(200);
    expect(res.json).toEqual({ error: "HTTP 401" });
  });
});
```

Read `makeDeps`' signature first — if its parameters are positional, pass the override the way the
file's other tests do rather than reassigning the field.

- [ ] **Step 2: Run the test and confirm it fails**

Run: `pnpm vitest run tests/adapters/web/apiHandlers.test.ts`
Expected: FAIL — the route 404s.

- [ ] **Step 3: Add the dep and the route**

In `src/adapters/web/apiHandlers.ts`, import the type and add to `ApiDeps` after `reconcilePublished`:

```ts
  /** The Typefully publishing quota for the banner. `error` when it could not be read. */
  loadQuota: () => Promise<{ quota?: PublishingQuota; error?: string }>;
```

with `import type { PublishingQuota } from "../../adapters/send/TypefullyQuota";` — adjust the
relative path to `"../send/TypefullyQuota"` if that is what resolves from this file.

Add the route alongside the other top-level `/api/...` routes (not under `items`, since the quota is
account-wide):

```ts
  // Account-wide, not per item — and deliberately not a field on BoardView: board loads are
  // frequent and the social-set bucket is the smallest rate limit we measured (500/hr).
  if (method === "GET" && segments[1] === "typefully" && segments[2] === "quota") {
    return { status: 200, json: await deps.loadQuota() };
  }
```

- [ ] **Step 4: Implement `loadQuota` in `serve.ts`**

Add near `reconcilePublished` (~`:263`):

```ts
/** A minute is long enough to spare the smallest rate-limit bucket, short enough to stay true. */
const QUOTA_TTL_MS = 60_000;
let quotaCache: { at: number; value: PublishingQuota } | undefined;

const loadQuota = async (): Promise<{ quota?: PublishingQuota; error?: string }> => {
  if (quotaCache && Date.now() - quotaCache.at < QUOTA_TTL_MS) return { quota: quotaCache.value };
  try {
    const t = loadTypefullyConfig();
    const value = await new TypefullyQuota(t.apiKey, t.socialSetId).read();
    quotaCache = { at: Date.now(), value };
    return { quota: value };
  } catch (err) {
    // Not cached: a transient failure must not blank the banner for a full minute.
    return { error: (err as Error).message };
  }
};
```

Add `loadQuota,` to the `deps` object.

- [ ] **Step 5: Add the client call and the type**

In `web/src/types.ts`:

```ts
export interface PublishingQuota {
  used: number;
  remaining: number;
  resetsAt: string;
}

/** Mirrors `LOW_PUBLISHING_QUOTA` in src/doctor/checks.ts — the CLI and the board agree on "low". */
export const LOW_PUBLISHING_QUOTA = 3;
```

In `web/src/api.ts`, alongside `reconcile`:

```ts
  typefullyQuota: async (): Promise<{ quota?: PublishingQuota; error?: string }> => {
    const res = await fetch("/api/typefully/quota");
    return (await res.json().catch(() => ({}))) as { quota?: PublishingQuota; error?: string };
  },
```

- [ ] **Step 6: Render the banner**

In `web/src/components/OutletBoard.tsx`, add state and a load on mount:

```ts
  const [quota, setQuota] = useState<PublishingQuota | null>(null);
  const loadQuota = useCallback(async () => {
    const r = await api.typefullyQuota();
    // An unreadable quota is not an empty one: show nothing rather than paint the account as blocked.
    setQuota(r.quota ?? null);
  }, []);
  useEffect(() => { void loadQuota(); }, [loadQuota]);
```

Call `void loadQuota();` from wherever the board already refreshes after a send, so the count drops
as posts go out.

Render above the group cards, matching the file's existing inline-style conventions:

```tsx
      {quota && (
        <div
          style={{
            marginBottom: 12,
            padding: "6px 10px",
            borderRadius: 6,
            fontSize: 13,
            background: quota.remaining <= LOW_PUBLISHING_QUOTA ? "#fef3c7" : "#f1f5f9",
            color: quota.remaining <= LOW_PUBLISHING_QUOTA ? "#92400e" : "#475569",
          }}
        >
          X 발행 잔여 <strong>{quota.remaining}건</strong> / {quota.used + quota.remaining}건
          {quota.resetsAt ? ` · ${quota.resetsAt.slice(5, 10).replace("-", "/")} 리셋` : ""}
        </div>
      )}
```

- [ ] **Step 7: Verify it in a browser**

Run: `pnpm build:web && pnpm serve`, open the board for any item with an X room, and confirm the
banner reads the same number `pnpm doctor --live` reported in Task 8. Then confirm that stopping the
network (or temporarily breaking `TYPEFULLY_API_KEY`) hides the banner rather than showing `0건`.

- [ ] **Step 8: Run the full suite and commit**

Run: `pnpm test && pnpm typecheck && pnpm build:web`

```bash
git add src/cli/serve.ts src/adapters/web/apiHandlers.ts web/src tests/adapters/web/apiHandlers.test.ts
git commit -m "feat(board): show the remaining Typefully publishing quota"
```

---

### Task 10: Document the quota for the team

**Files:**
- Modify: `docs/ko/setup/channels.md`
- Modify: `docs/ko/team-runbook.md`
- Modify: `.env.example` — the Typefully block at `:197-201`

**Interfaces:**
- Consumes: nothing. Documentation only.

Korean, per the docs convention — these are the pages non-developers read.

- [ ] **Step 1: Document the ceiling in the channel setup guide**

In `docs/ko/setup/channels.md`, under the Typefully section, add a short subsection covering: the
monthly publishing quota is the real limit (not the hourly rate limit); the current plan allows 15
published posts a month, resetting on the 1st (KST); `pnpm doctor --live` and the board banner both
report the remaining count; a batch that needs more than the account has left is refused in full
rather than partially sent.

- [ ] **Step 2: Add the operator's line to the runbook**

In `docs/ko/team-runbook.md`, wherever the X send is described, add that the board's banner shows the
remaining publishes, and that a `Typefully 월간 발행 쿼터가 부족합니다` message means the send was
**not** attempted — nothing was posted, and re-running after the reset will send it.

- [ ] **Step 3: Note it in `.env.example`**

Extend the comment above `TYPEFULLY_API_KEY` (`.env.example:197-199`) to mention that the plan's
monthly publishing quota — not the API rate limit — is what bounds X delivery, and that
`pnpm doctor --live` reports the remaining count.

- [ ] **Step 4: Commit**

```bash
git add docs/ko .env.example
git commit -m "docs(ko): explain the Typefully monthly publishing quota"
```

---

## Wrap-up

- [ ] **Run the full verification**

Run: `pnpm test && pnpm typecheck && pnpm build:web && pnpm doctor --live`
Expected: all green; the Typefully live check reports the quota.

- [ ] **Push and open a PR**

```bash
git push -u origin fix/typefully-quota-and-resilience
gh pr create --title "feat(send): enforce the Typefully publishing quota, retry safely, reconcile automatically" --body "$(cat <<'EOF'
Implements docs/superpowers/specs/2026-07-29-typefully-quota-and-resilience-design.md.

A live audit of the Typefully integration found the binding limit is not the hourly rate limit
(5000/hr on /me, 2500/hr on drafts, 500/hr on the social set — nowhere near our volume) but the
social set's **monthly publishing quota**: 15 posts, resetting on the 1st, with 9 already spent.
Nothing in the codebase read it.

- **Quota gate** — `send:channels` reads the quota once per batch and refuses X in full when the
  batch needs more than the account has left, counting scheduled-but-unpublished drafts against
  the remaining headroom. Reported as `quotaBlocked`, not `failed`: an account at its plan's
  ceiling is not a broken install.
- **Retries** — every Typefully call now goes through a wrapper that retries 429/5xx/network
  errors, *except* draft creation on 5xx/network, where a lost response is indistinguishable from
  a rejected one and a replay would publish the same post twice.
- **`parseArticleId`** — Typefully returns `/status/<id>` for `x_article_published_url`, not
  `/i/article/<id>`, so the article ledger was keeping a Typefully draft id as its `postId`.
- **Automatic reconcile** — the board no longer needs a human to click [게시 확인] for a scheduled
  post to gain its x.com url.
- **Visibility** — `pnpm doctor --live` and a board banner both report the remaining quota.
EOF
)"
```

---

## Self-Review

**Spec coverage.** Every section of the design maps to a task: `TypefullyQuota` → 4; quota gate and
`quotaBlocked` → 5, surfaced by 6; `typefullyFetch` and the idempotency asymmetry → 2, wired in 3;
`parseArticleId` → 1; automatic reconcile → 7; doctor → 8; board banner and the 60s cache → 9. The
spec's "low-quota threshold" and "omit the banner on error" clarifications are covered by 8 and 9.
Task 10 is documentation the spec implies but does not itemise.

**Type consistency.** `PublishingQuota` is defined once in Task 4 and imported by 5, 8 and 9;
`web/src/types.ts` restates it structurally because the web bundle does not import from `src/`, and
`LOW_PUBLISHING_QUOTA` is duplicated there for the same reason — both are commented as mirrors.
`TypefullyFetch` and `createTypefullyFetch` are defined in Task 2 and used under those exact names in
3 and 4. `quotaBlocked` carries `{ needed, available, resetsAt }` in the result type, the tests, the
CLI summary and the board error alike.

**Ordering.** Tasks 1, 2, 4 and 7 are independent. Task 3 needs 2; Task 5 needs 4; Task 6 needs 5;
Task 8 needs 4; Task 9 needs 4 and 8. Working in numeric order satisfies every dependency.
