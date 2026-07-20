# Review dashboard enhancements — design

**Date:** 2026-07-21
**Status:** approved
**Scope:** the local review dashboard (`web/` + `src/adapters/web/`). Fix a layout bug, apply the
Pretendard font, and add three mode-aware operational reads (mode badge, pipeline status line,
published-artifact links) — keeping the dashboard a review/approve tool, not turning it into a full
ops console.

## Context

The dashboard (`pnpm serve` → `localhost:5757`) is a React + Vite + Tailwind v4 frontend in `web/`
served by a `node:http` server (`src/adapters/web/HttpServer.ts`) over a thin JSON API
(`src/adapters/web/apiHandlers.ts`) that wraps existing use-cases. It has two modes — 1차 검수
(translations) and 2차 검수 (channel renderings) — plus a `PublishBar` that already reads
`GET /api/config` for the storage mode.

`HttpServer` routes `/api/*` to `handleApi` (always JSON) and serves everything else as a static
file from `web/dist` (with SPA fallback and a `../`-stripping guard). Backend stays **`zod`-only**;
`web/` carries build-time devDependencies only.

This enhancement was scoped down from "ops console" to "review tool + a few simple, high-value
operational reads, all built on existing backend data."

## Decisions (locked in brainstorming)

- Data exposure = **focused new read endpoints + a static-style file route**, not an enriched
  `/api/translations` and not one fat `/api/dashboard`. Matches the existing per-resource, thin-JSON
  routing style.
- The CSS bug is **diagnosed on the running app first**, then fixed at its real cause — no blind fix.
- Pretendard is **self-hosted** (offline-capable local tool), added as a `web/` devDependency; no CDN.
- Published-artifact links live in the **detail pane** (`TranslationDetail`), with at most a small
  "published" dot in the list — not crammed into list rows.
- A local published file opens as **raw markdown** in a new tab (no markdown rendering — YAGNI).
- **Impressions (§9b) are out of scope** — they live in the Google Sheet, not `output/`, so the
  dashboard would need Sheet reads + the `spreadsheets` scope (not live). Deferred.

## Design

### 1. Fix the filter/list layout shift (bug A)

**Symptom:** clicking a status filter (`all`/`translated`/`approved` in `TranslationList`,
`all`/`rendered`/`approved` in `RenderingList`) shifts the layout horizontally.

**Method:** reproduce on the running app before fixing (this is a systematic-debugging step, not a
guess). The filter buttons themselves are ruled out — active and inactive states both carry a 1px
`border`, so the button box does not resize. The leading hypothesis is the **scrollbar gutter**: the
scrollable panel (`<aside className="… overflow-y-auto">` in `App.tsx`, and the `RenderingsView`
list panel) gains/loses its vertical scrollbar as the filtered list grows/shrinks, and the content
box width jumps by the scrollbar width.

**Fix (apply to the confirmed cause):** if it is the scrollbar, add `scrollbar-gutter: stable` to the
scrollable containers so the gutter is always reserved. If reproduction reveals a different cause,
fix that instead and record what it was. Verified by filtering back and forth in the running app
with no horizontal movement.

### 2. Pretendard font (B)

Self-hosted so the dashboard works with no network:

- Add **`pretendard`** to `web/`'s `devDependencies` (build-time only; the `zod`-only runtime
  constraint binds the Node backend, not the Vite-built frontend, which already bundles
  React/Tailwind).
- Import its stylesheet in `web/src/styles.css` (e.g. the Pretendard variable CSS), and set the app
  default font to `Pretendard` with a system-ui fallback stack. In Tailwind v4 this is the
  `--default-font-family` / `--font-sans` theme variable (or a `body { font-family }` rule in
  `styles.css`); the implementation picks whichever the installed Tailwind v4 supports, verified by
  the font actually rendering.
- No CDN link, no runtime fetch — the woff2 is bundled by Vite into `web/dist`.

### 3. `GET /api/status` — pipeline status + mode (feeds the badge and the line)

**Endpoint (`apiHandlers.ts`):** `GET /api/status` → `200`
```ts
{
  storageMode: "local" | "cloud",
  funnel: { collected: number; translated: number; converted: number; rendered: number; published: number },
  sync: { published: number; unsynced: number; stale: number }
}
```

**Wiring (`serve.ts`):** the funnel and sync numbers are exactly what `pnpm status` computes, so
reuse `src/status/pipeline.ts` (`pipelineStages`) and `src/status/sync.ts` (`syncSummary`). Because
computing them needs stores the current `ApiDeps` does not all hold (content sources for `collected`,
the publish ledger for `published`/sync), add one dependency to `ApiDeps`:
`loadStatus: () => Promise<StatusView>`, which `serve.ts` constructs over the content sources +
translation/conversion/formatting/publish stores + `loadStorageMode()`. `handleApi` just calls it.
Keeping the composition in `serve.ts` leaves `apiHandlers` thin.

**Frontend:** `api.status()` in `web/src/api.ts`; a thin header line under the nav showing the funnel
(`수집 N → 번역 N → 변환 N → 렌더 N → 발행 N`) and the sync summary, with a `⚠` when
`unsynced > 0 || stale > 0`, mirroring the CLI. The `storageMode` from the same response drives the
**mode badge** (item 4).

### 4. Mode badge (C)

A small header badge reading `local` or `cloud`, color-coded (e.g. cloud = green, local = neutral),
so a reviewer sees where 발행 sends artifacts. It reads `storageMode` from the `GET /api/status`
response (item 3) — no separate fetch. `GET /api/config` is unchanged and still used by `PublishBar`.

### 5. Published-artifact links (D + E1)

**Endpoint (`apiHandlers.ts`):** `GET /api/publish/state` → `200` an array of trimmed ledger rows:
```ts
{ itemId: string; status: string; target: string; url?: string; remoteId?: string; fileName?: string }[]
```
Source = the sync ledger (`output/publish/state.json`) via the existing `PublishStore.listEntries()`.
Add `loadPublishState: () => Promise<PublishStateRow[]>` to `ApiDeps`, wired in `serve.ts` from the
`JsonPublishStore` it already constructs.

**Ledger field meaning (important):** `LocalFileUploader.upload` returns `{ id: <rootDir-relative
path, e.g. "approved/<name>.md">, name: <bare filename> }`, and `PublishTranslations` records
`remoteId: result.id`, `fileName: result.name`. So for a **local** row, **`remoteId` is the relative
path** to open (`approved/<name>.md`), while `fileName` is only the bare name. For a **google/lark**
row, `remoteId` is the Drive file id and `url` is the openable `webViewLink`.

**Local file route (`HttpServer.ts`):** a new branch, checked **before** the `/api/` JSON branch,
for `GET /api/publish/local/<relpath>`:
- resolve `<relpath>` under `paths.publishLocalDir` (passed in via `opts.localPublishDir`), applying
  the same `../`-strip + `normalize` guard the static branch already uses, and additionally asserting
  the resolved path stays under the root (defense in depth, mirroring `LocalFileUploader`'s name
  guard);
- on hit, respond `200` with `Content-Type: text/markdown; charset=utf-8` and the file bytes;
- on miss or traversal, respond `404` (not the SPA fallback — a missing publish file is a 404).
Add `.md → text/markdown; charset=utf-8` to the `MIME` map.

**Frontend (`TranslationDetail`):** a "발행 상태" block. For the selected translation, filter the
`GET /api/publish/state` rows to those whose `itemId` matches, and render one row per ledger entry:
- `target` is `google`/`lark` and `url` present → a link "Drive에서 열기" opening `url` in a new tab;
- `target` is `local` → a link "열기" opening `/api/publish/local/<remoteId>` in a new tab, where
  `remoteId` is the `rootDir`-relative path (e.g. `approved/<name>.md`);
- show the `status` (review/approved) and `target` beside each.
If no ledger rows match, show "아직 발행되지 않음". `TranslationList` rows may show a small dot when
an item has any ledger entry (optional, low priority).

## Testing

- **`apiHandlers`** (`tests/adapters/web/apiHandlers.test.ts`): `GET /api/status` returns the
  `storageMode`/`funnel`/`sync` shape from an injected `loadStatus`; `GET /api/publish/state` returns
  the injected rows. Existing routes untouched (their assertions unchanged; `makeDeps` gains the two
  new deps).
- **`HttpServer`** (`tests/adapters/web/httpServer.test.ts`): `GET /api/publish/local/<f>` returns the
  file with `text/markdown`; a traversal attempt (`/api/publish/local/../../etc`) returns `404` and
  reads nothing outside the root; a missing file returns `404` (not `index.html`).
- **Status/sync reuse:** no new logic to test there — `pipelineStages`/`syncSummary` already have
  unit tests; the new code only wires them.
- **Frontend (font, badge, status line, publish links, CSS fix):** `pnpm typecheck:web` +
  `pnpm build:web` clean, then verified by running `pnpm serve` — the font renders as Pretendard, the
  badge shows the mode, the status line shows the funnel, a published item opens its Drive link (or
  local file), and filtering no longer shifts the layout.

## Notes / non-goals

- **2차 (renderings) publish links** — none, by design: the ledger is written by `drive:publish` for
  translations; renderings have no publish target until §8. The published block is 1차 only.
- **Impressions** — deferred (see Decisions).
- **Markdown rendering** of the opened local file — deferred (raw markdown is readable enough; a
  renderer would add a frontend dependency for little gain).
- No change to the publish/approve/edit flows, the CLIs, or any `output/` layout.
