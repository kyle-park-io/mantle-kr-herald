# Photo Media Attachment Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Attach a post's photos to what `send:channels` delivers — as X media via Typefully's presigned-upload flow, and as Telegram `sendPhoto`/`sendMediaGroup` — deriving the media at send time from `items.json`.

**Architecture:** Media is looked up at send time by `itemId` (no `Translation`/`ChannelRendering` model change). `SendRequest` gains `photos?: string[]`; `SendChannels` gets an injected `photosFor` lookup; the two senders learn to attach photos; the CLI wires an `items.json`-backed lookup.

**Tech Stack:** TypeScript (ESM, hexagonal ports/adapters), vitest, native fetch. No new runtime deps.

## Global Constraints

- **Photos only.** Video (needs `video_info.variants` capture) and article inline images are out of scope.
- **Media derived at send time** — do NOT add media to `Translation`, `ContentItem`, or `ChannelRendering`.
- **Backward-compatible:** with no photos, every payload is byte-identical to today's.
- Repo is PUBLIC — tests use placeholder URLs/keys/ids only, never real media or tokens.
- Live sends are final — NO live network in tests (fake `fetch`).
- Ends green: `pnpm test` and `pnpm exec tsc --noEmit`.

---

### Task 1: `SendRequest.photos` + `SendChannels` looks up + passes photos

**Files:**
- Modify: `src/ports/ChannelSender.ts` (`SendRequest.photos`)
- Modify: `src/app/SendChannels.ts` (optional `photosFor` dep; look up + pass)
- Test: `tests/app/sendChannels.test.ts` (extend)

**Interfaces:**
- Produces: `SendRequest.photos?: string[]`; `SendChannels` ctor's new last param `photosFor?: (itemId: string) => Promise<string[]>`.

- [ ] **Step 1: Add the field + dep.** In `src/ports/ChannelSender.ts`, add to `SendRequest`:
```ts
  /** Photo URLs to attach to the lead post (undefined/empty = text only). */
  photos?: string[];
```
In `src/app/SendChannels.ts`, add a constructor param **after** `now` (keeps existing positional callers working):
```ts
    private readonly now: () => string = () => new Date().toISOString(),
    private readonly photosFor?: (itemId: string) => Promise<string[]>,
```
In `run`, just before the `try` that calls `sender.send`, resolve the photos and pass them:
```ts
        const photos = this.photosFor ? await this.photosFor(r.itemId) : [];
        const segments = emitResult.segments.map((s) => s.text);
        const res = await sender.send({ itemId: r.itemId, type: r.type, channel: r.channel, segments, photos });
```
(The existing `const segments = …` line moves up into this block; everything else in `run` is unchanged.)

- [ ] **Step 2: Write the failing test** — append to `tests/app/sendChannels.test.ts` a case that a `photosFor` is consulted and its result reaches the sender. Use the file's existing helpers/fakes; capture the `SendRequest` the fake sender received:
```ts
  it("passes photosFor(itemId) through to the sender", async () => {
    const got: string[][] = [];
    const sender = { name: "x", send: async (req: any) => { got.push(req.photos); return { postId: "1" }; } };
    const deps = makeDeps({
      rows: [rendering({ itemId: "x:1", type: "x", channel: "x", status: "approved" })],
      senders: { telegram: undefined, x: sender as any },
    });
    await new SendChannels(deps.store, deps.senders, deps.ledger, undefined, undefined, undefined,
      async (id: string) => (id === "x:1" ? ["https://pbs.twimg.com/media/a.jpg"] : []),
    ).run({ targets: ["x"] });
    expect(got[0]).toEqual(["https://pbs.twimg.com/media/a.jpg"]);
  });
```
> Adapt `makeDeps`/`rendering` to the helpers actually present in `sendChannels.test.ts`; the assertion is what matters. If the file has no such helper, construct `SendChannels` with minimal inline fakes (an approved `x` rendering in the store, a recording sender, a no-op ledger).

- [ ] **Step 3: Run — expect PASS** (fix helper wiring until green): `pnpm exec vitest run tests/app/sendChannels.test.ts`

- [ ] **Step 4: Confirm no-photos path unchanged.** Verify an existing send test (no `photosFor`) still passes: the sender receives `photos: []`, and senders ignore an empty array (Tasks 3/4).

- [ ] **Step 5: Typecheck + commit**
```bash
pnpm exec tsc --noEmit
git add src/ports/ChannelSender.ts src/app/SendChannels.ts tests/app/sendChannels.test.ts
git commit -m "feat(send): SendRequest.photos + SendChannels looks up media per item"
```

---

### Task 2: `xPhotos` — items.json photo lookup adapter

**Files:**
- Create: `src/adapters/content/xMediaLookup.ts`
- Test: `tests/adapters/content/xMediaLookup.test.ts`

**Interfaces:**
- Consumes: `output/x/items.json` shape (`CollectedThread[]` = `{ rootId, status, tweets: [{ media?: {type,url}[] }] }`), same as `XContentSource`.
- Produces: `xPhotos(itemsPath: string): (itemId: string) => Promise<string[]>`.

- [ ] **Step 1: Write the failing test** — `tests/adapters/content/xMediaLookup.test.ts`:
```ts
import { describe, it, expect } from "vitest";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { xPhotos } from "../../../src/adapters/content/xMediaLookup";

async function itemsFile(threads: unknown): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "items-"));
  const path = join(dir, "items.json");
  await writeFile(path, JSON.stringify(threads));
  return path;
}

describe("xPhotos", () => {
  it("returns a post's photo urls (type photo only), order preserved", async () => {
    const path = await itemsFile([
      { rootId: "1", status: "active", tweets: [{ media: [
        { type: "photo", url: "https://pbs.twimg.com/media/a.jpg" },
        { type: "video", url: "https://pbs.twimg.com/amplify_video_thumb/b.jpg" },
      ] }] },
    ]);
    expect(await xPhotos(path)("x:1")).toEqual(["https://pbs.twimg.com/media/a.jpg"]);
  });

  it("concatenates photos across a thread's tweets", async () => {
    const path = await itemsFile([
      { rootId: "1", status: "active", tweets: [
        { media: [{ type: "photo", url: "https://pbs.twimg.com/media/a.jpg" }] },
        { media: [{ type: "photo", url: "https://pbs.twimg.com/media/b.jpg" }] },
      ] },
    ]);
    expect(await xPhotos(path)("x:1")).toEqual(["https://pbs.twimg.com/media/a.jpg", "https://pbs.twimg.com/media/b.jpg"]);
  });

  it("returns [] for a text-only or unknown item, and for a bad path", async () => {
    const path = await itemsFile([{ rootId: "1", status: "active", tweets: [{}] }]);
    expect(await xPhotos(path)("x:1")).toEqual([]);
    expect(await xPhotos(path)("x:9")).toEqual([]);
    expect(await xPhotos("/no/such/file.json")("x:1")).toEqual([]);
  });
});
```

- [ ] **Step 2: Run — expect FAIL** (module missing): `pnpm exec vitest run tests/adapters/content/xMediaLookup.test.ts`

- [ ] **Step 3: Implement** `src/adapters/content/xMediaLookup.ts`:
```ts
// src/adapters/content/xMediaLookup.ts
import { readJsonFile } from "../../shared/store/jsonFile";

interface RawMedia {
  type?: string;
  url?: string;
}
interface RawThread {
  rootId?: string;
  status?: string;
  tweets?: { media?: RawMedia[] }[];
}

/**
 * A send-time photo lookup backed by the collected X items. Returns every photo url a post carries
 * (article images live in the article body, not `media`, so an article yields []). Never throws:
 * a missing file / unknown id / text-only item all return []. Photos only — videos are excluded.
 */
export function xPhotos(itemsPath: string): (itemId: string) => Promise<string[]> {
  return async (itemId: string): Promise<string[]> => {
    if (!itemId.startsWith("x:")) return [];
    const rootId = itemId.slice(2);
    const threads = await readJsonFile<RawThread[]>(itemsPath, []);
    const thread = threads.find((t) => t.rootId === rootId);
    if (!thread?.tweets) return [];
    return thread.tweets
      .flatMap((t) => t.media ?? [])
      .filter((m) => m.type === "photo" && typeof m.url === "string")
      .map((m) => m.url as string);
  };
}
```

- [ ] **Step 4: Run — expect PASS**: `pnpm exec vitest run tests/adapters/content/xMediaLookup.test.ts`

- [ ] **Step 5: Commit**
```bash
git add src/adapters/content/xMediaLookup.ts tests/adapters/content/xMediaLookup.test.ts
git commit -m "feat(send): xPhotos — items.json photo lookup for send-time media"
```

---

### Task 3: `TypefullySender` — upload photos and attach media_ids

**Files:**
- Modify: `src/adapters/send/TypefullySender.ts`
- Test: `tests/adapters/send/typefullySender.test.ts` (extend)

**Interfaces:**
- Consumes: `SendRequest.photos` (Task 1).
- Typefully v2: `POST /v2/social-sets/{id}/media/upload {file_name}` → `{ media_id, upload_url }`; `PUT upload_url` (bytes); `GET /v2/social-sets/{id}/media/{media_id}` → `{ status }`; draft `posts:[{ text, media_ids }]`.

- [ ] **Step 1: Write the failing tests** — append to `tests/adapters/send/typefullySender.test.ts`. Use a **URL-routing** fake (the file's existing `fakeFetch` JSON-parses the body and cannot handle the binary PUT):
```ts
function routingFetch() {
  const calls: { url: string; method: string; jsonBody?: any; isBinary?: boolean }[] = [];
  const fn = (async (url: string, init?: any) => {
    const u = String(url);
    const method = init?.method ?? "GET";
    const isBinary = init?.body instanceof ArrayBuffer || ArrayBuffer.isView(init?.body);
    calls.push({ url: u, method, isBinary, jsonBody: !isBinary && init?.body ? JSON.parse(init.body) : undefined });
    const reply = (body: unknown, ct = "application/json") =>
      ({ ok: true, status: 200, json: async () => body, text: async () => JSON.stringify(body),
         arrayBuffer: async () => new ArrayBuffer(4), headers: { get: () => ct } }) as unknown as Response;
    if (u.includes("pbs.twimg.com")) return reply({}, "image/jpeg");          // photo download
    if (u.endsWith("/media/upload")) return reply({ media_id: "M1", upload_url: "https://s3.example/put" });
    if (u === "https://s3.example/put") return reply({});                     // S3 PUT
    if (u.includes("/media/M1")) return reply({ status: "ready" });           // poll
    return reply({ id: 77, x_published_url: "https://x.com/i/status/1" });    // draft
  }) as unknown as typeof fetch;
  return { fn, calls };
}
const noSleep = async () => {};

describe("TypefullySender media", () => {
  it("uploads each photo and attaches media_ids to the lead post", async () => {
    const { fn, calls } = routingFetch();
    const res = await new TypefullySender("KEY", "42", fn, noSleep).send({
      itemId: "x:1", type: "x", channel: "x", segments: ["hello", "second"],
      photos: ["https://pbs.twimg.com/media/a.jpg"],
    });
    // download → upload → PUT(binary) → poll → draft
    expect(calls.map((c) => `${c.method} ${c.url.includes("pbs") ? "download" : c.url.includes("/media/upload") ? "upload" : c.url.includes("s3") ? "put" : c.url.includes("/media/M1") ? "poll" : "draft"}`))
      .toEqual(["GET download", "POST upload", "PUT put", "GET poll", "POST draft"]);
    const draft = calls.find((c) => c.url.includes("/drafts"))!.jsonBody;
    expect(draft.platforms.x.posts[0]).toEqual({ text: "hello", media_ids: ["M1"] });
    expect(draft.platforms.x.posts[1]).toEqual({ text: "second" });
    expect(calls.find((c) => c.url === "https://s3.example/put")!.isBinary).toBe(true);
    expect(res).toEqual({ postId: "1", url: "https://x.com/i/status/1" });
  });

  it("throws before creating a draft when a media step fails", async () => {
    const fn = (async (url: string, init?: any) => {
      const u = String(url);
      if (u.endsWith("/media/upload")) return { ok: false, status: 500, text: async () => "boom" } as Response;
      if (u.includes("pbs.twimg.com")) return { ok: true, status: 200, arrayBuffer: async () => new ArrayBuffer(4), headers: { get: () => "image/jpeg" } } as unknown as Response;
      throw new Error(`unexpected call to ${u}`); // a draft POST here fails the test
    }) as unknown as typeof fetch;
    await expect(
      new TypefullySender("KEY", "42", fn, noSleep).send({ itemId: "x:1", type: "x", channel: "x", segments: ["a"], photos: ["https://pbs.twimg.com/media/a.jpg"] }),
    ).rejects.toThrow(/media/i);
  });

  it("sends no media_ids when there are no photos (payload unchanged)", async () => {
    const { fn, calls } = routingFetch();
    await new TypefullySender("KEY", "42", fn, noSleep).send({ itemId: "x:1", type: "x", channel: "x", segments: ["a"] });
    expect(calls).toHaveLength(1); // only the draft POST
    expect(calls[0].jsonBody.platforms.x.posts).toEqual([{ text: "a" }]);
  });
});
```

- [ ] **Step 2: Run — expect FAIL**: `pnpm exec vitest run tests/adapters/send/typefullySender.test.ts -t "media"`

- [ ] **Step 3: Implement.** In `src/adapters/send/TypefullySender.ts`, add the upload method and use media in `send()`:

Add the private method (uses the existing `API`, `POLL_ATTEMPTS`, `POLL_DELAY_MS`, `this.headers()`, `this.sleep`):
```ts
  private async uploadPhotos(photos: string[]): Promise<string[]> {
    const ids: string[] = [];
    for (const url of photos) {
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

      let ready = false;
      for (let i = 0; i < POLL_ATTEMPTS; i++) {
        const st = await this.fetchFn(`${API}/social-sets/${this.socialSetId}/media/${media_id}`, { headers: this.headers() });
        if (st.ok) {
          const { status } = (await st.json()) as { status?: string };
          if (status === "ready") { ready = true; break; }
          if (status === "failed") throw new Error(`Typefully media processing failed: ${media_id}`);
        }
        await this.sleep(POLL_DELAY_MS);
      }
      if (!ready) throw new Error(`Typefully media not ready after polling: ${media_id}`);
      ids.push(media_id);
    }
    return ids;
  }
```

In `send()`, upload photos FIRST, then build the posts with media on the lead post:
```ts
  async send(req: SendRequest): Promise<SendResult> {
    const mediaIds = req.photos?.length ? await this.uploadPhotos(req.photos) : [];
    const posts = req.segments.map((text, i) =>
      i === 0 && mediaIds.length ? { text, media_ids: mediaIds } : { text },
    );
    const create = await this.fetchFn(`${API}/social-sets/${this.socialSetId}/drafts`, {
      method: "POST",
      headers: this.headers(),
      body: JSON.stringify({ platforms: { x: { enabled: true, posts } }, publish_at: "now" }),
    });
    // …unchanged from here (the ok-check, draft parse, poll-for-url, return)…
  }
```

- [ ] **Step 4: Run — expect PASS** (media tests + the pre-existing ones): `pnpm exec vitest run tests/adapters/send/typefullySender.test.ts`

- [ ] **Step 5: Commit**
```bash
git add src/adapters/send/TypefullySender.ts tests/adapters/send/typefullySender.test.ts
git commit -m "feat(send): TypefullySender uploads photos and attaches media_ids to the lead post"
```

---

### Task 4: `TelegramBotSender` — attach photos

**Files:**
- Modify: `src/adapters/send/TelegramBotSender.ts`
- Test: `tests/adapters/send/telegramBotSender.test.ts` (extend)

**Interfaces:**
- Consumes: `SendRequest.photos` (Task 1). Telegram accepts a photo URL directly.

- [ ] **Step 1: Write the failing tests** — append to `tests/adapters/send/telegramBotSender.test.ts` (follow the file's existing fake-fetch style; `sendMediaGroup`/`sendPhoto` return `{ result: {...} }`, a group returns `{ result: [{message_id}] }`):
```ts
describe("TelegramBotSender media", () => {
  it("one photo + short text → sendPhoto with the text as caption, no separate sendMessage", async () => {
    const calls: { url: string; body: any }[] = [];
    const fn = (async (url: string, init?: any) => { calls.push({ url: String(url), body: JSON.parse(init.body) });
      return { ok: true, status: 200, json: async () => ({ result: { message_id: 5 } }), text: async () => "" } as Response; }) as unknown as typeof fetch;
    await new TelegramBotSender("T", "-100999", fn).send({ itemId: "x:1", type: "announcement", channel: "telegram", segments: ["짧은 공지"], photos: ["https://pbs.twimg.com/media/a.jpg"] });
    expect(calls).toHaveLength(1);
    expect(calls[0].url).toContain("/sendPhoto");
    expect(calls[0].body).toMatchObject({ photo: "https://pbs.twimg.com/media/a.jpg", caption: "짧은 공지" });
  });

  it("two photos → sendMediaGroup, then the text as a reply message", async () => {
    const calls: { url: string; body: any }[] = [];
    const fn = (async (url: string, init?: any) => { const u = String(url); calls.push({ url: u, body: JSON.parse(init.body) });
      const result = u.includes("sendMediaGroup") ? [{ message_id: 5 }] : { message_id: 6 };
      return { ok: true, status: 200, json: async () => ({ result }), text: async () => "" } as Response; }) as unknown as typeof fetch;
    await new TelegramBotSender("T", "-100999", fn).send({ itemId: "x:1", type: "x", channel: "telegram", segments: ["본문"], photos: ["https://pbs.twimg.com/media/a.jpg", "https://pbs.twimg.com/media/b.jpg"] });
    expect(calls[0].url).toContain("/sendMediaGroup");
    expect(calls[0].body.media).toHaveLength(2);
    expect(calls[0].body.media[0]).toMatchObject({ type: "photo", media: "https://pbs.twimg.com/media/a.jpg" });
    expect(calls[1].url).toContain("/sendMessage");
    expect(calls[1].body).toMatchObject({ text: "본문", reply_to_message_id: 5 });
  });

  it("no photos → sendMessage only (unchanged)", async () => {
    const calls: string[] = [];
    const fn = (async (url: string) => { calls.push(String(url)); return { ok: true, status: 200, json: async () => ({ result: { message_id: 1 } }), text: async () => "" } as Response; }) as unknown as typeof fetch;
    await new TelegramBotSender("T", "-100999", fn).send({ itemId: "x:1", type: "x", channel: "telegram", segments: ["a", "b"] });
    expect(calls.every((u) => u.includes("/sendMessage"))).toBe(true);
    expect(calls).toHaveLength(2);
  });
});
```

- [ ] **Step 2: Run — expect FAIL**: `pnpm exec vitest run tests/adapters/send/telegramBotSender.test.ts -t "media"`

- [ ] **Step 3: Implement.** In `src/adapters/send/TelegramBotSender.ts`, add a `post` helper (or reuse the existing fetch pattern) and a photo branch. Full replacement of `send`:
```ts
  private async post(method: string, body: Record<string, unknown>): Promise<any> {
    const res = await this.fetchFn(`${API}/bot${this.token}/${method}`, {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body),
    });
    if (!res.ok) {
      const detail = await res.text().catch(() => "");
      throw new Error(`Telegram ${method} failed: HTTP ${res.status}${detail ? ` — ${detail}` : ""}`);
    }
    return ((await res.json()) as { result?: unknown }).result;
  }

  async send(req: SendRequest): Promise<SendResult> {
    const photos = (req.photos ?? []).slice(0, 10); // Telegram media-group cap
    let firstId: number | undefined;
    let textSegments = req.segments;

    if (photos.length > 0) {
      // Use the whole text as the media caption only when it is a single ≤1024-char segment.
      const asCaption = req.segments.length === 1 && (req.segments[0]?.length ?? 0) <= 1024 ? req.segments[0] : undefined;
      if (photos.length === 1) {
        const r = await this.post("sendPhoto", { chat_id: this.chatId, photo: photos[0], ...(asCaption ? { caption: asCaption, parse_mode: "HTML" } : {}) });
        firstId = (r as { message_id?: number })?.message_id;
      } else {
        const media = photos.map((url, i) => ({ type: "photo", media: url, ...(i === 0 && asCaption ? { caption: asCaption, parse_mode: "HTML" } : {}) }));
        const r = await this.post("sendMediaGroup", { chat_id: this.chatId, media });
        firstId = (r as { message_id?: number }[])?.[0]?.message_id;
      }
      if (asCaption) textSegments = []; // already delivered as the caption
    }

    for (const text of textSegments) {
      const body: Record<string, unknown> = { chat_id: this.chatId, text, parse_mode: "HTML" };
      if (firstId !== undefined) body.reply_to_message_id = firstId;
      const r = await this.post("sendMessage", body);
      const id = (r as { message_id?: number })?.message_id;
      if (firstId === undefined && typeof id === "number") firstId = id;
    }

    const url = firstId !== undefined && this.chatId.startsWith("-100")
      ? `https://t.me/c/${this.chatId.slice(4)}/${firstId}` : undefined;
    return { postId: firstId !== undefined ? String(firstId) : undefined, url };
  }
```
(Keep the existing `API` const and imports.)

- [ ] **Step 4: Run — expect PASS** (media + pre-existing tests): `pnpm exec vitest run tests/adapters/send/telegramBotSender.test.ts`

- [ ] **Step 5: Commit**
```bash
git add src/adapters/send/TelegramBotSender.ts tests/adapters/send/telegramBotSender.test.ts
git commit -m "feat(send): TelegramBotSender attaches photos (sendPhoto/sendMediaGroup)"
```

---

### Task 5: wire `photosFor` into `send:channels`

**Files:**
- Modify: `src/cli/send-channels.ts`

**Interfaces:**
- Consumes: `xPhotos` (Task 2), `SendChannels`'s `photosFor` param (Task 1).

- [ ] **Step 1: Wire it.** In `src/cli/send-channels.ts`, import `xPhotos` and `paths`, and pass the lookup as `SendChannels`'s 7th arg (the 6th, `now`, stays default via `undefined`):
```ts
import { xPhotos } from "../adapters/content/xMediaLookup";
import { paths } from "../paths";
// …
const result = await new SendChannels(store, senders, ledger, record, archive, undefined, xPhotos(paths.xItems)).run({ targets, ids });
```
(If `paths` is already imported, don't re-import.)

- [ ] **Step 2: Typecheck + full suite**
```bash
pnpm exec tsc --noEmit && pnpm test
```
Expected: clean + green.

- [ ] **Step 3: Commit**
```bash
git add src/cli/send-channels.ts
git commit -m "feat(send): wire items.json photo lookup into send:channels"
```

---

## Self-review

- Spec coverage: media lookup (Task 2), `SendRequest.photos`+`SendChannels` (Task 1), Typefully upload (Task 3), Telegram photos (Task 4), CLI wiring (Task 5). ✅
- Placeholder scan: none — all code concrete; tests use placeholder urls (`pbs.twimg.com/media/a.jpg`), keys (`KEY`/`T`), ids (`M1`).
- Type consistency: `photosFor: (itemId: string) => Promise<string[]>` matches `xPhotos`'s return; `SendRequest.photos?: string[]` consumed by both senders and produced by `SendChannels`.
- Global constraints honored: photos-only; no `Translation`/`Rendering` change; no-photos path byte-identical; no new deps; no live network in tests.

## Operational follow-up (manual, after merge — not a task)

`send:channels` a photo post to a **test** account/chat (`--target x` / `telegram`, `--ids <id>`) and confirm the media lands on the live post. Live send is final.
