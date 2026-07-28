# Commenter-reply inline marker + review-doc spacing — design

Date: 2026-07-28
Status: approved for planning
Scope: two review-doc/worksheet refinements. (1) Prefix **thread-internal commenter-reply tweets** —
a reply Mantle made to someone else's comment, bundled into a thread by conversationId — with an
inline marker `(댓글 · 지워도 됨)` so a reviewer knows that segment is optional/deletable. (2) Add one
blank line between the `## 원문 (source)` content and the `## 한글 (Korean)` heading in the review `.md`.
Follows PR #66 (item-level `(댓글·옵셔널)` header marker), which only marks items whose **root** tweet is
a reply and therefore misses reply tweets nested inside a thread.

## Context

A thread is assembled by `conversationId`, so when Mantle posts an announcement and then replies to
commenters, those replies get bundled into the same item. Example — `x:2081748977918337053`:

```
t0 (root)  "24/7 access to capital markets…"        isReply=false   ← the announcement
t1         "@Aceonblockchain Mom knows"             isReply=true    ← reply to a commenter (noise)
t2         "@churchi_blaq 🫡"                        isReply=true    ← reply to a commenter (noise)
```

PR #66's marker is **item-level** (`ContentItem.isReply` = the root tweet's `isReply`), so this item —
whose root is a normal post — gets no marker, and the nested commenter-replies go unflagged. That is
the gap.

**`isReply` alone is not enough** to find them: a *self-thread continuation* is also `isReply=true`.
`x:2080661810034917770`'s second tweet `"Come Saturday… Trade here: fluxion.network/trade"` is
`isReply=true` but is legitimate content (Mantle continuing its own thread), not noise. The
distinguishing signal is that a reply **to someone else** starts with an `@handle` mention, while a
self-continuation does not. So the target is a tweet that is **`isReply` AND whose text starts with
`@`** — and, to avoid double-marking a standalone reply item (already handled by PR #66's header
marker), only a **non-root** tweet (index > 0) in the thread.

## Decisions

### 1. Inline marker on non-root commenter-reply tweets, injected in `XContentSource`

In `XContentSource.loadPending`, where thread tweets are joined into `ContentItem.text`, prefix each
tweet that is a **commenter-reply** with the marker + a space:

- **Commenter-reply** = `index > 0 && tweet.isReply && tweet.text.trimStart().startsWith("@")`.
- Marker = `COMMENTER_REPLY_MARKER = "(댓글 · 지워도 됨)"` (module constant).
- Result: the tweet renders as `(댓글 · 지워도 됨) @churchi_blaq 🫡` inside the joined `text`.

Because the marker goes into `ContentItem.text` (→ the translation worksheet's 원문, and
`Translation.sourceText` → the review `.md`'s 원문), it shows at **both** human-judgment surfaces with
no change to the renderers. The root tweet (index 0) is never inline-marked: a standalone reply item
whose root is a commenter-reply is already flagged by PR #66's header `(댓글·옵셔널)`, so the two
mechanisms do not overlap.

The marker lives in the **원문 (source)** only, not the 한글. The review `.md`'s 원문 and 한글 are
structurally aligned (both are the thread's tweets in order, `---`-separated), so a reviewer reading
`(댓글 · 지워도 됨)` on a 원문 tweet knows the correspondingly-positioned 한글 line is the deletable one.
Keeping it out of the 한글 avoids any risk of the marker leaking into published content.

### 2. One blank line between 원문 and 한글 in `renderReview`

`renderReview` currently renders `…${sourceText}\n\n## 한글 (Korean)\n\n${koreanText}\n`. Add one blank
line between the source content and the `## 한글 (Korean)` heading:
`…${sourceText}\n\n\n## 한글 (Korean)\n\n${koreanText}\n`. `renderApproved` is untouched.

## Architecture

- **Adapter** `src/adapters/content/XContentSource.ts` — add `COMMENTER_REPLY_MARKER` and a small
  `isCommenterReply(tweet)` predicate; the join `.map` gains the tweet index and prefixes the marker on
  non-root commenter-replies. `ContentItem.isReply`/`refUrl` (PR #66) are unchanged.
- **Domain** `src/domain/publish/renderers.ts` — `renderReview` gains one `\n` between `sourceText` and
  `## 한글 (Korean)`.
- **Tests:** extend `tests/adapters/content/*` (marker on a nested commenter-reply; NOT on a
  self-continuation reply like "Come Saturday…"; NOT on a root commenter-reply); extend
  `tests/domain/publish/renderers.test.ts` (the new blank line).

### Data flow

```
XContentSource.loadPending: thread.tweets.map((t, i) =>
    (i > 0 && t.isReply && t.text.trimStart().startsWith("@"))
      ? `(댓글 · 지워도 됨) ${rendered}` : rendered
  ).join("\n\n---\n\n")   → ContentItem.text
     → worksheet 원문 (assembleItemBlock)  and  Translation.sourceText → review .md 원문 (renderReview)
```

## Error handling / edge cases

- **Root tweet** (index 0) — never inline-marked, even if it is a commenter-reply (PR #66's header
  marker owns that case).
- **Self-thread continuation** (`isReply` but no leading `@`, e.g. "Come Saturday…") — not marked;
  it is legitimate content.
- **Article tweet** that is also a commenter-reply — `renderTweetText` renders it first; the marker
  prefixes the rendered result. (In practice articles are roots, so this is moot, but the ordering is
  defined.)
- **Lark items** — `isReply`/text-shape logic is X-only; Lark threads are unaffected (single messages,
  no `@`-reply convention here).
- Purely string composition at load time from the existing `items.json`; **no re-collect needed** — the
  marker is injected at `prepare` time, so re-preparing an already-collected item picks it up.

## Testing

- `XContentSource`: a thread `[root(post), reply("@x hi"), reply("@y 🫡")]` → `text` has
  `(댓글 · 지워도 됨) @x hi` and `(댓글 · 지워도 됨) @y 🫡`, and the root is unmarked. A thread
  `[root, reply("Come Saturday…")]` (leading text, no `@`) → the continuation is **unmarked**. A
  single-tweet item whose root is `@handle`-reply → **unmarked** inline (index 0). Pin the exact
  joined string for a small case.
- `renderReview`: the doc has exactly one blank line between the last source line and `## 한글
  (Korean)` (i.e. `\n\n\n`). Pin the header/section bytes.
- All synthetic strings; no real post text; no live calls.

## Non-goals

- **Changing PR #66's item-level header marker** or its wording (`(댓글·옵셔널)`). It stays for
  standalone reply items; this inline marker (`(댓글 · 지워도 됨)`) is for thread-internal replies. The
  two wordings differing is acceptable (different granularity/location); unifying them is out of scope.
- **Dropping** commenter-reply tweets from translation — Kyle chose keep-and-mark (option A), not drop.
- **Marking the 한글** side or putting the marker into published content.
- **`inReplyToUserId`-based detection** — the schema has no such field; the leading-`@` heuristic is the
  signal, and it matches the observed data.
- **convert/format worksheets, the dashboard** — same boundary as PR #66.

## Global constraints

- Runtime deps stay **zod-only**; pure string composition, no dependency, no network.
- Additive: a thread with no commenter-replies renders exactly today's `text`; the review-doc blank
  line is the only format change and does not alter content.
- Review metadata only: the marker is in the 원문 source shown for review, never in the 한글 or the
  approved doc.
- Public repo: tests use synthetic handles/text only.
- Every test can fail: pin the exact marked string and the review-doc spacing.
