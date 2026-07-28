# Outlet board: per-room delivery from the review dashboard — Design

**Date:** 2026-07-29
**Branch:** `feat/outlet-board` (off `main`)
**Status:** approved for planning

## Motivation

A reviewer who approves a translation in 1차 has no idea what to do next. The 2차 tab stays empty
until `convert` and `format` run on the CLI, and even then it lists **renderings** — one row per
`(itemId, type, channel)` — which answers "what text exists" but never "where does this go, and did
I send it".

The real delivery surface is a list of **rooms**, and the pipeline has no concept of one:

| Room | Channel | Delivery | Typical types |
| --- | --- | --- | --- |
| @0xMantleKR 포스트 | x | auto (Typefully) | `x` |
| @0xMantleKR 아티클 | x | auto (Typefully long-form) | — (translation goes direct) |
| 맨틀 한국 커뮤니티 | telegram | auto (bot) | `announcement`, `casual` |
| 맨틀 한국 데브방 | telegram | auto (bot) | `announcement`, `explainer` |
| 텔레그램 KOL방 | telegram | **manual** | `kol` (paid promo), `announcement` |
| 한국 블록체인 커뮤니티방 | telegram | **manual** | `announcement` |
| 오픈카톡 KOL방 | kakao | **manual** | `announcement` |
| 오픈카톡 블록체인 커뮤니티방 | kakao | **manual** | `announcement` |
| PR | pr_mail | auto (sender unbuilt) | `pr` |

Two facts fall out of that table that the current model cannot express:

1. **Two rooms can share a channel.** 맨틀 한국 커뮤니티 and 맨틀 한국 데브방 are both auto
   Telegram. The send ledger is keyed `(itemId, type, channel)`, so sending to one marks the
   other as sent — a silent skip of a room that never received anything.
2. **Four of nine rooms cannot be automated.** They are not our rooms, so no bot can post. Those
   deliveries are a human copying text and pasting it, and nothing records that it happened.

## Approach

Introduce **`Outlet`** as a first-class domain concept — a delivery room with a channel, a delivery
mode, and suggested types — and rebuild the 2차 tab around it.

**Why `outlet` and not `destination` or `target`.** §6 already uses `Destination` for the *spelling*
of a channel (`telegram_paste` vs `telegram_bot`), and `drive:publish --target` owns `target`.
Reusing either word would collapse two axes that this project has already conflated twice (docs
splitting by language-and-audience at one level; the `kakao` channel briefly hanging off the `x`
type). The three axes stay distinct:

| Axis | Question | Values |
| --- | --- | --- |
| **type** | what kind of copy is this | `x` · `announcement` · `explainer` · `casual` · `kol` · `pr` |
| **channel** | what format does it take | `x` · `telegram` · `kakao` · `pr_mail` |
| **outlet** | which room does it go to | the nine rooms above |

**Shared text, forked on edit.** A single `announcement` covers five rooms. Rooms only diverge when
the reviewer actually edits one, at which point that room gets its own copy and is reviewed and sent
independently. This is not a new idea in this codebase — `FormatVariants.ts:46` already does it one
level up, storing the same canonical text for every channel *"as a common starting point that the
writer can then refine per channel, which is what per-channel approval is for."* The outlet layer
applies the same rule one level down. It also means the reviewer's own editing gesture is the fork
trigger; there is no separate "customise this room" button.

The alternative — generating a distinct draft per room up front — was rejected because it multiplies
conversion and review work by the number of rooms on every item, and because fork-on-edit is a
superset: editing every room reproduces it exactly, while the up-front model cannot express "these
three rooms share one text".

## Design

### `Outlet` (new, `src/domain/outlet/models.ts`)

```ts
export interface Outlet {
  id: string;                        // "tg-community", "kakao-kol", …
  label: string;                     // "맨틀 한국 커뮤니티"
  channel: Channel;                  // decides which emitter spelling is used
  delivery: "auto" | "manual";
  suggestedTypes: ConversionType[];  // pre-checked rows; every type stays selectable
  chatIdEnv?: string;                // env var name holding the chat id (auto + telegram)
}
```

The nine outlets are a **code constant**, not configuration. They change rarely, and a constant is
what lets `Record<…>` exhaustiveness, the invariant tests, and the UI labels stay in sync — the same
reasoning that keeps `ALL_TYPES` / `ALL_CHANNELS` in code. Only the Telegram chat ids live in `.env`,
one per auto Telegram outlet, replacing today's single `TELEGRAM_CHAT_ID`.

**`.env` migration.** Telegram auto-send currently runs off a single `TELEGRAM_CHAT_ID`. Splitting it
per outlet means send stops working until the new variables are filled, so the change must be
staged: read the new per-outlet variables, **fall back to `TELEGRAM_CHAT_ID` for the primary outlet**
(`tg-community`) when they are absent, and warn. Nothing breaks on `git pull`, and `doctor` reports
which rooms are still unconfigured.

`.env.example` entries go **in the existing Telegram section next to `TELEGRAM_BOT_TOKEN`**, not
appended at the end, each with a comment naming the room it addresses and how to obtain the id. Keys
stay empty (`TELEGRAM_CHAT_ID_DEV=`) per the file's placeholder convention — the comment carries the
default and the explanation, never a fake value.

`suggestedTypes` is a **default, not a constraint** — mirroring `DEFAULT_CHANNELS_BY_TYPE`, which
`FormatVariants` reads as `selector.channels ?? DEFAULT_CHANNELS_BY_TYPE[v.type]`. The room↔type
mapping changed twice during design (데브방 gained `explainer`, KOL방 gained `announcement`), which
is evidence it is not settled knowledge and must not be frozen.

### Per-outlet override

`ChannelRendering` today is keyed `(itemId, type, channel)` and holds canonical text. Add an
optional per-outlet override, stored **only when it exists**:

```
renderings.json   (itemId, type, channel) → text, status, approvedAt      ← group text
overrides.json    (itemId, type, outlet)  → text, status, approvedAt      ← forked rooms only
```

Resolution is one pure function: `textFor(itemId, type, outlet)` returns the override when present,
else the group rendering. An unforked room has no row at all, so the common case costs nothing and
the existing rendering store is untouched.

Approval follows the text: approving the group approves every unforked room under it; a forked room
carries its own approval and is unaffected by the group's.

Two consequences worth stating, because both are reachable in normal use:

- **Forking an already-approved group yields an unapproved room.** The override starts at
  `rendered`, matching the existing rule that editing a rendering reverts it to `rendered`. The
  reviewer edited the text, so it has not been reviewed in that form.
- **Un-forking deletes the override**, and the room falls back to the group text and the group's
  approval. The card offers this as `그룹 글로 되돌리기` on a forked row; it is the only way back,
  since an override that merely *matches* the group text is still an independent row.

### Delivery ledger — key change and migration

Today `output/publish/channels.json` is keyed `(itemId:type:channel)`. It becomes
`(itemId:type:outlet)` in a new `output/publish/deliveries.json`:

```ts
{ itemId, type, outletId, status: "sent" | "delivered", at, by: "auto" | "manual", postId?, url? }
```

`sent` = a bot/API call succeeded. `delivered` = a human ticked "전달함"; it is a claim, not an
observation, so it is freely reversible while `sent` is not.

**Legacy rows** are read by attributing each old `(itemId, type, channel)` row to that channel's
**primary outlet** (`x` → `x-post`, `telegram` → `tg-community`, `kakao` → `kakao-blockchain`,
`pr_mail` → `pr-mail`), matching how `publish/state.json` migrates its legacy `{published:[…]}`
shape on read. The two kakao rooms are interchangeable for this purpose, so `kakao-blockchain` is an
arbitrary but fixed choice, recorded here so a later reader does not look for meaning in it. The
live ledger is empty today, so this path exists for correctness, not for data.

### Screen

One card per `(type, channel)` group. The card holds the text and the rooms that receive it, so
review and delivery happen in the same place — there is no separate review pane.

```
x:2080608995371597892   [post]   [원문↗]
─────────────────────────────────────────────────────────
수신처 9곳 · 12건 중 3건 완료
데브방 1/2 · 커뮤니티 1/1 · 오픈카톡 0/2 · KOL방 0/2

┌ 공지 · 텔레그램 ─────────────────────── 검수 대기 ┐
│  📢 **맨틀 코리아 공지**                          │
│  …                                                │
│                        [저장]  [승인 ✓]  [복사]   │
│  ───────────────────────────────────────────────  │
│  맨틀 한국 커뮤니티        자동   [발송] 🔒       │
│  맨틀 한국 데브방    1/2   자동   [발송] 🔒       │
│  한국 블록체인 커뮤니티방  수동   [전달함] 🔒 ✎따로│
└───────────────────────────────────────────────────┘

▸ 아직 변환 안 됨 — X · 해설 · 소통 · KOL · PR   [변환 준비]
```

- A room appearing in several cards (데브방 receives both `announcement` and `explainer`) shows
  `n/m` and highlights its sibling rows on hover.
- A forked room shows `✎따로` and expands to its own text.
- Groups whose type has not been converted collapse into one line.
- Cards that are approved and fully delivered collapse.
- `[복사]` copies the `_paste` spelling; `[발송]` sends the `_bot` / Typefully spelling. §6 already
  emits both per channel, so no new emitter is needed.
- Auto send asks for confirmation — a tweet or Telegram message is irreversible. Ticking "전달함"
  does not.

### Conversion stays agent-driven

The dashboard cannot convert. Runtime dependencies are `zod` only and there is no Claude API by
design; worksheets are filled by the local agent. So `[변환 준비]` runs `convert:prepare` and leaves
the item in a **변환 대기** state that the agent then fills. Everything downstream of conversion —
format, approve, copy, send, mark — is a dashboard button.

This is viable because volume is low: one source post at a time, not dozens a day.

### API

```
GET  /api/items/:id/board                                 card state for one item
POST /api/items/:id/convert-prepare                       run convert:prepare for chosen types
POST /api/items/:id/format                                run format for chosen types
PUT  /api/renderings/:itemId/:type/:channel               edit group text          (existing)
PUT  /api/renderings/:itemId/:type/:channel/:outletId     edit one room → forks it (new)
POST /api/deliveries/:itemId/:type/:outletId/send         auto send
POST /api/deliveries/:itemId/:type/:outletId/mark         tick / untick 전달함
```

### Error handling

A failed auto send is **not** ledgered, so a retry re-sends. A successful send whose ledger write
fails is recorded as `sent` with a warning — the inverse would re-send live content on the next run.
Both rules are inherited from `SendChannels`, not invented here. Manual ticks are reversible.

The PR outlet renders but its send button stays disabled: no mail sender exists yet.

## Non-goals

- **Conversion types.** `explainer`(해설) and `casual`(소통) shipped separately in #78, and the board
  reads `ALL_TYPES`, so it picks up all six with no work here. Further types are likewise out of
  scope — and must arrive with their `conversion/<type>.md` guideline, or they convert unsteered.
- A mail sender for PR.
- Kakao automation (no API; those rooms are manual by nature).
- Per-outlet scheduling, editing, or deleting an already-sent post.
- A room-centric view toggle. The same information drawn two ways; add it if the card view proves
  insufficient in use.

## Testing

- `textFor` returns the group text with no override, the override when present, and is unaffected
  by a sibling room's override.
- Approving a group approves unforked rooms only; a forked room keeps its own status.
- The ledger distinguishes two outlets on one channel — sending to 커뮤니티 leaves 데브방 unsent.
  (This is the bug the key change exists to prevent, so it gets a dedicated test.)
- Legacy `(itemId, type, channel)` rows resolve to the channel's primary outlet.
- Auto rows resolve to the `_bot` spelling, manual rows to `_paste`.
- A failed send leaves no ledger row; a ledger-write failure after a successful send still reports
  `sent`.

## Files touched

**New** — `src/domain/outlet/models.ts`, `src/domain/outlet/resolve.ts` (`textFor`),
`src/adapters/store/JsonDeliveryLedger.ts`, `src/app/DeliverToOutlet.ts`,
`web/src/components/OutletBoard.tsx`, `web/src/components/OutletCard.tsx`.

**Changed** — `src/config.ts` (per-outlet Telegram chat ids), `src/app/SendChannels.ts` (outlet-keyed
ledger), `src/adapters/web/apiHandlers.ts`, `src/cli/serve.ts`, `web/src/App.tsx`,
`web/src/components/RenderingsView.tsx` (replaced by the board), `.env.example`.
