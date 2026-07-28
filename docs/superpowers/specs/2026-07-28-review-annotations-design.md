# Review annotations — reply(옵셔널) marker + source link — design

Date: 2026-07-28
Status: approved for planning
Scope: at the two human-judgment surfaces — the **translation worksheet** and the **Drive review `.md`**
(`renderReview`) — annotate each item's id header with a **reply marker `(댓글·옵셔널)`** and a
**clickable source link `[원문](url)`**, so a reviewer can spot/skip reply-type items (optional content)
and jump to the original tweet. Annotations are review metadata only — they never enter the translated
text or the approved doc.

## Context

Mantle's account posts include replies to others (e.g. `@prufboogie 24/7.`), which the pipeline
collects and translates like any post. In the review queue they are indistinguishable from primary
posts, yet they are the most skippable content. Reviewers also have no quick way to open the source
tweet from a `x:<id>` header.

Two facts make this cheap:
- The worksheet already renders a **free-form marker slot** in each item header —
  `assembleItemBlock` builds `### ${item.id}${marker}` where `marker` is currently `" [article]"` for
  X Articles (`src/domain/translation/promptAssembler.ts`). We extend that slot.
- `ContentItem` already carries `refUrl` (the root tweet's `url`), and `SourceTweet` already has
  `isReply: boolean` and `url: string` (`src/domain/models.ts`) — the data exists; it is just dropped
  on the way to the worksheet/review doc.

The review `.md` is built from the **`Translation`** model, which carries neither `isReply` nor
`refUrl` today, so the feature threads those two fields from collection through save into
`renderReview`.

## Decisions

### 1. Header format — one shared suffix helper

A single pure helper composes the annotation, used by both the worksheet and the review doc:

```
replyAndLinkSuffix(isReply?, refUrl?):
  ""                                        when neither
  " (댓글·옵셔널)"                            when isReply only
  " · [원문](<refUrl>)"                       when refUrl only
  " (댓글·옵셔널) · [원문](<refUrl>)"           when both
```

- **Worksheet** header (`assembleItemBlock`): `### ${id}${kindMarker}${replyAndLinkSuffix(...)}` — the
  existing `[article]` kind marker stays first, then the suffix. e.g.
  `### x:2077817672977596772 (댓글·옵셔널) · [원문](https://x.com/Mantle_Official/status/2077817672977596772)`.
- **Review doc** header (`renderReview`): `# ${itemId}${replyAndLinkSuffix(...)}` (no kind marker — the
  `Translation` model has no `kind`). e.g. `# x:2077817672977596772 (댓글·옵셔널) · [원문](…)`.
- Marker `(댓글·옵셔널)` appears **only when `isReply`**; link `[원문](url)` **only when `refUrl` is
  present**. A Lark item (no `refUrl`, no `isReply`) renders exactly today's header (`### lark:…` /
  `# lark:…`) — the suffix is empty. Backward-compatible: an item with neither field is unchanged.

### 2. Thread two fields through the pipeline

- `ContentItem` gains `isReply?: boolean` (X-only, alongside the existing `refUrl?`).
- `XContentSource` sets `isReply` from the **root tweet** (`thread.tweets[0].isReply`), the same tweet
  `refUrl` already comes from.
- `Translation` gains `isReply?: boolean` and `refUrl?: string`.
- `SaveTranslation`'s input gains `isReply?` + `refUrl?`, stored on the `Translation`.
- `translate:save` passes them from the pending `ContentItem` (and, on its saved-translation fallback
  path, reuses the values already stored on the found translation).

### 3. Review metadata only; forward-looking

- The suffix is **only** in the worksheet header and the `renderReview` header. It is **never** in the
  translated body, and `renderApproved` (Korean-only, no id header) is untouched — the approved doc
  stays clean.
- The feature applies to items translated **after it ships**. The current review folder is empty (all
  5 kept items are approved), so **no backfill** of existing data is needed. (Re-saving an old
  translation would pick up the fields if ever wanted.)

## Architecture

- **Domain** `src/domain/translation/contentItem.ts` — `ContentItem` gains `isReply?: boolean`.
- **Domain** `src/domain/translation/promptAssembler.ts` — new exported pure
  `replyAndLinkSuffix(isReply?: boolean, refUrl?: string): string`; `assembleItemBlock` appends it
  after the kind marker.
- **Domain** `src/domain/translation/models.ts` — `Translation` gains `isReply?: boolean` +
  `refUrl?: string`.
- **Domain** `src/domain/publish/renderers.ts` — `renderReview` header uses `replyAndLinkSuffix`
  (imported from `../translation/promptAssembler`; `domain/publish` already imports `domain/translation`,
  so the direction is unchanged and introduces no cycle).
- **Adapter** `src/adapters/content/XContentSource.ts` — set `isReply: first?.isReply` on the built
  `ContentItem`.
- **App** `src/app/SaveTranslation.ts` — `SaveTranslationInput` gains `isReply?` + `refUrl?`; the stored
  `Translation` carries them.
- **CLI** `src/cli/translate-save.ts` — pass `isReply`/`refUrl` from the pending item (fallback: from the
  found saved translation).
- **Tests:** `tests/domain/translation/promptAssembler.test.ts` (suffix + block header),
  `tests/domain/publish/*` (renderReview header), `tests/adapters/content/*` (XContentSource sets
  isReply), `tests/app/saveTranslation.test.ts` (stores the fields). Extend existing ones where they
  assert the affected headers.

### Data flow

```
collect → SourceTweet{isReply, url}
  → XContentSource → ContentItem{isReply, refUrl}
      → translate:prepare worksheet: ### id${[article]}${(댓글·옵셔널)}${· [원문](url)}   (assembleItemBlock)
      → translate:save → SaveTranslation → Translation{isReply, refUrl}
          → drive:publish review docs: # id${(댓글·옵셔널)}${· [원문](url)}                (renderReview)
```

## Error handling / edge cases

- **Neither field** (Lark item, or an X item missing `url`) → empty suffix → header identical to today.
- **`isReply` false** → no marker (only the link, if `refUrl`). Explicit `false` and `undefined` behave
  the same.
- **`refUrl` empty string** → treated as absent (no link). `XContentSource` only sets `refUrl` from a
  present `url`.
- **A pre-existing translation** saved before this change has no `isReply`/`refUrl` → its review doc
  renders today's header (no crash — both fields optional). Picks them up only on a re-save.
- Purely string composition; no I/O, no network.

## Testing

- `replyAndLinkSuffix`: the four cases (neither/isReply-only/refUrl-only/both) with exact pinned
  strings, including the leading space and the ` · ` separator.
- `assembleItemBlock`: an article reply with a refUrl → `### x:1 [article] (댓글·옵셔널) · [원문](u)`;
  a plain post with refUrl → `### x:2 · [원문](u)`; a Lark item (no fields) → `### lark:3` unchanged.
- `renderReview`: reply + refUrl → `# x:1 (댓글·옵셔널) · [원문](u)` header, body unchanged; no fields →
  today's `# x:1` header. Pin the whole doc string.
- `XContentSource`: a reply root tweet → `ContentItem.isReply === true` + `refUrl` set; a non-reply →
  `isReply === false`.
- `SaveTranslation`: input with `isReply`/`refUrl` → stored on the `Translation`; input without them →
  fields absent.
- All synthetic strings; no real post text or live calls.

## Non-goals

- **Article-kind marker in the review doc** — the `Translation` has no `kind`; the review doc shows
  reply + link only (the worksheet keeps its existing `[article]`).
- **Alignment worksheet** (`alignmentWorksheet.ts`) and **convert/format worksheets** — out of scope
  (Kyle's request was the translation worksheet + review doc; the align/convert sheets are separate and
  post-selection).
- **Putting the marker/link into the translated body or the approved doc** — review metadata only.
- **Backfilling** existing translations with `isReply`/`refUrl`.
- **The dashboard UI** — this is the markdown worksheet + review `.md`; a matching dashboard badge is a
  possible later slice, not this one.

## Global constraints

- Runtime deps stay **zod-only**; pure string composition, no dependency, no network.
- The suffix is additive and empty by default: items without the fields render exactly today's header
  (backward-compatible).
- Public repo: tests use synthetic ids/urls only — no real post text, handles beyond placeholders, or
  tokens.
- Every test can fail: pin the exact header/suffix strings.
