# t.co URL Expansion Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** At collection, replace each `t.co` shortlink in a tweet's text with its real `expanded_url`, and strip any remaining `t.co` (the tweet's own photo/video attachments), so translation and delivery see real URLs instead of opaque shortlinks and media self-links.

**Architecture:** A pure `expandUrls(text, urls)` helper in the twitterapi adapter, called by `normalizeTweet` when it maps a raw tweet to a domain `SourceTweet`. The raw `entities.urls[].expanded_url` (already returned by twitterapi.io) is captured via a new schema field; media stays on `SourceTweet.media` unchanged. No network call.

**Tech Stack:** ESM TypeScript, `zod` (schema), `vitest`, `tsx`, `zod`-only runtime dep.

## Global Constraints

- Runtime deps stay **zod-only**; no new dependency; no network call (the API already returns `expanded_url`).
- Normalization **never throws** on a live tweet: the `entities.urls` entity fields are optional, and `expandUrls` skips any entity missing `url` or `expanded_url`.
- Only `SourceTweet.text` changes; `media`, `article`, `metrics`, and every other field are untouched. Media attachments remain on `SourceTweet.media` (parsed from `extendedEntities.media`).
- String replacement, not `indices`-based — `t.co` tokens are unique, avoiding code-unit/code-point ambiguity in emoji-heavy tweets.
- `expanded_url` is used **as returned** (may be `http://`); no `http`→`https` rewrite.
- X-self-referential expanded URLs (an Article's `x.com/i/article/…`, a quote-tweet link) are **kept, expanded** — no host-based special-casing.
- Public repo: tests use synthetic tweets only; no real tokens or PII.
- Every test must be able to fail: pin the exact resulting string, never an assertion a mutation would still satisfy.

---

## File Structure

- **Create** `src/adapters/twitterapi/expandUrls.ts` — the pure helper.
- **Modify** `src/adapters/twitterapi/schemas.ts` — add `entities.urls` to `TweetRaw`; call `expandUrls` in `normalizeTweet`.
- **Test:** create `tests/adapters/twitterapi/expandUrls.test.ts`; extend `tests/adapters/schemas.test.ts` (integration through `normalizeTweet`).
- **Docs:** `CHANGELOG.md` ([Unreleased] → Fixed); a one-line note in `translation/style-guide.md` §11.

---

## Task 1: `expandUrls` pure helper

**Files:**
- Create: `src/adapters/twitterapi/expandUrls.ts`
- Test: `tests/adapters/twitterapi/expandUrls.test.ts`

**Interfaces:**
- Produces: `interface UrlEntity { url?: string; expanded_url?: string }` and `expandUrls(text: string, urls?: UrlEntity[]): string`.

- [ ] **Step 1: Write the failing tests** (`tests/adapters/twitterapi/expandUrls.test.ts`)

```ts
import { describe, it, expect } from "vitest";
import { expandUrls } from "../../../src/adapters/twitterapi/expandUrls";

describe("expandUrls", () => {
  it("replaces a t.co with its expanded_url", () => {
    expect(
      expandUrls("Trade here: https://t.co/abc", [{ url: "https://t.co/abc", expanded_url: "http://fluxion.network/trade" }]),
    ).toBe("Trade here: http://fluxion.network/trade");
  });

  it("strips a media t.co (no matching entity) with its attached whitespace", () => {
    expect(expandUrls("business as usual. https://t.co/vid", [])).toBe("business as usual.");
  });

  it("expands the real link and strips the media link in one text", () => {
    expect(
      expandUrls("See https://t.co/real and photo https://t.co/media", [
        { url: "https://t.co/real", expanded_url: "http://site.com/x" },
      ]),
    ).toBe("See http://site.com/x and photo");
  });

  it("keeps an X-self expanded_url (article/quote)", () => {
    expect(
      expandUrls("https://t.co/art", [{ url: "https://t.co/art", expanded_url: "http://x.com/i/article/1" }]),
    ).toBe("http://x.com/i/article/1");
  });

  it("skips an entity missing expanded_url, so its t.co is stripped as media", () => {
    expect(expandUrls("x https://t.co/bad", [{ url: "https://t.co/bad" }])).toBe("x");
  });

  it("expands multiple real links", () => {
    expect(
      expandUrls("a https://t.co/1 b https://t.co/2", [
        { url: "https://t.co/1", expanded_url: "http://one.com" },
        { url: "https://t.co/2", expanded_url: "http://two.com" },
      ]),
    ).toBe("a http://one.com b http://two.com");
  });

  it("returns text unchanged with no urls and no t.co", () => {
    expect(expandUrls("plain text", undefined)).toBe("plain text");
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm exec vitest run tests/adapters/twitterapi/expandUrls.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement** `src/adapters/twitterapi/expandUrls.ts`

```ts
export interface UrlEntity {
  url?: string;
  expanded_url?: string;
}

/**
 * Turn a tweet's raw `text` into readable links:
 *  1. replace each `t.co` shortlink with its real `expanded_url` (from entities.urls), and
 *  2. strip any `t.co` still present — those are the tweet's own photo/video attachments, which
 *     Twitter encodes into the text but are not links (they are carried on SourceTweet.media).
 * String replacement (t.co tokens are unique) avoids the indices field's code-unit ambiguity.
 * See docs/superpowers/specs/2026-07-28-tco-url-expansion-design.md.
 */
export function expandUrls(text: string, urls?: UrlEntity[]): string {
  let out = text;
  for (const u of urls ?? []) {
    if (u.url && u.expanded_url) out = out.split(u.url).join(u.expanded_url);
  }
  // Whatever t.co remains was not in entities.urls: a media attachment. Remove it with the
  // whitespace that attached it.
  out = out.replace(/\s*https?:\/\/t\.co\/\w+/g, "");
  return out.trim();
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm exec vitest run tests/adapters/twitterapi/expandUrls.test.ts`
Expected: PASS (7/7).

- [ ] **Step 5: Commit**

```bash
git add src/adapters/twitterapi/expandUrls.ts tests/adapters/twitterapi/expandUrls.test.ts
git commit -m "feat(collect): expandUrls — expand t.co to real URLs, strip media links"
```

---

## Task 2: Wire into `normalizeTweet` (schema + integration) + docs

**Files:**
- Modify: `src/adapters/twitterapi/schemas.ts`
- Test: `tests/adapters/schemas.test.ts`
- Docs: `CHANGELOG.md`, `translation/style-guide.md`

**Interfaces:**
- Consumes: `expandUrls`/`UrlEntity` from `./expandUrls` (Task 1).

- [ ] **Step 1: Write the failing integration test** — add to `tests/adapters/schemas.test.ts` inside the existing `describe("normalizeTweet", …)`

```ts
it("expands t.co links via entities.urls and strips media t.co, keeping media on SourceTweet", () => {
  const t = normalizeTweet({
    id: "1",
    url: "u",
    createdAt: "Mon Jun 29 05:58:17 +0000 2026",
    author: { userName: "Mantle_Official" },
    text: "Trade here: https://t.co/real\n\nclip https://t.co/media",
    entities: { urls: [{ url: "https://t.co/real", expanded_url: "http://fluxion.network/trade" }] },
    extendedEntities: { media: [{ type: "video", media_url_https: "https://pbs.twimg.com/v.mp4" }] },
  });
  expect(t.text).toBe("Trade here: http://fluxion.network/trade\n\nclip");
  expect(t.text).not.toContain("t.co");
  expect(t.media).toEqual([{ type: "video", url: "https://pbs.twimg.com/v.mp4" }]);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm exec vitest run tests/adapters/schemas.test.ts -t "expands t.co"`
Expected: FAIL — `t.text` still contains `t.co` (entities.urls not yet read).

- [ ] **Step 3: Implement** in `src/adapters/twitterapi/schemas.ts`

Add the import at the top (with the other imports):

```ts
import { expandUrls } from "./expandUrls";
```

Add an `entities` field to `TweetRaw` (place it next to `extendedEntities`):

```ts
    entities: z
      .object({
        urls: z
          .array(z.object({ url: z.string().optional(), expanded_url: z.string().optional() }).passthrough())
          .optional(),
      })
      .passthrough()
      .optional(),
```

Change the `text` line in `normalizeTweet`'s returned object from `text: t.text,` to:

```ts
    text: expandUrls(t.text, t.entities?.urls),
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm exec vitest run tests/adapters/schemas.test.ts`
Expected: PASS — the new case plus every existing `normalizeTweet`/`parseTweetList`/`parseArticleContents` case (the added field is optional; a tweet without `entities` still normalizes, its text unchanged aside from media-`t.co` stripping, of which the existing fixtures have none).

- [ ] **Step 5: Typecheck**

Run: `pnpm exec tsc --noEmit`
Expected: clean.

- [ ] **Step 6: Docs**

- `CHANGELOG.md` `[Unreleased] → Fixed`: add a bullet — collection now expands `t.co` shortlinks to their real `expanded_url` (from `entities.urls`) and removes a tweet's own photo/video `t.co` self-links (the media stays on `SourceTweet.media`), so translations and Telegram/X delivery carry real URLs instead of `t.co`. Reference `docs/superpowers/specs/2026-07-28-tco-url-expansion-design.md`.
- `translation/style-guide.md` §11 (파이프라인 규칙), the 링크 bullet: append one sentence that links now arrive already expanded (t.co resolved at collection; media self-links removed), so the translator keeps the real URL as-is. Do not change the existing "URL 그대로 유지" rule — the URLs are simply real now. Read the file and match its tone; do not leave a neighbouring sentence stale.

- [ ] **Step 7: Full suite + commit**

```bash
pnpm test
git add src/adapters/twitterapi/schemas.ts tests/adapters/schemas.test.ts CHANGELOG.md translation/style-guide.md
git commit -m "fix(collect): normalizeTweet expands t.co and drops media self-links"
```

Expected: full suite green.

> Post-merge (manual, not a task): re-collect a recent Mantle_Official window (`pnpm collect Mantle_Official --since <date>`) and confirm a stored tweet's `text` shows the expanded URL (e.g. `fluxion.network/trade`) with no `.../photo|video` `t.co` remaining.

---

## Self-Review

**1. Spec coverage:** Decision 1 (normalize at `normalizeTweet`) → Task 2 Step 3. Decision 2 (expand real, strip media, keep X-self) → Task 1 `expandUrls` + its tests (X-self and media cases). Decision 3 (pure helper, string replace, `http` as-is) → Task 1 implementation + the `http://…` assertions. Schema capture of `entities.urls` → Task 2 Step 3. Docs (CHANGELOG + §11) → Task 2 Step 6. Testing section → Task 1 (7 cases) + Task 2 (integration). Every spec decision maps to a step.

**2. Placeholder scan:** No TBD/TODO; every code and test step is complete.

**3. Type consistency:** `expandUrls(text: string, urls?: UrlEntity[]): string` defined in Task 1, called in Task 2 Step 3 as `expandUrls(t.text, t.entities?.urls)`; `t.entities?.urls` (from the new schema field, `{ url?: string; expanded_url?: string }[]`) is assignable to `UrlEntity[]`. The schema entity shape (optional `url`/`expanded_url`) matches `UrlEntity`. `SourceTweet.text` is the only changed field; `media` continues to come from the unchanged `toMedia`/`extendedEntities` path.
