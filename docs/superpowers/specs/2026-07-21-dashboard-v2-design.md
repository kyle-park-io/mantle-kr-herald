# Review dashboard v2 — per-item publish + polish — design

**Date:** 2026-07-21
**Status:** approved
**Scope:** the review dashboard (`web/` + `src/adapters/web/`). Rework publishing from a global
header action into per-item, per-target buttons in the detail pane; add un-approve; make the storage
mode visible; link X items to the original tweet; bump the font sizes; serve web fonts with the right
MIME. Follow-up to PR #45 (which added the read endpoints, published-artifact links, mode badge,
status line, Pretendard, and the filter scrollbar fix).

## Context

The dashboard is React + Vite + Tailwind v4 (`web/`) over a thin JSON API (`src/adapters/web/apiHandlers.ts`)
composed in `src/cli/serve.ts` and served by `HttpServer.ts` (localhost only). PR #45 shipped:
`GET /api/status` (mode + funnel + sync), `GET /api/publish/state` (trimmed ledger),
`GET /api/publish/local/<path>` (serves a local publish file as `text/markdown`, traversal-guarded),
a header mode badge + status line, published-artifact links in the 1차 detail pane, and the Pretendard
font.

This v2 acts on Kyle's feedback on #45:

- Publishing today is a **global** header `PublishBar` — it batch-publishes *all* approved translations
  to the selected target(s). Kyle wants it **per item, per target**: buttons next to 저장/승인 in the
  detail pane — `로컬 저장` / `구글 클라우드` / `라크 클라우드` — each publishing *this* item to *that*
  target.
- Clicking 1차/2차 causes a **vertical shift** because `PublishBar` renders only in 1차, changing the
  header height. Removing `PublishBar` from the header (this redesign) resolves it — the list/panel
  `scrollbar-gutter` fix from #45 already holds (measured: section width stable across modes).
- There is an 승인 (approve) action but no way to revert it (승인 취소).
- The mode badge's contrast is poor — it should be clearly readable. (No runtime mode toggle: the
  storage mode stays `.env`-driven per the "never inferred, explicit" storage principle; the badge is
  the display, already in the header.)
- The `itemId` (`x:<tweetId>`) should link to the original tweet.
- Fonts are a touch small.
- The static MIME map lacks `.woff2` (the Pretendard fonts serve as `application/octet-stream`).

## Decisions (locked in brainstorming)

- **Reuse existing use-cases** — no new use-case or port. Per-item publish = `PublishTranslations`
  with an `itemId` filter and a single-target uploader. Un-approve = `SaveTranslation` with
  `approve: false`.
- **Per-target buttons show all three, always**; only the **usable** ones get color + are clickable,
  the rest are greyed/disabled. Usability = the server's `availableTargets` (mode + credentials), so
  the frontend never offers a target that would fail.
- **The header `PublishBar` is removed entirely** (not moved). Batch publishing stays available via
  the `pnpm drive:publish` CLI.
- **`availableTargets` is added to `GET /api/status`** (the frontend already fetches it once; one
  source for the badge, funnel, and the buttons).
- **No runtime storage-mode toggle.** Mode stays `.env`-driven; the badge (contrast-fixed) is the
  display.

## Design

### 1. Per-item publish (backend)

- **`PublishTranslations.run` gains an optional filter:** `run(opts: { itemId?: string } = {})`. When
  `itemId` is set, only that translation is considered; everything else (create/update/skip decision,
  the sync ledger, failure isolation, `PublishResult`) is unchanged. The `drive:publish` CLI and the
  dashboard's global publish both call `run()` (no arg) today and keep working.
- **New route `POST /api/translations/:id/publish`** with body `{ target: "local" | "google" | "lark" }`.
  It resolves the single target through the existing `resolveTargets(target, storageMode)` (which throws
  for a cloud target in local mode) and `createUploaders`, then runs
  `PublishTranslations(translationStore, uploaders, publishStore).run({ itemId })`. Returns the
  `PublishResult` for that item (`uploaded`/`updated`/`failed`/`failures`/`byDrive`). A config/credential
  error (e.g. missing Google folder) surfaces as a 500 with the message, same as the existing publish
  route. Wired through `ApiDeps` as `publishOne: (id: string, target: string) => Promise<PublishResult>`,
  composed in `serve.ts`.

### 2. Un-approve (backend)

- **New route `POST /api/translations/:id/unapprove`** → `SaveTranslation.run({ itemId, source,
  sourceText, koreanText, approve: false })` on the existing translation, reverting `approved` →
  `translated` (and clearing `approvedAt`). Reuses `deps.saveTranslation`; symmetric to the existing
  `POST /api/translations/:id/approve`. (Editing already reverts approval; this is the button for
  reverting *without* editing.)

### 3. `availableTargets` (backend)

- **`GET /api/status` response gains `availableTargets: ("local" | "google" | "lark")[]`.** Computed in
  `serve.ts`: `local` is always present (the local uploader needs no credentials); `google` is present
  only when `storageMode === "cloud"` **and** `loadGoogleAuthConfig()` + `loadGoogleDriveConfig()` load
  without throwing; `lark` only when `storageMode === "cloud"` **and** `loadLarkDriveConfig()` loads.
  So a target appears usable exactly when a publish to it would not fail on configuration. `StatusView`
  gains the field.

### 4. Detail pane — per-target buttons + un-approve (frontend)

- **`TranslationDetail`** gets the three publish buttons (`로컬 저장` / `구글 클라우드` / `라크 클라우드`)
  next to 저장/승인, plus 승인 취소. It receives `availableTargets: string[]` (from App, from
  `/api/status`) and, for each of `["local","google","lark"]`, renders a button that is colored +
  enabled when the target is in `availableTargets`, else greyed + `disabled`. Clicking calls
  `api.publishOne(itemId, target)`, then refreshes the publish state (so the 발행 상태 links update) and
  shows a short result (`업로드 N · 갱신 M · 실패 K`) or the error.
- **승인 취소** button appears only when `item.status === "approved"`; it calls `api.unapprove(itemId)`
  then refreshes. The existing 승인 button stays for `translated` items.

### 5. Header — remove PublishBar, fix badge contrast (frontend)

- **Remove `<PublishBar />` from `App.tsx`'s header** and delete `web/src/components/PublishBar.tsx`
  (its only consumer). Its API calls `api.publish` and `api.config` become unused — remove them (the
  badge/buttons use `/api/status`). Because `PublishBar` was the only caller of the **global**
  `POST /api/publish` route, that route and its `ApiDeps.buildPublisher` dependency are **removed and
  replaced by the per-item `publishOne`** (§1). `resolveTargets` / `createUploaders` stay — `publishOne`
  reuses them. Batch publishing across all approved items stays available via `pnpm drive:publish`.
  Update the tests that exercised `POST /api/publish` / `buildPublisher` to the per-item route.
- **Mode badge contrast:** restyle so `local`/`cloud` is clearly legible on the dark header (e.g. a
  solid, higher-contrast chip rather than the low-opacity tint). Keep it in its current header position.
- Removing PublishBar makes the header identical across 1차/2차, eliminating the vertical shift.

### 6. itemId → X link + font sizes (frontend)

- **`x:<tweetId>` links to `https://x.com/i/status/<tweetId>`** (open in a new tab), rendered where the
  `itemId` is shown (the `TranslationList` row and the `TranslationDetail` header). A `lark:<id>` item
  has no public URL, so it stays plain text. Helper: split `itemId` on the first `:`; if the prefix is
  `x`, link to the tweet.
- **Bump the font scale** one notch across the dashboard (the pervasive `text-xs` / `text-[11px]` are
  small): raise the small text to a comfortable size while keeping the layout. Applied by editing the
  Tailwind size classes in the components; no new mechanism.

### 7. Web-font MIME (backend)

- **Add `.woff2`, `.woff`, `.ttf` to `HttpServer.ts`'s `MIME` map** (`font/woff2`, `font/woff`,
  `font/ttf`) so the bundled Pretendard fonts serve with a correct `Content-Type` instead of
  `application/octet-stream`.

## Testing

- **Backend unit / handler tests:**
  - `PublishTranslations.run({ itemId })` publishes only the named item and leaves the others untouched
    (extend `tests/app/publishTranslations.test.ts` with one case; the existing no-arg cases must keep
    passing unchanged).
  - `POST /api/translations/:id/publish` calls `publishOne(id, target)` and returns its result;
    `POST /api/translations/:id/unapprove` reverts via `saveTranslation`; `GET /api/status` includes
    `availableTargets` (in `tests/adapters/web/apiHandlers.test.ts`, extending `makeDeps`).
  - `HttpServer` serves a `.woff2` with `Content-Type: font/woff2`
    (`tests/adapters/web/httpServer.test.ts`).
- **Frontend:** `pnpm typecheck:web` + `pnpm build:web`, then a playwright smoke on `pnpm serve`
  confirming: the header has no PublishBar and the mode badge is legible; the detail pane shows the
  three target buttons with only the usable ones enabled (in local mode: only `로컬 저장`); clicking
  `로컬 저장` publishes the item and the 발행 상태 link appears/updates; 승인 취소 reverts an approved
  item; an `x:` itemId links to the tweet; and 1차/2차 no longer shifts.

## Notes / non-goals

- **`라크 클라우드` will be greyed** until Lark Drive is configured (its scope approval is pending) —
  correct behaviour, not a bug.
- **No runtime mode toggle**, no change to `HERALD_STORAGE_MODE`'s `.env`-driven, explicit semantics.
- **Batch publish** stays a CLI concern (`pnpm drive:publish`); the dashboard is per-item.
- Impressions, markdown rendering of opened files — still out of scope (deferred from #45).
- No change to the pipeline, the CLIs' behaviour, or `output/` layout.
