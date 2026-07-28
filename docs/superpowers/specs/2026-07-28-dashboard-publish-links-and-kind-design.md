# Dashboard: publish links + item-kind badge + annotation-preserve fix — Design

**Date:** 2026-07-28
**Branch:** `feat/dashboard-redesign` (continues the modern-minimal redesign)
**Status:** approved for planning

## Motivation

Three gaps surfaced during Kyle's live review of the redesigned dashboard:

- **A — 발행 상태 links.** The "발행 상태" (publish status) section lists published rows
  in ledger order and offers at most one "open" link per row. Reviewers want a fixed
  `로컬 → 구글 → 라크` order and, for the two Drive targets, **both** an "open folder" and an
  "open file" link. Lark links were absent entirely because the workspace (tenant) URL needed
  to build them was never exposed to the app.
- **B — post/article badge.** A translated queue mixes X posts (short plain text) and X Articles
  (long markdown). The reviewer cannot tell them apart at a glance — the source item already
  carries `kind: "post" | "article"`, but the dashboard never surfaces it.
- **C — annotation-drop bug.** Editing or approving a translation through the dashboard calls
  `SaveTranslation.run` without `isReply`/`refUrl`, so a dashboard edit silently strips the
  review-doc annotations (the `[원문]` source link and the reply marker) added in an earlier feature.

`LARK_WORKSPACE_URL` config plumbing (the origin, e.g. `https://<tenant>.larksuite.com`) is already
landed on this branch (`loadLarkDriveConfig().workspaceUrl`, `.env.example`, invariant test green).

## Non-goals

- No storage-mode change from the dashboard (env-only, already fixed).
- No re-collection or re-translation. B works on existing translations without a backfill.
- No local "open folder" link — a browser cannot open a local filesystem directory.
- No change to how publishing itself works, or to the sync ledger.

---

## A — Publish-state links

### Data flow

The publish-state endpoint (`GET /api/publish/state`) returns `PublishStateRow[]`, built by
`serve.ts`'s `loadPublishState` from the sync-ledger entries. The server holds the Drive config;
the frontend does not. So **the server computes the URLs** and the frontend just renders them.

### Backend

**New pure helper** — `src/adapters/web/publishLinks.ts`:

```ts
export interface PublishLinkConfig {
  google?: { reviewFolderId: string; approvedFolderId: string };
  lark?: { workspaceUrl: string; reviewFolderToken: string; approvedFolderToken: string };
}

export interface PublishRowInput {
  target: string;            // "local" | "google" | "lark"
  status: string;            // "translated" | "approved"
  url?: string;              // Google webViewLink (from the ledger)
  remoteId?: string;         // Google fileId / Lark file_token
}

/** Folder/file URLs for a published row, or undefined where not derivable. Pure. */
export function publishRowLinks(
  row: PublishRowInput,
  cfg: PublishLinkConfig,
): { folderUrl?: string; fileUrl?: string };
```

Rules (folder selection mirrors `PublishTranslations`: `status === "approved"` → approved folder,
else review folder):

| target | folderUrl | fileUrl |
|--------|-----------|---------|
| google | `https://drive.google.com/drive/folders/<review\|approved FolderId>` (needs `cfg.google`) | `row.url` |
| lark | `<workspaceUrl>/drive/folder/<review\|approved FolderToken>` (needs `cfg.lark`) | `<workspaceUrl>/file/<row.remoteId>` (needs `cfg.lark` and `row.remoteId`) |
| local | *(none — browser can't open a local dir)* | *(none — frontend builds `/api/publish/local/…`)* |

Any missing input (no config, no `remoteId`) yields `undefined` for that URL — never a broken link.

> **Lark file URL caveat:** `<workspaceUrl>/file/<file_token>` is the best-known pattern. It must be
> verified against a real Lark-published file during the cloud-mode live test. If Lark uses a
> different path, adjust this one helper. The folder pattern is confirmed from a real Lark URL.

**`PublishStateRow`** (`apiHandlers.ts`) gains two optional fields:

```ts
export interface PublishStateRow {
  itemId: string; status: string; target: string;
  url?: string; remoteId?: string; fileName?: string;
  folderUrl?: string; fileUrl?: string;   // NEW
}
```

**`serve.ts`** loads the link config once at startup (best-effort, reusing the existing
`try { loadGoogleDriveConfig() } catch {}` pattern already used for `usableTargets`) into a module
`PublishLinkConfig`, and `loadPublishState` spreads `publishRowLinks(entry, linkCfg)` into each row.
In local mode the config is empty and only local rows exist, so nothing is computed.

### Frontend (`TranslationDetail.tsx`)

- `types.ts` `PublishStateRow` gains `folderUrl?`/`fileUrl?`.
- Sort `publishRows` by a fixed target rank `{ local: 0, google: 1, lark: 2 }` before rendering.
- Per row, render the target label + status, then links:
  - **local**: `파일 열기 ↗` → `/api/publish/local/<remoteId>` (existing behavior).
  - **google/lark**: `폴더 열기 ↗` when `folderUrl`, `파일 열기 ↗` when `fileUrl`.
  - none available → `링크 없음`.
- Labels/spacing follow the existing redesigned row style.

---

## B — post/article badge (derived, not stored)

`kind` is a **display-only** concern for the dashboard (unlike `isReply`/`refUrl`, which the review
renderer consumes). So it is **not** added to the `Translation` model or the save path — it is
**derived at read time** by joining the translations list to the collected content items. This needs
no model change and no backfill, and it works for the existing translations immediately.

### Backend

- **`ApiTranslation` DTO** — the translations-list response becomes `Translation & { kind?: "post" | "article" }`.
- **New dep** `loadTranslations(): Promise<ApiTranslation[]>` on `ApiDeps`, wired in `serve.ts`:
  it loads `translationStore.loadAll()` and the content items
  (`contentSource.loadPending(new Set())` — already used by `loadStatus`, returns all collected
  items), builds an `id → kind` map, and attaches `kind` per translation (`undefined` when the item
  is absent from the source — graceful, no badge).
- `apiHandlers` `GET /api/translations` returns `await deps.loadTranslations()` instead of
  `translationStore.loadAll()`. Edit/approve responses (single `findById`) are unchanged — the
  frontend refreshes the full list (which carries `kind`) after those actions.

### Frontend

- `types.ts` `Translation` gains `kind?: "post" | "article"`.
- **New `KindBadge`** (exported from `TranslationList.tsx`): `포스트` / `아티클`, quiet neutral styling
  (not competing with the mint/amber status chip). Renders nothing when `kind` is undefined.
- `TranslationList` row and `TranslationDetail` header both show `<KindBadge kind={item.kind} />`.

---

## C — annotation-preserve fix

`apiHandlers.ts` edit (`PUT`), approve (`POST …/approve`), and unapprove (`POST …/unapprove`) each
call `saveTranslation.run` with only `{ itemId, source, sourceText, koreanText, approve }`. Add the
two fields from the already-loaded `existing` translation:

```ts
await deps.saveTranslation.run({
  itemId: existing.itemId, source: existing.source, sourceText: existing.sourceText,
  koreanText /* or existing.koreanText */, approve: /* per handler */,
  isReply: existing.isReply, refUrl: existing.refUrl,   // NEW — preserve annotations
});
```

`kind` is *not* passed (B derives it; it is never stored). This is the entire fix — three call sites.

---

## Testing

- **A — `publishLinks` unit tests** (pure, no I/O): google review/approved folder + file url; lark
  review/approved folder + file url from `workspaceUrl`; local → both undefined; missing config →
  undefined; missing `remoteId` → lark fileUrl undefined; trailing-slash `workspaceUrl` handled.
- **A — `loadPublishState` wiring**: rows carry `folderUrl`/`fileUrl` when config present.
- **B — `loadTranslations`**: attaches `kind` from the content source by `itemId`; leaves `kind`
  undefined when the source item is missing; does not mutate stored translations.
- **C — apiHandlers**: an edit and an approve of a translation whose `existing` has
  `isReply: true, refUrl: "…"` call `saveTranslation.run` with those fields preserved (assert via a
  spy/fake `SaveTranslation`, checking the `run` argument).
- **Frontend**: typecheck + `pnpm build:web`; live verification in the browser (local mode for A's
  local rows + B badges + C preserve; cloud mode to verify the real Google/Lark folder & file URLs).
- Full `pnpm test` green; `.env` restored to cloud mode after any local-mode testing.

## Files touched

- Create: `src/adapters/web/publishLinks.ts` (+ test)
- Modify: `src/adapters/web/apiHandlers.ts` (PublishStateRow fields, `loadTranslations` dep + wiring,
  GET /translations, C fix in 3 handlers), `src/cli/serve.ts` (link config, `loadPublishState`
  enrich, `loadTranslations`)
- Modify frontend: `web/src/types.ts`, `web/src/components/TranslationList.tsx` (KindBadge),
  `web/src/components/TranslationDetail.tsx` (sorted rows + folder/file links + kind badge)
- No change to `Translation`/`SaveInput`/`translate-save.ts` (B is derived).

## Follow-up (separate, not in this spec)

- **D — quote-tweet link capture** (collection/schema): `normalizeTweet` records only the `isQuote`
  boolean and drops the quoted tweet's URL, so "The full breakdown ↓" has no link. Extract the
  quoted tweet's URL from the raw `quoted_tweet` and append it; re-collect. Its own spec/plan/PR.
