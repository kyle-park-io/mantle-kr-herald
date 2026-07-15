# Second Review (§7) — Dashboard extension for channel renderings — Design

**Status:** Approved design (2026-07-15)
**Depends on:** E (review dashboard: `apiHandlers`, `HttpServer`, `serve`, `web/`), F (`ChannelRendering`, `FormattingStore`, `FormatVariants`, `SaveRendering`, `ConversionStore`).

## Goal

The **2차 검수** (second review) step from the proposal (§7): a human reviews, edits, and
approves the **channel-ready output** of §6 — the `ChannelRendering`s that will be posted —
the same way §4 (1차 검수) reviews translations. This extends the existing local review
dashboard (E) rather than building a new tool.

Pipeline position:

```
… → §5 convert → §6 format → [§7 2차 검수: review / edit / approve renderings] → §8 upload
```

§8 upload is **out of scope**. §7's terminal action is **approve** — an approved rendering is
the finalized, copy-paste-ready channel text (tweet / Telegram / KakaoTalk / PR-mail body).

## Review subject & state model

The reviewed unit is the **`ChannelRendering`** (identity `(itemId, type, channel)`), the actual
text that ships to a channel. It gains an approval state, mirroring how `Translation` and
`ContentVariant` carry `status`:

```ts
interface ChannelRendering {
  itemId: string;
  type: ConversionType;
  channel: Channel;
  text: string;
  refined: boolean;                     // existing: false = code formatter, true = agent/human edited
  createdAt: string;
  status: "rendered" | "approved";      // NEW
  approvedAt?: string;                  // NEW
}
```

- **Creation** (`FormatVariants` code path, `SaveRendering` from `format:save`) sets
  `status: "rendered"`.
- **Edit** (dashboard, or `format:save`) updates `text`, sets `refined: true`, and resets
  `status: "rendered"` (an edited rendering must be re-approved — same rule as editing a
  translation reverts it to `translated`).
- **Approve** (dashboard) sets `status: "approved"` + `approvedAt`, leaving text/refined/createdAt.

Rationale for state-on-entity (vs. a separate approval store): consistency with the two existing
review stages, and §7 already mutates the rendering on edit, so approval belongs on the same record.

## Backend

Follows the E dashboard's thin-adapter pattern (`apiHandlers` routes over app use-cases; no new
domain logic beyond the model field).

**Use-cases:**
- **List** — reuse `FormattingStore.loadAll()`.
- **Edit** — reuse **`SaveRendering`**. The dashboard edit (`text` override → `refined: true`,
  `status: "rendered"`) is the identical operation `format:save` already performs, so the same
  use-case serves both. `SaveRendering` is updated to set `status: "rendered"`.
- **Approve** — new **`ApproveRendering`** use-case: `run({ itemId, type, channel })` loads the
  matching rendering via `FormattingStore.loadAll()`, sets `status: "approved"` + `approvedAt`,
  upserts it, and returns the updated rendering — or `undefined` when no rendering matches. The
  API handler maps `undefined` → 404.

**API routes** (mirror the `translations` routes; renderings keyed by three path segments,
`itemId` URL-encoded since it contains `:`):
- `GET  /api/renderings` — all renderings, each enriched with the source variant's
  `convertedText` (joined by `(itemId, type)` from `ConversionStore.loadAll()`) as read-only
  review context. Shape: `ChannelRendering & { convertedText: string }`.
- `PUT  /api/renderings/{itemId}/{type}/{channel}` — body `{ text }` → `SaveRendering`.
  Validates non-empty `text`; 404 if the rendering doesn't exist.
- `POST /api/renderings/{itemId}/{type}/{channel}/approve` → `ApproveRendering`. 404 if missing.

**Composition root (`serve.ts`)** gains `formattingStore` (`JsonFormattingStore("output/formatted")`),
`conversionStore` (`JsonConversionStore("output/variants")`, for the join), `saveRendering`, and
`approveRendering` in `ApiDeps`. The existing translation deps are unchanged.

## Frontend

Extends `web/` (React + Vite + Tailwind v4). Existing translation view is untouched; a mode
toggle switches between the two review stages.

- **`App.tsx`** — `mode: "translations" | "renderings"` state; header toggle
  `[1차 검수 (번역)] [2차 검수 (채널)]`. Each mode renders its own list + detail using the shared
  layout. The unsaved-edit guard applies to both.
- **`RenderingList`** (new) — one row per rendering (`itemId · TYPE · channel · status`), with
  filters: **status** (rendered / approved), **channel** (x / telegram / kakao / pr_mail),
  **type** (x / kol / pr).
- **`RenderingDetail`** (new) — read-only source context (the variant's `convertedText`) +
  editable channel `text` + **저장** / **승인** buttons + a **승인본 복사** (copy-to-clipboard)
  button (8-1 tweet / 8-3 KakaoTalk are posted manually, so copy-ready text is directly useful).
  Reports dirty state via `onDirtyChange`, like `TranslationDetail`.
- **`types.ts` / `api.ts`** — add the `ChannelRendering` (+ `convertedText`) type and three
  endpoints (`listRenderings`, `editRendering(itemId,type,channel,text)`,
  `approveRendering(itemId,type,channel)`), mirroring the translation API helpers.

Empty state (no renderings yet): prompt to run `pnpm format` first (renderings are produced by the
CLI; the dashboard reviews them, exactly as it reviews CLI-produced translations).

## Scope

**In:** list/filter/edit/approve `ChannelRendering`s in a new dashboard mode; the model + backend
routes + composition wiring to support it; copy-to-clipboard for approved text.

**Out:** §8 upload (sending approved renderings to channels); generating renderings in the UI
(that's `pnpm format`); auth/hosting/multi-user (unchanged local-tool posture).

## Testing

- **`ApproveRendering`** — approves a `rendered` rendering → `approved` + `approvedAt`; 404/absent
  handling.
- **`SaveRendering`** — updated: created/edited rendering carries `status: "rendered"` (existing
  test's `toEqual` updated for the new fields).
- **`FormatVariants`** — updated: created renderings carry `status: "rendered"`.
- **`JsonFormattingStore`** — fixture updated for the new fields (existing key/upsert tests hold).
- **`apiHandlers`** — new renderings routes: list join includes `convertedText`; PUT edits +
  reverts to `rendered`; POST approve; validation + 404 paths.
- **Frontend** — component behavior is verified by the existing manual/e2e approach used for E
  (no unit-test harness in `web/`); `pnpm typecheck:web` must pass.

## Model-change ripple (F)

Adding the required `status` field touches F code and its tests: `FormatVariants` and
`SaveRendering` set `status: "rendered"`; `SaveRendering.test` and `JsonFormattingStore.test`
(which assert full-object equality / use fixtures) are updated to include the new fields. These are
mechanical updates bundled with the model change, not behavior changes to §6 formatting.

## Build order (one plan)

1. Model + F creators: add `status`/`approvedAt` to `ChannelRendering`; `FormatVariants` &
   `SaveRendering` set `"rendered"`; update the two affected F tests.
2. `ApproveRendering` use-case (+ test).
3. API handlers: `/api/renderings` list (with `convertedText` join), PUT edit, POST approve
   (+ handler tests).
4. `serve.ts` composition wiring.
5. Frontend: `types`/`api`, `App` mode toggle, `RenderingList`, `RenderingDetail`
   (+ `pnpm typecheck:web`, `pnpm build:web`).
6. Docs: document the 2차 검수 mode in the README (extend the Module E section) + CHANGELOG `[Unreleased]`.
