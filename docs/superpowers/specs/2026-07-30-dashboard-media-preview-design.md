# Dashboard media preview — design

Date: 2026-07-30
Status: awaiting approval

## Context

A post's photos and videos ride through the pipeline **inside the reviewed text**, as markers written
by `XContentSource.mediaMarkers()`:

```
![](https://pbs.twimg.com/media/HOUihv6bgAA52e_.jpg)   photo
[영상]                                                  video / gif
```

`src/domain/media/sourceMedia.ts` states the reason: the reviewed text is the single source of truth,
so the media has to be visible in it rather than looked up from `items.json` at send time. The markers
survive translation → conversion → format, and only `emit()` removes them (`stripMedia`) so a
destination string carries no markup. At send time `SendChannels` reads the same text twice — `emit()`
for the segments, `extractMedia()` for the photo urls — and `TypefullySender.uploadPhotos` attaches
the photos to the first post.

That works for automated sending. It does not help the reviewer:

- A reviewer sees a raw url in the text and cannot tell what the image is without opening it.
- The copy tabs (`x_paste`, `telegram_paste`, …) are already stripped, so the person pasting into X by
  hand gets no signal that a photo belongs to the post.
- `web/src` contains **no media handling at all** — verified by grep across the whole frontend.

Markers are present in real stored data today:

| Field | Screen | With markers |
| --- | --- | --- |
| `sourceText` | 1차 원문 (read-only) | 3 / 5 |
| `koreanText` | 1차 편집창 (textarea) | 3 / 5 |
| `convertedText` | 2차 변환 원문 (read-only) | 3 / 10 |

`x:2081711456320655644` carries markers across four channel renderings at status `rendered`, so the
change can be verified against live data without creating fixtures.

## Goal

Let a reviewer see the image a marker points at, by hovering the url that is already on screen —
without changing how the text is stored, sent, or edited.

## Scope

**In scope — hover preview on the two read-only "원문" panes:**

1. 1차 검수 — `TranslationDetail`'s source pane (`sourceText`).
2. 2차 검수 — `OutletCard > Source`'s converted-source pane (`convertedText`).

Both are `whitespace-pre-wrap` divs rendering a plain string, so one component serves both.

**In scope — a notice below the editing textareas** (1차 한글, 2차 채널/방 텍스트), shown *only* when
that text contains at least one marker: preview is available in the 원문 pane, not here.

**Explicitly out of scope:**

- **Editing textareas keep their current behaviour.** A `<textarea>` cannot host a hover target on a
  substring; the only way is a mirrored overlay layer, which risks caret position, scroll sync and
  Korean IME composition. The instruction was that editing must not become awkward, so the textarea
  is not touched at all.
- **Video preview.** The video marker is the literal string `[영상]` — it carries no url (see
  `mediaMarkers`, which writes only the marker for a non-photo). The thumbnail url exists in
  `output/x/items.json` but never enters the reviewed text, so there is nothing on screen to hover.
  Surfacing it would mean joining the rendering back to the collected item — a different, larger
  change. The notice tells the reviewer this instead.
- **Copy/destination tabs.** `emit()` strips markers before the destination text exists, so there is
  no url there to hover. (The paste-path gap is real but belongs to a separate change.)
- **Server, API, storage.** No route, payload, or stored field changes. The url is already in the
  string the frontend receives.

## Design

### Rendering component

A single frontend component (working name `MarkerText`) takes the stored string and returns the same
text with photo markers turned into hover targets:

- Split the string on the photo-marker pattern. Non-marker text renders unchanged, preserving
  whitespace exactly as the current `whitespace-pre-wrap` divs do.
- Each photo marker renders as its **original literal text** (`![](url)` stays visible — the url is
  what the reviewer asked to keep) wrapped in a hover-card trigger.
- The hover card follows the dashboard's existing pattern: a `group/…` wrapper with an absolutely
  positioned, `hidden … group-hover/…:block` panel. CSS only — no new state, no new dependency. The
  same pattern is already used in `ConfirmDialog`, `App` and `TranslationDetail`.
- The card contains an `<img>` for the marker url, capped at roughly the width of the pane's text
  column (~320px) so a large photo cannot cover what the reviewer is reading.
- `[영상]` markers are left as plain text — no trigger, no card.

The marker pattern must match `sourceMedia.ts`'s `PHOTO_LINE` definition, not a looser one, so the
dashboard never previews something the send path would not treat as media. The rule there is
"an empty-alt markdown image alone on its line".

### Failure handling

An image url can 404, be rate-limited, or be blocked. The card must not collapse to an empty box: on
`onError` the card shows a short failure line instead of the broken image. Nothing else on the page
depends on the image loading.

### Notice below the editing textareas

A one-line hint, rendered only when the edited text contains at least one marker, so a text without
media stays visually unchanged. It sits outside the textarea, below it, and does not alter the
textarea's size, value, or event handlers. Grid-stacked with an invisible placeholder line in the
same cell so the slot reserves that one line of height whether or not the notice has anything to say
— otherwise a marker starting or stopping to match mid-keystroke shifts every control below it.

Wording (as shipped — updated from the pre-implementation default below):

- photo markers only — `이미지 미리보기는 {where}에서 확인하세요`
- `[영상]` markers only — `영상은 미리보기가 없습니다`
- both — `이미지 미리보기는 {where}에서 확인하세요 · 영상은 미리보기가 없습니다` (the longest string the
  notice can produce, and the one that wraps to two lines below ~700px window width — accepted)

`{where}` names the pane that actually has the preview — `원문` on 1차, `변환 원문` on 2차 — with no
"위" (above)/"아래" (below) direction word. That is deliberate, not an oversight: on the 2차 board
`변환 원문` is a *collapsed* `<details>` section below the editing textarea, not an always-visible pane
above it, so a directional word would be wrong on that screen even though it would have been correct
on 1차's. The pre-implementation default below assumed "above" for both screens, which the layout
(원문 pane above the 1차 textarea, `변환 원문` collapsed below the 2차 textarea) never actually was.

Pre-implementation default (superseded by the above — kept for history):

- photo markers only — `이미지 미리보기는 위 원문에서 확인하세요`
- any `[영상]` marker present — `이미지 미리보기는 위 원문에서 확인하세요 · 영상은 미리보기가 없습니다`

## Testing

`web/tests/*.test.tsx` (jsdom + `@testing-library/react`, added in PR #93) is the harness. Per-file
`// @vitest-environment jsdom`.

Component tests:

- No marker → output text is identical to input, no hover trigger.
- One marker → the literal `![](url)` is still present in the text, and a trigger exists carrying that
  url.
- Several markers → each becomes its own trigger, in document order.
- Text around markers is preserved exactly, including blank lines.
- A `[영상]` marker produces no trigger.
- A bracketed string that is not a photo marker (e.g. `[결과 확인]`, or an image not alone on its
  line) produces no trigger.
- Image `onError` swaps in the failure line.

Notice tests:

- Marker present → notice rendered; no marker → not rendered.
- `[영상]` present → notice mentions video.

Browser verification with Playwright against `x:2081711456320655644` on both the 1차 and 2차 screens:
hover shows the image; typing in the textarea behaves exactly as before.

## Files

- `web/src/components/` — new `MarkerText` component (+ the notice, which is small enough to live
  beside it).
- `web/src/components/TranslationDetail.tsx` — source pane uses `MarkerText`; notice below the
  textarea.
- `web/src/components/OutletCard.tsx` — `Source` uses `MarkerText`; notice below the group textarea
  and below each forked room's own textarea.
- `web/src/components/MarkerText.tsx` — also exports `MediaEditNoticeSlot`, the shared
  strut-plus-notice slot every one of the three call sites above uses, so the idiom exists once.
- `web/tests/` — component tests.

No `src/` (backend) file changes.
