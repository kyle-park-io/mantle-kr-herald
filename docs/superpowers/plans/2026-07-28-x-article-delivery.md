# X Article Delivery Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Post an approved article translation to X as an **X Article** via Typefully (`send:x-article`) — title/headings/body from the Korean translation, inline images and cover uploaded via Typefully — leaving the existing Telegram 공지 path untouched.

**Architecture:** A dedicated `SendXArticle` use-case + CLI operating on approved **article** translations (not renderings). PR #72's Typefully media-upload flow is extracted into a shared `TypefullyMedia`; images from `![](url)` (and the cover) are uploaded, then `![](url)` is rewritten to `<typ:media media_id="…" />`, and the `x_article` draft is posted.

**Tech Stack:** TypeScript (ESM, hexagonal ports/adapters), vitest, native fetch. No new runtime deps.

## Global Constraints

- Operates on **article** translations only (kind derived from items.json); non-articles are untouched.
- Reuses PR #72's Typefully media flow via the extracted `TypefullyMedia` — **#72's `TypefullySender` behavior/tests must stay green** after the extraction.
- Idempotent: a dedicated `output/publish/x-article.json` ledger keyed by itemId; **upload before the draft POST** so a media failure never makes a partial live post.
- `x_article` payload: `{ platforms: { x_article: { content_markdown, cover_media_id? } }, publish_at: "now" }` — **no `enabled`, no `posts`**; published url is **`x_article_published_url`** (`x.com/i/article/<id>`).
- Repo is PUBLIC — tests use placeholder urls/keys/ids only; no live network in tests; live publish is final.
- Ends green: `pnpm test` + `pnpm exec tsc --noEmit`.

---

### Task 1: Extract `TypefullyMedia` (shared Typefully upload) + refactor `TypefullySender`

**Files:**
- Create: `src/adapters/send/TypefullyMedia.ts`
- Modify: `src/adapters/send/TypefullySender.ts` (compose `TypefullyMedia`)
- Test: `tests/adapters/send/typefullyMedia.test.ts`; keep `tests/adapters/send/typefullySender.test.ts` green.

**Interfaces:**
- Produces: `class TypefullyMedia { constructor(apiKey, socialSetId, fetchFn?, sleep?); upload(url: string): Promise<string> }` (returns a `media_id`).

- [ ] **Step 1: Write the failing test** — `tests/adapters/send/typefullyMedia.test.ts` (URL-routing fake, same style as #72):
```ts
import { describe, it, expect } from "vitest";
import { TypefullyMedia } from "../../../src/adapters/send/TypefullyMedia";

function routingFetch(overrides: Record<string, () => Response> = {}) {
  const calls: { url: string; method: string; isBinary?: boolean }[] = [];
  const fn = (async (url: string, init?: any) => {
    const u = String(url);
    const method = init?.method ?? "GET";
    const isBinary = init?.body instanceof ArrayBuffer || ArrayBuffer.isView(init?.body);
    calls.push({ url: u, method, isBinary });
    for (const key in overrides) if (u.includes(key)) return overrides[key]();
    const reply = (body: unknown, ct = "application/json") =>
      ({ ok: true, status: 200, json: async () => body, text: async () => JSON.stringify(body), arrayBuffer: async () => new ArrayBuffer(4), headers: { get: () => ct } }) as unknown as Response;
    if (u.includes("pbs.twimg.com")) return reply({}, "image/png");
    if (u.endsWith("/media/upload")) return reply({ media_id: "M1", upload_url: "https://s3.example/put" });
    if (u === "https://s3.example/put") return reply({});
    if (u.includes("/media/M1")) return reply({ status: "ready" });
    return reply({});
  }) as unknown as typeof fetch;
  return { fn, calls };
}
const noSleep = async () => {};

describe("TypefullyMedia", () => {
  it("downloads, uploads to presigned S3, polls ready, and returns the media_id", async () => {
    const { fn, calls } = routingFetch();
    const id = await new TypefullyMedia("KEY", "42", fn, noSleep).upload("https://pbs.twimg.com/media/a.png");
    expect(id).toBe("M1");
    expect(calls.map((c) => c.method)).toEqual(["GET", "POST", "PUT", "GET"]); // download, upload, s3 put, poll
    expect(calls.find((c) => c.url === "https://s3.example/put")!.isBinary).toBe(true);
    expect(calls[1].url).toContain("/social-sets/42/media/upload");
  });

  it("throws when a media step fails", async () => {
    const { fn } = routingFetch({ "/media/upload": () => ({ ok: false, status: 500, text: async () => "boom" } as Response) });
    await expect(new TypefullyMedia("KEY", "42", fn, noSleep).upload("https://pbs.twimg.com/media/a.png")).rejects.toThrow(/media/i);
  });

  it("throws when processing never becomes ready", async () => {
    const { fn } = routingFetch({ "/media/M1": () => ({ ok: true, status: 200, json: async () => ({ status: "processing" }) } as unknown as Response) });
    await expect(new TypefullyMedia("KEY", "42", fn, noSleep).upload("https://pbs.twimg.com/media/a.png")).rejects.toThrow(/not ready/i);
  });
});
```

- [ ] **Step 2: Run — expect FAIL**: `pnpm exec vitest run tests/adapters/send/typefullyMedia.test.ts`

- [ ] **Step 3: Implement** `src/adapters/send/TypefullyMedia.ts`:
```ts
// src/adapters/send/TypefullyMedia.ts
const API = "https://api.typefully.com/v2";
const POLL_ATTEMPTS = 10;
const POLL_DELAY_MS = 1500;

/** Uploads a media URL to Typefully and returns its media_id (v2 presigned-S3 flow). */
export class TypefullyMedia {
  constructor(
    private readonly apiKey: string,
    private readonly socialSetId: string,
    private readonly fetchFn: typeof fetch = fetch,
    private readonly sleep: (ms: number) => Promise<void> = (ms) => new Promise((r) => setTimeout(r, ms)),
  ) {}

  private headers(): Record<string, string> {
    return { Authorization: `Bearer ${this.apiKey}`, "Content-Type": "application/json" };
  }

  async upload(url: string): Promise<string> {
    const dl = await this.fetchFn(url);
    if (!dl.ok) throw new Error(`Typefully media download failed: HTTP ${dl.status} for ${url}`);
    const bytes = await dl.arrayBuffer();
    const contentType = dl.headers.get("content-type") ?? "image/jpeg";
    const fileName = url.split("/").pop()?.split("?")[0] || "media.jpg";

    const up = await this.fetchFn(`${API}/social-sets/${this.socialSetId}/media/upload`, {
      method: "POST",
      headers: this.headers(),
      body: JSON.stringify({ file_name: fileName }),
    });
    if (!up.ok) throw new Error(`Typefully media/upload failed: HTTP ${up.status}`);
    const { media_id, upload_url } = (await up.json()) as { media_id: string; upload_url: string };

    const put = await this.fetchFn(upload_url, { method: "PUT", headers: { "Content-Type": contentType }, body: bytes });
    if (!put.ok) throw new Error(`Typefully media S3 upload failed: HTTP ${put.status}`);

    for (let i = 0; i < POLL_ATTEMPTS; i++) {
      const st = await this.fetchFn(`${API}/social-sets/${this.socialSetId}/media/${media_id}`, { headers: this.headers() });
      if (st.ok) {
        const { status } = (await st.json()) as { status?: string };
        if (status === "ready") return media_id;
        if (status === "failed") throw new Error(`Typefully media processing failed: ${media_id}`);
      }
      await this.sleep(POLL_DELAY_MS);
    }
    throw new Error(`Typefully media not ready after polling: ${media_id}`);
  }
}
```

- [ ] **Step 4: Refactor `TypefullySender`** to compose it. Replace the private `uploadPhotos` body so it delegates per URL (keep the method name + signature so `send()` is unchanged):
```ts
import { TypefullyMedia } from "./TypefullyMedia";
// …
  private async uploadPhotos(photos: string[]): Promise<string[]> {
    const media = new TypefullyMedia(this.apiKey, this.socialSetId, this.fetchFn, this.sleep);
    const ids: string[] = [];
    for (const url of photos) ids.push(await media.upload(url));
    return ids;
  }
```
Remove the now-unused `POLL_ATTEMPTS`/`POLL_DELAY_MS` from `TypefullySender` **only if** they are no longer referenced there (they are still used by the draft-url poll — check; if still used, leave them).

- [ ] **Step 5: Run both test files — expect PASS**
Run: `pnpm exec vitest run tests/adapters/send/typefullyMedia.test.ts tests/adapters/send/typefullySender.test.ts && pnpm exec tsc --noEmit`
Expected: both green (the #72 media tests still pass through the delegated path), tsc clean.

- [ ] **Step 6: Commit**
```bash
git add src/adapters/send/TypefullyMedia.ts src/adapters/send/TypefullySender.ts tests/adapters/send/typefullyMedia.test.ts
git commit -m "refactor(send): extract TypefullyMedia (shared presigned upload) from TypefullySender"
```

---

### Task 2: `toXArticleMarkdown` — rewrite image refs to `<typ:media>`

**Files:**
- Create: `src/domain/publish/articleMarkdown.ts`
- Test: `tests/domain/publish/articleMarkdown.test.ts`

**Interfaces:**
- Produces: `toXArticleMarkdown(koreanText: string, mediaIdByUrl: Map<string, string>): string`.

- [ ] **Step 1: Write the failing test** — `tests/domain/publish/articleMarkdown.test.ts`:
```ts
import { describe, it, expect } from "vitest";
import { toXArticleMarkdown } from "../../../src/domain/publish/articleMarkdown";

describe("toXArticleMarkdown", () => {
  it("replaces each ![](url) with a typ:media tag using the uploaded media_id", () => {
    const md = "# 제목\n\n본문\n\n![](https://pbs.twimg.com/media/a.jpg)\n\n더 본문";
    const out = toXArticleMarkdown(md, new Map([["https://pbs.twimg.com/media/a.jpg", "M1"]]));
    expect(out).toBe('# 제목\n\n본문\n\n<typ:media media_id="M1" />\n\n더 본문');
  });

  it("handles multiple images", () => {
    const md = "![](u1)\ntext\n![](u2)";
    const out = toXArticleMarkdown(md, new Map([["u1", "A"], ["u2", "B"]]));
    expect(out).toBe('<typ:media media_id="A" />\ntext\n<typ:media media_id="B" />');
  });

  it("leaves text without images unchanged", () => {
    expect(toXArticleMarkdown("# 제목\n\n본문뿐", new Map())).toBe("# 제목\n\n본문뿐");
  });

  it("leaves an image whose url is not in the map as-is (defensive)", () => {
    expect(toXArticleMarkdown("![](u1)", new Map())).toBe("![](u1)");
  });
});
```

- [ ] **Step 2: Run — expect FAIL**: `pnpm exec vitest run tests/domain/publish/articleMarkdown.test.ts`

- [ ] **Step 3: Implement** `src/domain/publish/articleMarkdown.ts`:
```ts
// src/domain/publish/articleMarkdown.ts
/**
 * Rewrite an article translation's inline images to X Article media embeds. Each `![](<url>)` whose
 * url has an uploaded media_id becomes `<typ:media media_id="<id>" />` (block-level, as X Article
 * requires); an image with no mapped id is left untouched (the caller uploads all images first).
 * Pure — the `#`-title/`##`-heading/body markdown is otherwise unchanged.
 */
export function toXArticleMarkdown(koreanText: string, mediaIdByUrl: Map<string, string>): string {
  return koreanText.replace(/!\[[^\]]*\]\(([^)]+)\)/g, (whole, url: string) => {
    const id = mediaIdByUrl.get(url);
    return id ? `<typ:media media_id="${id}" />` : whole;
  });
}
```

- [ ] **Step 4: Run — expect PASS**; **Step 5: Commit**
```bash
git add src/domain/publish/articleMarkdown.ts tests/domain/publish/articleMarkdown.test.ts
git commit -m "feat(publish): toXArticleMarkdown — rewrite image refs to typ:media embeds"
```

---

### Task 3: `xArticleMeta` — items.json article + cover lookup

**Files:**
- Create: `src/adapters/content/xArticleMeta.ts`
- Test: `tests/adapters/content/xArticleMeta.test.ts`

**Interfaces:**
- Produces: `xArticleMeta(itemsPath): (itemId) => Promise<{ isArticle: boolean; coverImageUrl?: string }>`.

- [ ] **Step 1: Write the failing test** — `tests/adapters/content/xArticleMeta.test.ts`:
```ts
import { describe, it, expect } from "vitest";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { xArticleMeta } from "../../../src/adapters/content/xArticleMeta";

async function file(threads: unknown): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "items-"));
  const p = join(dir, "items.json");
  await writeFile(p, JSON.stringify(threads));
  return p;
}

describe("xArticleMeta", () => {
  it("reports an article + its cover url", async () => {
    const p = await file([{ rootId: "1", status: "active", tweets: [{ article: { title: "T", coverImageUrl: "https://pbs.twimg.com/media/cover.jpg" } }] }]);
    expect(await xArticleMeta(p)("x:1")).toEqual({ isArticle: true, coverImageUrl: "https://pbs.twimg.com/media/cover.jpg" });
  });

  it("reports non-article for a plain tweet, unknown id, missing/corrupt file", async () => {
    const p = await file([{ rootId: "1", status: "active", tweets: [{}] }]);
    expect(await xArticleMeta(p)("x:1")).toEqual({ isArticle: false });
    expect(await xArticleMeta(p)("x:9")).toEqual({ isArticle: false });
    expect(await xArticleMeta("/no/such.json")("x:1")).toEqual({ isArticle: false });
  });
});
```

- [ ] **Step 2: Run — expect FAIL**

- [ ] **Step 3: Implement** `src/adapters/content/xArticleMeta.ts`:
```ts
// src/adapters/content/xArticleMeta.ts
import { readJsonFile } from "../../shared/store/jsonFile";

interface RawThread {
  rootId?: string;
  tweets?: { article?: { coverImageUrl?: string } }[];
}

/** Whether an item is an X Article and its cover image url, from the collected items. Never throws. */
export function xArticleMeta(itemsPath: string): (itemId: string) => Promise<{ isArticle: boolean; coverImageUrl?: string }> {
  return async (itemId: string) => {
    if (!itemId.startsWith("x:")) return { isArticle: false };
    let threads: RawThread[];
    try {
      threads = await readJsonFile<RawThread[]>(itemsPath, []);
    } catch {
      return { isArticle: false };
    }
    const thread = threads.find((t) => t.rootId === itemId.slice(2));
    const article = thread?.tweets?.map((t) => t.article).find((a) => a);
    if (!article) return { isArticle: false };
    return { isArticle: true, coverImageUrl: article.coverImageUrl };
  };
}
```

- [ ] **Step 4: Run — expect PASS**; **Step 5: Commit**
```bash
git add src/adapters/content/xArticleMeta.ts tests/adapters/content/xArticleMeta.test.ts
git commit -m "feat(send): xArticleMeta — items.json article/cover lookup"
```

---

### Task 4: `TypefullyArticleSender` — post the x_article draft

**Files:**
- Create: `src/adapters/send/TypefullyArticleSender.ts`
- Test: `tests/adapters/send/typefullyArticleSender.test.ts`

**Interfaces:**
- Produces: `class TypefullyArticleSender { constructor(apiKey, socialSetId, fetchFn?, sleep?); send(req: { content_markdown: string; cover_media_id?: string }): Promise<{ postId?: string; url?: string }> }`.

- [ ] **Step 1: Write the failing test** — `tests/adapters/send/typefullyArticleSender.test.ts`:
```ts
import { describe, it, expect } from "vitest";
import { TypefullyArticleSender } from "../../../src/adapters/send/TypefullyArticleSender";

function fakeFetch(responses: { ok: boolean; status: number; body: unknown }[]) {
  const calls: { url: string; method?: string; body: any }[] = [];
  let i = 0;
  const fn = (async (url: string, init?: any) => {
    calls.push({ url: String(url), method: init?.method, body: init?.body ? JSON.parse(init.body) : undefined });
    const r = responses[Math.min(i++, responses.length - 1)];
    return { ok: r.ok, status: r.status, json: async () => r.body, text: async () => JSON.stringify(r.body) } as Response;
  }) as unknown as typeof fetch;
  return { fn, calls };
}
const noSleep = async () => {};

describe("TypefullyArticleSender", () => {
  it("posts an x_article draft (no enabled/posts) and parses the article id from x_article_published_url", async () => {
    const { fn, calls } = fakeFetch([{ ok: true, status: 200, body: { id: 5, x_article_published_url: "https://x.com/i/article/123" } }]);
    const res = await new TypefullyArticleSender("KEY", "42", fn, noSleep).send({ content_markdown: "# T\n\nbody", cover_media_id: "C1" });
    expect(calls[0].url).toContain("/social-sets/42/drafts");
    expect(calls[0].body.platforms.x_article).toEqual({ content_markdown: "# T\n\nbody", cover_media_id: "C1" });
    expect(calls[0].body.platforms.x_article.enabled).toBeUndefined();
    expect(calls[0].body.publish_at).toBe("now");
    expect(res).toEqual({ postId: "123", url: "https://x.com/i/article/123" });
  });

  it("omits cover_media_id when not provided, and polls for the url when the create lacks it", async () => {
    const { fn, calls } = fakeFetch([
      { ok: true, status: 200, body: { id: 5 } },
      { ok: true, status: 200, body: { x_article_published_url: "https://x.com/i/article/9" } },
    ]);
    const res = await new TypefullyArticleSender("KEY", "42", fn, noSleep).send({ content_markdown: "# T" });
    expect("cover_media_id" in calls[0].body.platforms.x_article).toBe(false);
    expect(res).toEqual({ postId: "9", url: "https://x.com/i/article/9" });
  });

  it("throws on a create error", async () => {
    const { fn } = fakeFetch([{ ok: false, status: 400, body: { error: "bad" } }]);
    await expect(new TypefullyArticleSender("KEY", "42", fn, noSleep).send({ content_markdown: "# T" })).rejects.toThrow(/HTTP 400/);
  });
});
```

- [ ] **Step 2: Run — expect FAIL**

- [ ] **Step 3: Implement** `src/adapters/send/TypefullyArticleSender.ts`:
```ts
// src/adapters/send/TypefullyArticleSender.ts
const API = "https://api.typefully.com/v2";
const POLL_ATTEMPTS = 10;
const POLL_DELAY_MS = 1500;

/** The article id in `https://x.com/i/article/<id>`. */
function parseArticleId(url: string | undefined): string | undefined {
  if (!url) return undefined;
  const m = /\/article\/(\d+)/.exec(url);
  return m ? m[1] : undefined;
}

export class TypefullyArticleSender {
  constructor(
    private readonly apiKey: string,
    private readonly socialSetId: string,
    private readonly fetchFn: typeof fetch = fetch,
    private readonly sleep: (ms: number) => Promise<void> = (ms) => new Promise((r) => setTimeout(r, ms)),
  ) {}

  private headers(): Record<string, string> {
    return { Authorization: `Bearer ${this.apiKey}`, "Content-Type": "application/json" };
  }

  async send(req: { content_markdown: string; cover_media_id?: string }): Promise<{ postId?: string; url?: string }> {
    const x_article: Record<string, unknown> = { content_markdown: req.content_markdown };
    if (req.cover_media_id) x_article.cover_media_id = req.cover_media_id;
    const create = await this.fetchFn(`${API}/social-sets/${this.socialSetId}/drafts`, {
      method: "POST",
      headers: this.headers(),
      body: JSON.stringify({ platforms: { x_article }, publish_at: "now" }),
    });
    if (!create.ok) {
      const detail = await create.text().catch(() => "");
      throw new Error(`Typefully create x_article draft failed: HTTP ${create.status}${detail ? ` — ${detail}` : ""}`);
    }
    const draft = (await create.json()) as { id?: number | string; x_article_published_url?: string };
    const draftId = draft.id !== undefined ? String(draft.id) : undefined;
    if (draft.x_article_published_url) return { postId: parseArticleId(draft.x_article_published_url) ?? draftId, url: draft.x_article_published_url };

    for (let i = 0; i < POLL_ATTEMPTS && draftId; i++) {
      await this.sleep(POLL_DELAY_MS);
      const res = await this.fetchFn(`${API}/social-sets/${this.socialSetId}/drafts/${draftId}`, { headers: this.headers() });
      if (!res.ok) continue;
      const d = (await res.json()) as { x_article_published_url?: string };
      if (d.x_article_published_url) return { postId: parseArticleId(d.x_article_published_url) ?? draftId, url: d.x_article_published_url };
    }
    return { postId: draftId, url: undefined };
  }
}
```

- [ ] **Step 4: Run — expect PASS**; **Step 5: Commit**
```bash
git add src/adapters/send/TypefullyArticleSender.ts tests/adapters/send/typefullyArticleSender.test.ts
git commit -m "feat(send): TypefullyArticleSender — post an x_article draft"
```

---

### Task 5: `JsonXArticleLedger` + `SendXArticle` use-case

**Files:**
- Create: `src/adapters/store/JsonXArticleLedger.ts`, `src/app/SendXArticle.ts`
- Test: `tests/app/sendXArticle.test.ts` (covers the use-case + a light ledger round-trip)

**Interfaces:**
- Consumes: `TranslationStore`, `TypefullyMedia` (as `{ upload(url): Promise<string> }`), `TypefullyArticleSender` (as `{ send(req): Promise<{postId?,url?}> }`), `xArticleMeta`, `toXArticleMarkdown`.
- Produces: `JsonXArticleLedger { loadKeys(): Promise<Set<string>>; add(entry): Promise<void> }` (keyed by itemId); `class SendXArticle { run({ ids? }): Promise<{ sent; skipped; failed }> }`.

- [ ] **Step 1: Write the failing test** — `tests/app/sendXArticle.test.ts`:
```ts
import { describe, it, expect } from "vitest";
import { SendXArticle } from "../../src/app/SendXArticle";
import type { Translation } from "../../src/domain/translation/models";

const tr = (over: Partial<Translation> = {}): Translation =>
  ({ itemId: "x:1", source: "x", sourceText: "s", koreanText: "# 제목\n\n![](https://img/a.jpg)", status: "approved", translatedAt: "t", ...over });

function deps(over: any = {}) {
  const uploaded: string[] = [];
  const sent: any[] = [];
  const ledgerKeys = new Set<string>();
  return {
    uploaded, sent, ledgerKeys,
    d: {
      translationStore: { loadAll: async () => over.rows ?? [tr()], upsert: async () => {} },
      articleMeta: over.articleMeta ?? (async (id: string) => ({ isArticle: id === "x:1", coverImageUrl: "https://img/cover.jpg" })),
      media: { upload: async (url: string) => { uploaded.push(url); return `M_${url.split("/").pop()}`; } },
      sender: { send: async (req: any) => { sent.push(req); return { postId: "123", url: "https://x.com/i/article/123" }; } },
      ledger: { loadKeys: async () => ledgerKeys, add: async (e: any) => { ledgerKeys.add(e.itemId); } },
    },
  };
}

describe("SendXArticle", () => {
  it("uploads images, builds content_markdown with typ:media + cover, posts, and ledgers", async () => {
    const { d, uploaded, sent, ledgerKeys } = deps();
    const res = await new SendXArticle(d.translationStore as any, d.articleMeta, d.media, d.sender, d.ledger).run({});
    expect(res).toEqual({ sent: 1, skipped: 0, failed: 0 });
    expect(uploaded).toEqual(["https://img/a.jpg", "https://img/cover.jpg"]); // inline first, then cover
    expect(sent[0].content_markdown).toContain('<typ:media media_id="M_a.jpg" />');
    expect(sent[0].content_markdown).not.toContain("![](");
    expect(sent[0].cover_media_id).toBe("M_cover.jpg");
    expect(ledgerKeys.has("x:1")).toBe(true);
  });

  it("skips a non-article translation and one already in the ledger", async () => {
    const { d } = deps({ articleMeta: async () => ({ isArticle: false }) });
    expect((await new SendXArticle(d.translationStore as any, d.articleMeta, d.media, d.sender, d.ledger).run({})).sent).toBe(0);

    const p = deps(); p.ledgerKeys.add("x:1");
    const r = await new SendXArticle(p.d.translationStore as any, p.d.articleMeta, p.d.media, p.d.sender, p.d.ledger).run({});
    expect(r).toEqual({ sent: 0, skipped: 1, failed: 0 });
  });

  it("counts a media/send failure as failed and does not ledger it", async () => {
    const { d, ledgerKeys } = deps();
    d.media.upload = async () => { throw new Error("upload boom"); };
    const r = await new SendXArticle(d.translationStore as any, d.articleMeta, d.media, d.sender, d.ledger).run({});
    expect(r).toEqual({ sent: 0, skipped: 0, failed: 1 });
    expect(ledgerKeys.has("x:1")).toBe(false);
  });

  it("only approved translations are considered", async () => {
    const { d } = deps({ rows: [tr({ status: "translated" })] });
    expect((await new SendXArticle(d.translationStore as any, d.articleMeta, d.media, d.sender, d.ledger).run({})).sent).toBe(0);
  });
});
```

- [ ] **Step 2: Run — expect FAIL**

- [ ] **Step 3: Implement `JsonXArticleLedger`** `src/adapters/store/JsonXArticleLedger.ts` (mirrors `JsonChannelLedger`, keyed by itemId):
```ts
// src/adapters/store/JsonXArticleLedger.ts
import { join } from "node:path";
import { readJsonFile, writeJsonFileAtomic } from "../../shared/store/jsonFile";

export interface XArticleSentEntry {
  itemId: string;
  postId?: string;
  url?: string;
  sentAt: string;
}

export class JsonXArticleLedger {
  private readonly path: string;
  constructor(private readonly dir: string) {
    this.path = join(dir, "x-article.json");
  }
  private load(): Promise<XArticleSentEntry[]> {
    return readJsonFile<XArticleSentEntry[]>(this.path, []);
  }
  async loadKeys(): Promise<Set<string>> {
    return new Set((await this.load()).map((e) => e.itemId));
  }
  async add(entry: XArticleSentEntry): Promise<void> {
    const byId = new Map((await this.load()).map((e) => [e.itemId, e]));
    byId.set(entry.itemId, entry);
    await writeJsonFileAtomic(this.dir, this.path, [...byId.values()]);
  }
}
```

- [ ] **Step 4: Implement `SendXArticle`** `src/app/SendXArticle.ts`:
```ts
// src/app/SendXArticle.ts
import type { TranslationStore } from "../ports/TranslationStore";
import { toXArticleMarkdown } from "../domain/publish/articleMarkdown";

type ArticleMeta = (itemId: string) => Promise<{ isArticle: boolean; coverImageUrl?: string }>;
interface Media { upload(url: string): Promise<string> }
interface ArticleSender { send(req: { content_markdown: string; cover_media_id?: string }): Promise<{ postId?: string; url?: string }> }
interface Ledger { loadKeys(): Promise<Set<string>>; add(entry: { itemId: string; postId?: string; url?: string; sentAt: string }): Promise<void> }

const IMG = /!\[[^\]]*\]\(([^)]+)\)/g;

export class SendXArticle {
  constructor(
    private readonly translationStore: TranslationStore,
    private readonly articleMeta: ArticleMeta,
    private readonly media: Media,
    private readonly sender: ArticleSender,
    private readonly ledger: Ledger,
    private readonly now: () => string = () => new Date().toISOString(),
  ) {}

  async run(input: { ids?: Set<string> } = {}): Promise<{ sent: number; skipped: number; failed: number }> {
    const all = await this.translationStore.loadAll();
    const already = await this.ledger.loadKeys();
    let sent = 0, skipped = 0, failed = 0;
    for (const t of all) {
      if (t.status !== "approved") continue;
      if (input.ids && !input.ids.has(t.itemId)) continue;
      const meta = await this.articleMeta(t.itemId);
      if (!meta.isArticle) continue;
      if (already.has(t.itemId)) { skipped += 1; continue; }
      try {
        // Upload every image first (inline then cover) so a media failure throws before any live post.
        const inlineUrls = [...t.koreanText.matchAll(IMG)].map((m) => m[1]);
        const urls = [...new Set([...inlineUrls, ...(meta.coverImageUrl ? [meta.coverImageUrl] : [])])];
        const mediaIdByUrl = new Map<string, string>();
        for (const url of urls) mediaIdByUrl.set(url, await this.media.upload(url));

        const content_markdown = toXArticleMarkdown(t.koreanText, mediaIdByUrl);
        const cover_media_id = meta.coverImageUrl ? mediaIdByUrl.get(meta.coverImageUrl) : undefined;
        const res = await this.sender.send({ content_markdown, cover_media_id });
        const sentAt = this.now();
        try {
          await this.ledger.add({ itemId: t.itemId, postId: res.postId, url: res.url, sentAt });
        } catch (err) {
          console.warn(`[x-article] ⚠ ${t.itemId} POSTED but not ledgered: ${(err as Error).message} — a rerun will re-post; reconcile.`);
        }
        sent += 1;
      } catch (err) {
        console.warn(`[x-article] ${t.itemId} failed: ${(err as Error).message}`);
        failed += 1;
      }
    }
    return { sent, skipped, failed };
  }
}
```

- [ ] **Step 5: Run — expect PASS** (`pnpm exec vitest run tests/app/sendXArticle.test.ts && pnpm exec tsc --noEmit`)

- [ ] **Step 6: Commit**
```bash
git add src/adapters/store/JsonXArticleLedger.ts src/app/SendXArticle.ts tests/app/sendXArticle.test.ts
git commit -m "feat(send): SendXArticle use-case + JsonXArticleLedger (idempotent X Article delivery)"
```

---

### Task 6: `send:x-article` CLI

**Files:**
- Create: `src/cli/send-x-article.ts`
- Modify: `package.json` (script)

**Interfaces:**
- Consumes: everything above + `loadTypefullyConfig`, `paths`, `JsonTranslationStore`, `xArticleMeta`, `buildRecorder` (optional).

- [ ] **Step 1: Implement** `src/cli/send-x-article.ts` (mirror `send-channels.ts`):
```ts
import "./registerErrorHandler";
import { argValue } from "./args";
import { paths } from "../paths";
import { loadTypefullyConfig } from "../config";
import { JsonTranslationStore } from "../adapters/store/JsonTranslationStore";
import { JsonXArticleLedger } from "../adapters/store/JsonXArticleLedger";
import { TypefullyMedia } from "../adapters/send/TypefullyMedia";
import { TypefullyArticleSender } from "../adapters/send/TypefullyArticleSender";
import { xArticleMeta } from "../adapters/content/xArticleMeta";
import { SendXArticle } from "../app/SendXArticle";

const idsArg = argValue("--ids");
const ids = idsArg ? new Set(idsArg.split(",").map((s) => s.trim()).filter((s) => s.length > 0)) : undefined;

const c = loadTypefullyConfig();
const result = await new SendXArticle(
  new JsonTranslationStore(paths.translationsDir),
  xArticleMeta(paths.xItems),
  new TypefullyMedia(c.apiKey, c.socialSetId),
  new TypefullyArticleSender(c.apiKey, c.socialSetId),
  new JsonXArticleLedger(paths.publishDir),
).run({ ids });
console.log(`x-article: sent ${result.sent} · skipped ${result.skipped} (already posted) · failed ${result.failed}`);
```
> Confirm `paths.translationsDir` is the `JsonTranslationStore` dir used elsewhere (e.g. in `serve.ts`/`translate-save.ts`) and use that exact path.

- [ ] **Step 2: Add the script** to `package.json` next to `send:channels`:
```json
"send:x-article": "tsx --env-file-if-exists=.env src/cli/send-x-article.ts",
```

- [ ] **Step 3: Typecheck + full suite**
```bash
pnpm exec tsc --noEmit && pnpm test
```
Expected: clean + green.

- [ ] **Step 4: Commit**
```bash
git add src/cli/send-x-article.ts package.json
git commit -m "feat(send): send:x-article CLI"
```

---

## Self-review

- Spec coverage: shared upload (Task 1), markdown rewrite (Task 2), article/cover lookup (Task 3), x_article sender (Task 4), ledger + use-case (Task 5), CLI (Task 6). ✅
- Placeholder scan: none — concrete code; tests use placeholder urls/keys/ids.
- Type consistency: `articleMeta`/`media.upload`/`sender.send`/`ledger` signatures match across `SendXArticle`, its test, and the CLI wiring; `x_article` payload has no `enabled`/`posts`; url field is `x_article_published_url`.
- Global constraints honored: articles-only; upload-before-post idempotency; #72 behavior preserved (Task 1 delegation); no new deps; Telegram path untouched.

## Operational follow-up (manual, after merge — not a task)

`pnpm send:x-article --ids <article-id>` against a **test** X Premium account; verify the article posts with title/headings/inline image/cover. Live publish is final.
