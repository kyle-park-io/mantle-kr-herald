# Channel format fidelity — design

**Date:** 2026-07-21
**Status:** approved
**Scope:** the §6 channel-format stage (`src/domain/formatting/`, `pnpm format`, the 2차 검수
dashboard). Make the text this stage produces correct for every place it is actually pasted or
sent — X, Typefully, Telegram (app + bot), KakaoTalk, plain-text mail — by separating *what the
post says* from *how a given destination spells it*. Delivery adapters are explicitly deferred.

## Context

`pnpm format` turns approved conversion variants into per-channel renderings. Today
`formatForChannel` (`src/domain/formatting/channelFormat.ts`) applies a destination-specific
transform and stores the **result** in `output/formatted/renderings.json`, keyed by
`(itemId, type, channel)`. The dashboard's 2차 검수 tab edits and approves that stored text.

Nothing consumes a rendering after approval. `pnpm drive:publish` publishes **translations**
(`PublishTranslations` reads `translationStore`), not renderings. The real last mile is a human
copying text out of the dashboard and pasting it into X, Typefully, the Telegram app, or KakaoTalk.

Three things are wrong with that today:

1. **The X character count is wrong for Korean.** `channelFormat.ts:35` compares
   `[...out].length` against 280. X counts by weight, and Hangul syllables weigh 2. A Korean post
   between 141 and 280 code points is over X's real limit and produces no warning.
2. **One stored text cannot serve two destinations.** Telegram-paste and Telegram-bot need
   different spellings of the same post; so do X-paste and Typefully. The current model has one
   slot per channel.
3. **`--refine` gives the writer nothing.** `assembleRefinementWorksheet` takes only the drafts;
   its entire header is two lines telling the writer to "다듬어 주세요" without saying what any
   channel's constraints are.

## Research findings

Sources checked 2026-07-21. Items marked *unverified* are recorded as such and must not be treated
as settled.

### X

- A post is limited to **280 weighted units**. `twitter-text` v3 config: `defaultWeight: 200`,
  `scale: 100`, and weight-100 ranges `U+0000–U+10FF`, `U+2000–U+200D`, `U+2010–U+201F`,
  `U+2032–U+2037`. Hangul syllables (`U+AC00–U+D7A3`) fall outside those ranges, so **each Korean
  character counts as 2** and a pure-Korean post maxes out at **140 characters**.
  (https://docs.x.com/fundamentals/counting-characters,
  https://github.com/twitter/twitter-text/blob/master/config/v3.json)
- **Any URL counts as exactly 23**, regardless of its real length or scheme (t.co wrapping).
- Counting is performed on **NFC-normalised** text. A newline is weight 100 (= 1).
- Emoji are weight 200 (= 2). Attached media count 0.
- Threads have **no documented post limit**, but a thread of 4+ collapses behind "Show this thread"
  in the timeline. (https://help.x.com/en/using-x/create-a-thread)

### Unicode bold (𝗔) is harmful — remove it

- The Unicode Consortium states characters from the Mathematical Alphanumeric Symbols block
  *"should not be used to represent styling of nonmathematical text"*, because it breaks search and
  restyling including accessibility.
  (https://www.unicode.org/versions/Unicode17.0.0/core-spec/chapter-22/)
- Screen readers **drop the styled word entirely** — a measured example inverts the meaning of
  "do not eat the shrimp" — or read the codepoint name aloud. Behaviour is non-deterministic across
  NVDA/JAWS/Narrator/VoiceOver/TalkBack. (https://adrianroselli.com/2018/01/improving-your-tweet-accessibility.html,
  https://axbom.com/dont-fake-bold-and-italic-text-with-unicode/)
- Words written in the block are **not found by X search**.
  (https://www.accessible-social.com/copy-and-formatting/alternative-characters)
- X's own accessibility guidance says to avoid special characters.
  (https://help.x.com/en/using-x/accessibility-features)
- Each such character also costs 2 weighted units.

### Telegram

- `sendMessage` accepts `parse_mode` of `MarkdownV2`, `HTML`, or legacy `Markdown`.
  (https://core.telegram.org/bots/api)
- **MarkdownV2 requires escaping 18 characters** anywhere in the text:
  `_ * [ ] ( ) ~ ` > # + - = | { } . !` — plus `\` itself, plus extra rules inside `pre`/`code`
  and inside the `(...)` of an inline link. Korean prose is full of `.`, `(`, `)`, `-`.
- **HTML mode requires escaping only `<`, `>`, `&`**, and supports `b`, `i`, `u`, `s`, `a`, `code`,
  `pre`, `blockquote`, `tg-spoiler`. For Korean body copy this is dramatically safer.
- `text` is limited to **1–4096 characters after entity parsing** (markup excluded). Entity
  offsets are UTF-16 code units; Hangul is BMP, so 1 unit each.
- Link previews are controlled by `link_preview_options`
  (`is_disabled`, `url`, `prefer_small_media`, `prefer_large_media`, `show_above_text`).
- **Whether a Telegram *client* parses Markdown on paste is not specified anywhere** — the API docs
  put parsing responsibility on each client, and Telegram's own bug tracker records client
  formatting diverging from Bot API MarkdownV2 (https://bugs.telegram.org/c/9749,
  https://bugs.telegram.org/c/2250). **Do not assume markup renders on the paste path.**

### Typefully

- **The v1 API stopped working on 2026-06-15** — already past. Its `\n\n\n\n` post separator and
  `threadify` flag are therefore unusable.
  (https://support.typefully.com/en/articles/13133296-typefully-api-v1-v2-migration-guide)
- v2 (`POST /v2/social-sets/{id}/drafts`, bearer auth) has **no separator string**: a thread is an
  explicit `posts` array (max 50, `text` max 50,000). *"No auto-threadify — you control the
  thread."* Splitting is the caller's job. (https://api.typefully.com/v2/openapi.json)
- `publish_at: "now"` is **asynchronous**: the immediate response carries
  `publish_state="in_progress"`, `status="draft"`, `published_at=null`, and that **is** the success
  response. A caller must poll `GET /drafts/{id}` until `publish_state="finished"`.
- Regular X posts take **plain text only**; markdown is accepted solely by the standalone
  `x_article` platform via `content_markdown`.
- The editor offers "Make thread" smart splitting on paste, with a user-chosen max post length.
  (https://typefully.com/changelog/automatic-thread-making-46)
- *Unverified:* that typing `---` in the editor splits a post. No first-party source; and `---` is
  defined as a **horizontal rule** in `x_article` markdown, so the two meanings conflict.

### KakaoTalk

- **No text formatting at all.** Pasted markdown is not parsed and the composer has no bold/italic.
  Verified by reading every PC release note from 25.8.0 through 26.6.0 (current) — no formatting
  feature was ever added. (https://pc.kakao.com/talk/notices/ko?agent=win32)
  *Caveat:* Kakao publishes no page that states "markdown unsupported"; this is an argument from
  exhaustive release notes plus an open feature request
  (https://devtalk.kakao.com/t/topic/128154). Blog posts claiming `*bold*` works in 26.5.0+ were
  checked against the official notices and the claimed text does not exist there.
- **A message longer than 500 characters collapses behind a 「전체보기」 button.** Kakao's own CS
  spec: *"단일형 버튼 미사용시 : 1,000자(500자 초과시 전체보기 버튼을 통해 확인가능)"*
  (https://cs.kakao.com/helps_html/1073201585?locale=ko)
- URLs are auto-linked with an Open Graph preview.

### Plain-text mail

- RFC 5322 §2.1.1: each line **MUST** be ≤ 998 characters and **SHOULD** be ≤ 78, excluding CRLF.
  RFC 5321 §4.5.3.1.6 enforces 1000 **octets** including CRLF — and UTF-8 Hangul is 3 octets per
  syllable, so 998 octets ≈ 332 Korean characters. Display wrapping and the hard limit are
  different units. (https://www.rfc-editor.org/rfc/rfc5322.txt,
  https://www.rfc-editor.org/rfc/rfc5321.txt)
- Korean subjects need RFC 2047 encoded-words (`=?UTF-8?B?...?=`), max 75 chars per encoded-word,
  ≈ 15 Korean characters each. This is a *sending* concern, not a *paste* concern.
- Plain-text-only mail carries no documented deliverability penalty; SpamAssassin penalises
  HTML-only (`MIME_HTML_ONLY`) but has no plain-only counterpart.

## Decisions (locked in brainstorming)

- **Approval stays per channel, once.** `renderings.json` keeps its `(itemId, type, channel)`
  identity and the dashboard's approve flow is untouched. Destination spellings are derived, never
  stored and never separately approved.
- **`renderings.json` stores canonical text**, not destination-transformed text.
- **Six destinations:** `x_paste`, `x_typefully`, `telegram_paste`, `telegram_bot`, `kakao_paste`,
  `pr_mail`.
- **This spec stops at format fidelity.** No Telegram bot sender, no Typefully API, no X API.
- **The human decides where a thread breaks**, in `--refine`. Code reports exact overage; it never
  cuts Korean prose on a guessed sentence boundary.
- **No emitter splits text automatically** (extended from the thread decision — see §3.1).
- **Unicode bold is removed**, not made opt-in.
- **Telegram bot output uses HTML mode**, not MarkdownV2.
- **Emitter logic lives only in `src/domain`**; the dashboard calls the server rather than
  duplicating it, following the existing "mirror types, not logic" convention in `web/src/types.ts`.
- **Glossary injected into the refine worksheet is filtered** to terms appearing in the draft.
- **The weighted counter is implemented in-repo**, not by adding the `twitter-text` dependency.

## Design

### 1. Canonical rendering

`ChannelRendering.text` becomes the semantic source of truth. Its vocabulary:

| Markup | Meaning |
|---|---|
| `**text**` | bold |
| `[text](url)` | link |
| one blank line | paragraph break |
| **two or more blank lines** | **post boundary** (`x` channel only) |
| `---` alone on a line | post boundary (alternate spelling, `x` channel only) |

`---` reconciles the pipeline's pre-existing thread separator with canonical text: `XContentSource`
has joined collected tweets with `"\n\n---\n\n"` since before canonical text existed, so it is
already present in every saved translation, and it is the team's own drafting convention for
marking a tweet boundary. `toCanonical` folds a `---` line (with any blank lines around it) into the
same `\n\n\n` boundary as two blank lines, so canonical text itself never contains a literal `---` —
there is still exactly one boundary representation once canonicalisation has run.

Nothing else is meaningful. Writers never type destination syntax — no `*telegram bold*`, no
`<b>`, no unicode bold.

`formatForChannel(text, channel, opts)` is replaced by **`toCanonical(text)`** — no channel, no
options. Canonicalisation is channel-independent by definition: it trims and collapses runs of
blank lines, nothing more. The current `collapseBlankLines` replaces `\n{3,}` with `\n\n`, which
would destroy every post boundary; it becomes `\n{4,}` → `\n\n\n`, preserving exactly one boundary
marker.

Everything `formatForChannel` did per channel moves to the emitters, including `pr_mail`'s
`제목: ` first-line lift — that is a destination spelling, not a fact about the post.

`FormatVariants` therefore stores the *same* canonical text for every channel a type fans out to.
That is intentional, not redundant: the writer can then refine the Telegram copy separately from
the Kakao copy from a common starting point, which is exactly what per-channel approval is for.
Its `warnings` now come from running `emit()` over `DESTINATIONS_BY_CHANNEL[channel]`.

**Migration:** none. `output/` is gitignored local working data and `variants.json` is the upstream
source, so existing renderings are regenerated by re-running `pnpm format`. This is recorded in
the plan as an operator step, not as code.

### 2. `weightedLength.ts`

New module `src/domain/formatting/weightedLength.ts` — the fix for the counting bug, isolated so it
can be tested hard.

```ts
const WEIGHT_100_RANGES: readonly (readonly [number, number])[] = [
  [0x0000, 0x10ff], [0x2000, 0x200d], [0x2010, 0x201f], [0x2032, 0x2037],
];
export const X_MAX_WEIGHTED = 280;
export const TCO_LENGTH = 23;

export function weightedLength(text: string): number;
```

Algorithm:

1. Normalise to **NFC**.
2. Replace each `https?://\S+` match with a fixed contribution of `TCO_LENGTH * 100` weight.
3. For every remaining code point, add 100 if it falls in a weight-100 range, else 200.
4. Return `total / 100`.

**Known limitation, to be recorded in a code comment:** `twitter-text`'s real extractor also
recognises scheme-less URLs (`example.com`), which this regex misses, so such text is
under-counted. Canonical text writes links as `[text](url)` with an explicit scheme, so this is
acceptable; adding the `twitter-text` package remains the escape hatch if it ever bites.

### 3. Emitters

New directory `src/domain/formatting/emitters/`, one module per destination plus an `index.ts`:

```ts
export type Destination =
  | "x_paste" | "x_typefully"
  | "telegram_paste" | "telegram_bot"
  | "kakao_paste" | "pr_mail";

export interface EmitSegment {
  text: string;
  /** Position label, e.g. "트윗 2/3". Absent when there is only one segment. */
  label?: string;
  /** Weighted units for x, characters for telegram/kakao, worst line in octets for pr_mail. */
  length: number;
  limit: number;
  overLimit: boolean;
}
export interface EmitResult { segments: EmitSegment[]; warnings: string[] }

export function emit(canonical: string, destination: Destination): EmitResult;

/** A rendering is already channel-scoped, so only these destinations apply to it. */
export const DESTINATIONS_BY_CHANNEL: Record<Channel, Destination[]> = {
  x: ["x_paste", "x_typefully"],
  telegram: ["telegram_paste", "telegram_bot"],
  kakao: ["kakao_paste"],
  pr_mail: ["pr_mail"],
};
```

Shared canonical helpers (`stripBold`, `linksToPlain`, `splitPosts`) move next to the emitters so
each emitter file stays small and readable on its own.

#### 3.1 Segments come only from the writer

`segments.length > 1` **only** when the writer placed post boundaries in canonical text (the `x`
channel). No emitter ever splits on a length threshold.

This extends the approved "the human decides where a thread breaks" rule to Telegram's 4096 and
Kakao's 500. The reasoning is the same in all three cases: a machine cut in Korean prose lands
badly, and a cut made silently at emit time would never be reviewed by anyone. Every limit
produces a **warning** instead. Telegram's 4096 is a hard API limit on the send path, so the
delivery spec must decide a strategy there; within this spec's scope (produce correct text, human
sends it) a warning is the correct behaviour.

#### 3.2 Per-destination rules

| Destination | Bold | Links | Segments | Limit check |
|---|---|---|---|---|
| `x_paste` | stripped | `text (url)` | post boundaries | `weightedLength` per segment vs 280 |
| `x_typefully` | stripped | `text (url)` | post boundaries | same as `x_paste` |
| `telegram_paste` | stripped | `text (url)` | single | warn over 4096 chars |
| `telegram_bot` | `<b>…</b>` | `<a href="…">…</a>` | single | warn over 4096 chars (post-parse length) |
| `kakao_paste` | stripped | `text (url)` | single | warn over 500 chars (「전체보기」 fold) |
| `pr_mail` | stripped | `text (url)` | single | warn if any line exceeds 998 **octets** |

`x_typefully` is currently identical to `x_paste`; it exists as a distinct destination because the
editor's paste behaviour is unverified (see *Unverified* below) and because the v2 API path will
need it. Keeping it separate now means that verification changes one file.

**`telegram_bot` escaping order matters:**

1. Escape the whole canonical string: `&` → `&amp;`, then `<` → `&lt;`, `>` → `&gt;`.
2. *Then* convert `**text**` → `<b>text</b>` and `[text](url)` → `<a href="url">text</a>`.

Escaping first is safe because HTML escaping never introduces `*`, `[`, `]`, `(` or `)`, and it
guarantees `&` inside a URL query string is escaped too. The emitted string is intended for
`sendMessage` with `parse_mode: "HTML"`; the delivery spec must use that mode and nothing else.

**`pr_mail`** keeps the current behaviour of lifting the first line into `제목: `, and does **not**
hard-wrap. RFC 5322's 78-character SHOULD applies to mail actually put on the wire; text pasted
into Gmail or Outlook is re-wrapped by the client, and pre-wrapping produces ragged output there.
The 998-octet MUST is still checked, because it is a hard limit and Korean reaches it at ~332
characters per line. Subject encoding (RFC 2047) belongs to the delivery spec.

### 4. Refinement worksheet

`assembleRefinementWorksheet` gains a generated header and per-segment reporting.
`PrepareRefinements` gains a `GlossaryStore` dependency (the same port `PrepareTranslations`
already uses — no new config file, no new root directory).

Every number in the header is produced from the same constants the emitters use, so the worksheet
cannot drift from the code.

```markdown
# Mantle KR 채널 포매팅 보정 작업

## 쓰는 법
- 볼드는 `**이렇게**`, 링크는 `[텍스트](URL)`로 씁니다. 목적지별 문법 변환은 코드가 합니다.
- x 채널에서 **빈 줄 두 개 = 트윗 경계**입니다.
- 유니코드 볼드(𝗔)는 쓰지 마세요 — 스크린리더가 단어를 통째로 건너뜁니다.

## 채널 제약
- x: 트윗당 280 가중치 (**한글·이모지는 2**, 그 외 1, URL은 길이 무관 23)
- telegram: 메시지당 4096자
- kakao: **500자 초과 시 말풍선이 「전체보기」로 접힙니다**
- pr_mail: 첫 줄이 제목

## 용어집 (초안에 등장하는 것만)
- Mantle → 맨틀
- mETH → 원문 유지

## x:2077031032432599389 · X 게시물 · x
⚠ 트윗 1/1 — **412/280** (132 초과). 스레드로 나누어 주세요.

초안:
…

보정:
```

The constraint list shows only the channels present in the batch. The glossary section is omitted
entirely when no glossary term appears in any draft.

### 5. Dashboard

`web/src/types.ts` deliberately mirrors backend types with a "keep in sync" comment, and
`web/tsconfig.json` includes only `web/src`. Emitters are therefore **not** imported by the
frontend; the server emits.

```
GET /api/renderings/{encodeURIComponent(itemId)}/{type}/{channel}/emissions
  → Partial<Record<Destination, EmitResult>>
    // a telegram rendering returns { telegram_paste, telegram_bot } and nothing else
```

The response carries **only the destinations of that rendering's channel**
(`DESTINATIONS_BY_CHANNEL`) — a `kakao` rendering has no meaningful `telegram_bot` spelling, and
which channels a type fans out to was already decided upstream by `DEFAULT_CHANNELS_BY_TYPE`.

This matches the existing rendering routes exactly: `apiHandlers.ts` already identifies a rendering
by three path segments and `web/src/api.ts` already builds that path with
`encodeURIComponent(itemId)` (the `rPath` helper), so the `:` in `itemId` is a solved problem.
A `GET` is correct here because emission is a pure read. Every applicable destination comes back in
one call so the copy buttons respond instantly. `Destination` and `EmitResult` are mirrored into
`web/src/types.ts` with the usual sync comment.

`RenderingDetail.tsx` gains a destination tab strip above a segment list, showing only the tabs the
response returned. For an `x` rendering:

```
[ X 붙여넣기 ] [ Typefully ]

트윗 1/3  118/280   [복사]
트윗 2/3  241/280   [복사]
트윗 3/3  301/280 ⚠ [복사]        [전체 복사]
```

A `kakao` rendering shows a single `[ 카카오 ]` tab with one segment.

The editor textarea continues to edit canonical text and the approve button is unchanged.
Emissions are re-fetched after a successful save.

### 6. Removals

- `boldToUnicode` and `FormatOptions.xBold` are deleted from `src/domain/formatting/`.
- The `--x-bold unicode` flag is removed from `src/cli/format.ts`. Passing it now fails with an
  explicit message naming the accessibility reason rather than being silently ignored.

## Execution order

1. `weightedLength.ts` + tests. Nothing depends on the rest; lands the bug fix first.
2. Canonical normalisation in `channelFormat.ts` (`\n{4,}` collapse, remove unicode bold and
   `FormatOptions`), and `splitPosts`.
3. Emitters + `emit()` + tests.
4. `refinementWorksheet.ts` header/report + `PrepareRefinements` glossary injection + tests.
5. `src/cli/format.ts`: drop `--x-bold`, report per-segment overage in console output.
6. `POST /api/renderings/emissions` in `apiHandlers.ts` + test.
7. `RenderingDetail.tsx` destination tabs and copy buttons.
8. Docs: `docs/ko/artifacts.md` (§3 command I/O for `format`, §6 loss table),
   `docs/ko/capabilities.md` (§3 채널 → 목적지, §4 revised limits), `CHANGELOG.md`.

## Testing

New tests live in `tests/domain/formatting/`, beside the existing `channelFormat.test.ts`.

- **`weightedLength.test.ts`** carries the most weight, since this is the regression that started
  the work: Korean at 140 and 141 characters, ASCII at 280 and 281, a 5-character URL and a
  200-character URL both counting 23, emoji counting 2, newline counting 1, and NFC equivalence
  (decomposed `가` counting the same as precomposed).
- **`emitters/*.test.ts`** — golden output per destination. `telegram_bot` specifically asserts
  that `<`, `>`, `&` are escaped, that `&` inside a URL query string is escaped, and that Korean
  full stops, parentheses and hyphens pass through untouched (the MarkdownV2 trap this design
  avoids).
- **`channelFormat.test.ts`** extended: three blank lines survive normalisation as a post
  boundary, four or more collapse to exactly one boundary, and no destination syntax leaks into
  canonical output.
- **`PrepareRefinements.test.ts`** extended: header carries the constraint list for the channels in
  the batch, the glossary section contains only terms present in the drafts and disappears when
  none are, and an over-limit draft reports the correct segment index and overage.
- **`tests/adapters/web/`** — the emissions route returns all six destinations and 404s for an
  unknown rendering key.

`pnpm test` and `pnpm typecheck` must pass; `pnpm typecheck:web` covers the dashboard change.

## Out of scope

- **All delivery adapters** — Telegram Bot API, Typefully v2, X API. The next spec builds on this
  one; the research above (async `publish_at`, HTML parse mode, 4096 hard limit) is recorded here
  so that spec does not have to rediscover it.
- **Lark as a channel.** Lark remains a collection source and a Drive target only.
- **Automatic thread splitting.** Deliberately rejected; the writer splits.
- **RFC 2047 subject encoding and format=flowed** — sending concerns, not pasting concerns.
- **X Premium long posts (25,000 chars) and Articles.** The 280-weight limit is what the account
  actually operates under.

## Unverified — must be checked live before relying on it

1. **Typefully editor paste behaviour.** Whether the editor preserves our post boundaries, and
   whether `---` splits a post, is not documented by Typefully. `x_typefully` therefore ships
   identical to `x_paste`. Verification is a manual step: paste a three-post canonical draft into
   Typefully and observe. Adjust one emitter file with the result.
2. **Telegram client paste rendering.** Assumed to render nothing; `telegram_paste` emits plain
   text. If a client is later confirmed to parse something, that is an enhancement, not a fix.
3. **KakaoTalk hard character ceiling.** Only the 500-character fold is documented. If a hard limit
   exists it is undocumented; the emitter warns at 500 and nothing else.
