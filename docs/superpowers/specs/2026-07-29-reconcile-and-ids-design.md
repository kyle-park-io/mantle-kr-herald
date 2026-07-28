# Post-send follow-ups: published-url reconcile + lenient `--ids` — Design

**Date:** 2026-07-29
**Branch:** `fix/reconcile-and-ids` (off `main`)
**Status:** approved for planning

Two small follow-ups surfaced by the live E2E send (PR #76 scheduled-publish). Implemented directly
(the session's subagent budget is exhausted), TDD + self-review.

## #2 — `send:x-article --ids` accepts a bare id

**Problem:** `pnpm send:x-article --ids 2072340833760936293` silently did nothing (`sent 0`) because the
translation itemId is `x:2072340833760936293` and the filter is `ids.has(t.itemId)`. The `x:` prefix is
easy to forget.

**Fix:** match an `--ids` entry against the itemId **or its source-stripped suffix**. Shared pure
helper `matchesItemId(ids: Set<string>, itemId: string): boolean` = `ids.has(itemId) || ids.has(itemId.slice(itemId.indexOf(":") + 1))`
(`src/domain/itemId.ts`). Use it in `SendXArticle` (and `SendChannels`, same latent issue) in place of
`ids.has(...)`. `2072…` and `x:2072…` both match; a genuinely-absent id still matches nothing.

## #1 — reconcile the real X url/id after a scheduled post publishes

**Problem:** PR #76 schedules X sends, so at send time the tweet/article isn't published yet — the
ledgers record the Typefully **draft id** as `postId` and a **null `url`**. §9b impressions
(`RecordImpressions` looks posts up by X tweet id) and the dashboard's publish links need the real
`x.com/…/status/<id>` url + tweet id. These only exist after the scheduled post goes live.

**Fix:** a `pnpm reconcile` command that, for each ledger row still holding a draft id (url not yet an
`x.com` url), fetches the Typefully draft and, once published, rewrites the row's `postId` → the real
X id and `url` → the `x.com` url. Idempotent (an already-`x.com` row is skipped); safe to run any time.

### Pieces

- **Parse helpers** (re-added to `src/adapters/send/typefullyPublish.ts`, removed in #76):
  `parseTweetId(url)` (`/status/(\d+)/`), `parseArticleId(url)` (`/article/(\d+)/`).
- **Ledger `loadAll()`**: expose the existing private `load()` as public `loadAll()` on
  `JsonChannelLedger` and `JsonXArticleLedger` (the reconcile reads all rows; `add()` already upserts
  by key, so an updated row is written back through `add()`).
- **`TypefullyDraftLookup`** (`src/adapters/send/TypefullyDraftLookup.ts`): `published(draftId): Promise<{ xUrl?: string; articleUrl?: string }>`
  = `GET /v2/social-sets/{id}/drafts/{draftId}` → `{ x_published_url, x_article_published_url }` (empty
  object on a non-ok response — a still-scheduled/deleted draft is just "not yet").
- **`ReconcilePublished`** use-case (`src/app/ReconcilePublished.ts`), deps = the two ledgers
  (`loadAll`/`add`), the lookup, `now`:
  ```
  run(): { reconciled, pending }   // pending = published url not available yet
    channel ledger: for each row where row.channel==="x" and !row.url?.includes("x.com"):
        u = await lookup.published(row.postId)
        if u.xUrl: ledger.add({ ...row, postId: parseTweetId(u.xUrl) ?? row.postId, url: u.xUrl }); reconciled++
        else pending++
    article ledger: for each row where !row.url?.includes("x.com"):
        u = await lookup.published(row.postId)
        if u.articleUrl: ledger.add({ ...row, postId: parseArticleId(u.articleUrl) ?? row.postId, url: u.articleUrl }); reconciled++
        else pending++
  ```
  A row with no `postId`, or whose lookup throws, counts as `pending` (never crashes the run).
- **CLI** `src/cli/reconcile.ts` (`pnpm reconcile`): wires both `Json*Ledger(paths.publishDir)`, a
  `TypefullyDraftLookup` from `loadTypefullyConfig()`. `skipIfLocal`-free (works in any mode, like send).
  Prints `reconciled N · pending M`.

## Non-goals

- Auto-reconcile inside the sender (the post isn't published at send time — reconcile is a separate,
  later pass; a scheduler/cron is out of scope).
- Telegram rows (immediate publish — real `t.me` url already recorded).
- Backfilling the §9b Sheet from reconciled ids (a later slice; reconcile only fixes the local ledger).

## Testing

- `matchesItemId`: `x:2072`+set{`2072`}→true; set{`x:2072`}→true; set{`999`}→false.
- `SendXArticle`/`SendChannels`: an `--ids` set with the bare id now selects the item (add one case each).
- `parseTweetId`/`parseArticleId`: `/status/123`→"123", `/article/9`→"9", junk→undefined.
- `TypefullyDraftLookup` (fake fetch): maps `x_published_url`/`x_article_published_url`; non-ok → `{}`.
- `ReconcilePublished` (fakes): a draft-id X row whose lookup returns a published url → row rewritten
  (postId=tweet id, url=x.com), `reconciled=1`; a still-scheduled row → unchanged, `pending=1`; an
  already-`x.com` row → skipped (no lookup); article row analogous.
- Full `pnpm test` green; `pnpm exec tsc --noEmit` clean.

## Files touched

- Create: `src/domain/itemId.ts`, `src/adapters/send/TypefullyDraftLookup.ts`, `src/app/ReconcilePublished.ts`, `src/cli/reconcile.ts` (+ tests)
- Modify: `src/adapters/send/typefullyPublish.ts` (parse helpers), `src/adapters/store/{JsonChannelLedger,JsonXArticleLedger}.ts` (`loadAll`), `src/app/{SendXArticle,SendChannels}.ts` (`matchesItemId`), `package.json` (`reconcile` script)
