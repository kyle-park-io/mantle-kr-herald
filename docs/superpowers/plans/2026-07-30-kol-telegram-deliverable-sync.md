# KOL Telegram deliverable sync Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Sweep contracted KOLs' public Telegram channels each month and upsert one row per Mantle-mentioning post into a machine-owned `kol-telegram-posts` tab of the team's Q3 workbook, so the `Deliverable Link` / views / engagement columns stop being typed by hand.

**Architecture:** Mirrors the existing `metrics:record` pipeline exactly. A pure parser turns a captured `t.me/s/<handle>` page into `ChannelPost[]`; a thin gateway adds fetching and backwards pagination; pure domain functions decide candidacy and attribution; one app service orchestrates the sweep and the upsert; a CLI wires it. All HTML knowledge is confined to one parser file, all HTTP to one adapter.

**Tech Stack:** TypeScript (ESM, `tsx`), vitest, Google Sheets REST v4 via the existing `GoogleSheetClient`, no new runtime dependencies, no new environment variables.

## Global Constraints

- **Spec:** `docs/superpowers/specs/2026-07-30-kol-telegram-deliverable-sync-design.md`. Read it before Task 1; it carries the measured evidence every expectation below is derived from.
- **No new env var.** `GSHEET_ID` already resolves to the live `2026 Q3 KR Work Sheet`. Do not add one, do not touch `.env.example`.
- **No new dependency.** No HTML-parsing library. Regex over the captured markup, in one file, locked by fixtures. The repo already establishes this pattern — `src/adapters/twitterapi/expandUrls.ts` is regex over markup with a pure-function test.
- **Code, comments, commits, and PR titles in English.** Docs under `docs/ko/` in Korean.
- **The machine never writes a human tab.** `Jul.`/`Aug.`/`Sep.`, ` Q3 KOL 계약 리스트`, and `KOL list` are read-only to this feature. Only `kol-telegram-posts` is written.
- **The machine never overwrites a human's cell.** On re-run, only `views`, `engagements`, `reactionsDetail`, `fetchedAt` are refreshed. `topic` and `confirmed` are preserved once non-empty.
- **Similarity threshold is `0.30`**, character 3-gram Jaccard, on text normalized to strip whitespace, emoji, and URLs.
- **Candidate keywords** are `맨틀`, `mantle` (case-insensitive), and `MNT` word-boundary matched.
- **Tab and column names are load-bearing.** `kol-telegram-posts` columns A–M in the order given in Task 1. `kol-map` columns A–E. Renaming a column silently breaks the upsert key or a human's confirmed verdict.
- **`pnpm typecheck` covers `tests` as well as `src`** (`tsconfig.json` includes both). Test fixtures must satisfy the real interfaces — vitest runs untypechecked, so a wrong shape passes the test run and fails the build.
- **Another session is active in this working tree.** Stage only the files each task's commit lists; never `git add -A`. Runtime state under `output/` belongs to that session and must not be committed.

---

## File Structure

**Created:**

| File | Responsibility |
| --- | --- |
| `src/domain/kol/models.ts` | `ChannelPost`, `KolMapEntry`, `KolTelegramRow`, the two header constants |
| `src/domain/kol/candidacy.ts` | `isMantleCandidate(text)` — pure keyword test |
| `src/domain/kol/attribution.ts` | `normalizeForMatch`, `similarity`, `bestMatch` — pure |
| `src/domain/kol/reactions.ts` | `sumReactions`, `formatReactions` — pure |
| `src/adapters/telegram/parseChannelPreview.ts` | Pure: raw `t.me/s/` HTML → `ChannelPost[]`. The only file that knows Telegram markup |
| `src/adapters/telegram/TmePreviewGateway.ts` | Fetch + `?before=` pagination + month-window stop condition |
| `src/ports/TelegramChannelGateway.ts` | Port interface |
| `src/app/LoadKolMap.ts` | Reads the `kol-map` tab into `KolMapEntry[]` |
| `src/app/RecordKolTelegramPosts.ts` | Orchestrates sweep → detect → attribute → upsert |
| `src/app/telegramMatchCandidates.ts` | Selects which approved renderings are eligible match candidates |
| `src/cli/kol-telegram-record.ts` | CLI entry |
| `tests/adapters/telegram/fixtures/*.html` | Three unmodified captured pages — the parser's contract |

**Modified:**

| File | Change |
| --- | --- |
| `src/domain/metrics/handles.ts` | Add `extractTelegramHandle` beside `extractXHandle` |
| `package.json` | Add the `kol-telegram:record` script |
| `docs/ko/capabilities.md` | Capability table row + prose section |
| `docs/ko/artifacts.md` | Local-mode skip list + the detailed I/O table |
| `docs/ko/team-runbook.md` | Operator instructions |

**Why this split:** the parser is the only part likely to break from outside (Telegram markup changes), so it is one file with no dependencies and a fixture-locked test. Candidacy, attribution, and reaction arithmetic are pure and separately reviewable. Fetching and pagination are the only I/O in the read path. This is the same layering `metrics:record` uses: `expandUrls`/`aggregate` pure, `TwitterApiSourceGateway` I/O, `RecordMetrics` orchestration.

---

### Task 1: Domain models, headers, and Telegram handle extraction

**Files:**
- Create: `src/domain/kol/models.ts`
- Modify: `src/domain/metrics/handles.ts`
- Test: `tests/domain/kol/models.test.ts`, `tests/domain/metrics/handles.test.ts` (extend)

**Interfaces:**
- Consumes: nothing.
- Produces:
  ```ts
  export interface ChannelPost {
    handle: string;
    messageId: number;
    url: string;                 // https://t.me/<handle>/<messageId>
    postedAt: string;            // ISO 8601, e.g. "2026-07-03T09:14:45.000Z"
    views: number;
    reactions: { emoji: string; count: number }[];
    text: string;                // "" when the post has no text (photo-only)
  }

  export interface KolMapEntry {
    kolId: string;
    tgHandle: string;
    sheetLabel: string;
    pricePerPost: number;
    active: boolean;
  }

  export interface KolTelegramRow {
    kolId: string;
    tgHandle: string;
    postedAt: string;
    deliverableLink: string;
    views: number;
    engagements: number;
    reactionsDetail: string;
    itemId: string;
    topic: string;
    matchScore: string;          // "" or a 2-decimal string, e.g. "0.42"
    pricePerPost: string;
    fetchedAt: string;
    confirmed: string;           // "" | "paid" | "organic" | "reject"
  }

  export const KOL_TELEGRAM_HEADER: string[];  // 13 entries, A–M
  export const KOL_MAP_HEADER: string[];       // 5 entries, A–E
  export function extractTelegramHandle(link: string): string | undefined;
  ```

- [ ] **Step 1: Write the failing tests**

`tests/domain/kol/models.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { KOL_TELEGRAM_HEADER, KOL_MAP_HEADER } from "../../../src/domain/kol/models";

describe("kol sheet headers", () => {
  it("pins the kol-telegram-posts column order (A-M)", () => {
    expect(KOL_TELEGRAM_HEADER).toEqual([
      "kolId", "tgHandle", "postedAt", "deliverableLink", "views", "engagements",
      "reactionsDetail", "itemId", "topic", "matchScore", "pricePerPost", "fetchedAt", "confirmed",
    ]);
  });

  it("pins the kol-map column order (A-E)", () => {
    expect(KOL_MAP_HEADER).toEqual(["kolId", "tgHandle", "sheetLabel", "pricePerPost", "active"]);
  });

  it("keeps deliverableLink at column D, the upsert key", () => {
    expect(KOL_TELEGRAM_HEADER.indexOf("deliverableLink")).toBe(3);
  });
});
```

Append to `tests/domain/metrics/handles.test.ts`:

```ts
import { extractTelegramHandle } from "../../../src/domain/metrics/handles";

describe("extractTelegramHandle", () => {
  it("reads a plain channel url", () => {
    expect(extractTelegramHandle("https://t.me/marshallog")).toBe("marshallog");
  });

  it("trims the stray whitespace the rate table actually contains", () => {
    // Both of these are real cell values in ' Q3 KOL 계약 리스트'.
    expect(extractTelegramHandle(" https://t.me/marshallog")).toBe("marshallog");
    expect(extractTelegramHandle("https://t.me/airdr0p_lab ")).toBe("airdr0p_lab");
  });

  it("reads the /s/ preview form", () => {
    expect(extractTelegramHandle("https://t.me/s/Raoni1")).toBe("Raoni1");
  });

  it("keeps handle case, since t.me paths are case-sensitive in practice", () => {
    expect(extractTelegramHandle("https://t.me/WeCryptoTogether")).toBe("WeCryptoTogether");
  });

  it("accepts a bare @handle", () => {
    expect(extractTelegramHandle("@coinboys")).toBe("coinboys");
  });

  it("ignores a trailing path, query, or fragment", () => {
    expect(extractTelegramHandle("https://t.me/GMBLABS/123")).toBe("GMBLABS");
    expect(extractTelegramHandle("https://t.me/GMBLABS?x=1")).toBe("GMBLABS");
  });

  it("rejects a non-telegram link, an invite link, and an empty cell", () => {
    expect(extractTelegramHandle("https://x.com/marshallog")).toBeUndefined();
    expect(extractTelegramHandle("https://t.me/+AbCdEf")).toBeUndefined();
    expect(extractTelegramHandle("")).toBeUndefined();
  });
});
```

- [ ] **Step 2: Run to verify they fail**

Run: `pnpm vitest run tests/domain/kol/models.test.ts tests/domain/metrics/handles.test.ts`
Expected: FAIL — cannot resolve `src/domain/kol/models`, and `extractTelegramHandle` is not exported.

- [ ] **Step 3: Implement**

Read `src/domain/metrics/handles.ts` first and follow its shape exactly — same doc-comment style, same trim-then-match-then-fallback structure, returning `undefined` rather than throwing.

Invariants:
- The two header constants are the single source of column order; nothing else in the codebase may hardcode a column letter derived from them. `src/domain/sheet/models.ts` shows the established convention, including its comment explaining *why* a column order is load-bearing — write an equivalent one here.
- `extractTelegramHandle` trims, accepts `t.me/<handle>`, `t.me/s/<handle>`, and `@handle`, stops at `/`, `?`, or `#`, and preserves case. Telegram handles are 5–32 characters of `[A-Za-z0-9_]`; an invite link (`t.me/+…`) or a `joinchat` path is not a handle.
- It takes only a link, unlike `extractXHandle` which also takes a platform column — `kol-map`'s handle column has no sibling platform column.

- [ ] **Step 4: Run to verify they pass**

Run: `pnpm vitest run tests/domain/kol/models.test.ts tests/domain/metrics/handles.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/domain/kol/models.ts src/domain/metrics/handles.ts tests/domain/kol/models.test.ts tests/domain/metrics/handles.test.ts
git commit -m "feat(kol): add Telegram post models, sheet headers, and handle extraction"
```

---

### Task 2: Capture the fixtures and write the pure preview parser

**Files:**
- Create: `src/adapters/telegram/parseChannelPreview.ts`
- Create: `tests/adapters/telegram/fixtures/marshallog-before-22800.html`, `enjoymyhobby-before-96565.html`, `Raoni1-before-20920.html`
- Test: `tests/adapters/telegram/parseChannelPreview.test.ts`

**Interfaces:**
- Consumes: `ChannelPost` from Task 1.
- Produces: `export function parseChannelPreview(html: string, handle: string): ChannelPost[];`
  Returns posts in document order. Never throws on malformed markup — a block it cannot read is skipped.

- [ ] **Step 1: Capture the three fixtures**

These pages are historical (`?before=` a fixed message id), so they are reproducible. Capture them **unmodified** — a hand-edited fixture stops being evidence of what Telegram actually serves.

```bash
mkdir -p tests/adapters/telegram/fixtures
curl -sL --max-time 30 -A "Mozilla/5.0" "https://t.me/s/marshallog?before=22800"    -o tests/adapters/telegram/fixtures/marshallog-before-22800.html
curl -sL --max-time 30 -A "Mozilla/5.0" "https://t.me/s/enjoymyhobby?before=96565" -o tests/adapters/telegram/fixtures/enjoymyhobby-before-96565.html
curl -sL --max-time 30 -A "Mozilla/5.0" "https://t.me/s/Raoni1?before=20920"       -o tests/adapters/telegram/fixtures/Raoni1-before-20920.html
grep -c 'tgme_widget_message_views' tests/adapters/telegram/fixtures/*.html
```

Each file must contain at least one `tgme_widget_message_views`. If a page comes back empty, the channel has gone private — stop and report it rather than substituting another channel, because the expected values below are tied to these three posts.

**View counts grow.** The expectations in Step 2 are what these pages served on 2026-07-30. If you re-capture later and a count has moved, update the expectation to match the committed file and say so in the commit message. Never edit the HTML to match the test.

- [ ] **Step 2: Write the failing test**

`tests/adapters/telegram/parseChannelPreview.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { parseChannelPreview } from "../../../src/adapters/telegram/parseChannelPreview";
import type { ChannelPost } from "../../../src/domain/kol/models";

const fixture = (name: string) => readFileSync(join(__dirname, "fixtures", name), "utf8");
const find = (posts: ChannelPost[], id: number) => posts.find((p) => p.messageId === id);

describe("parseChannelPreview", () => {
  it("reads the post cross-checked against the sheet's July row for Marine", () => {
    // Sheet Jul. r12 recorded views 2800 / engagements 3 for this link.
    const post = find(parseChannelPreview(fixture("marshallog-before-22800.html"), "marshallog"), 22794);
    expect(post).toBeDefined();
    expect(post!.url).toBe("https://t.me/marshallog/22794");
    expect(post!.postedAt).toBe("2026-07-03T09:14:45.000Z");
    expect(post!.views).toBe(2930); // page served "2.93K"
    expect(post!.reactions).toEqual([
      { emoji: "👍", count: 2 },
      { emoji: "❤", count: 1 },
    ]);
    expect(post!.text).toContain("맨틀");
  });

  it("reads a single-reaction post", () => {
    const post = find(parseChannelPreview(fixture("enjoymyhobby-before-96565.html"), "enjoymyhobby"), 96560);
    expect(post!.views).toBe(3800); // "3.8K"
    expect(post!.reactions).toEqual([{ emoji: "❤", count: 7 }]);
  });

  it("gives an empty reaction list, not undefined, for a post with no reactions", () => {
    const post = find(parseChannelPreview(fixture("Raoni1-before-20920.html"), "Raoni1"), 20914);
    expect(post!.views).toBe(2100); // "2.1K"
    expect(post!.reactions).toEqual([]);
  });

  it("returns posts in document order with ascending message ids", () => {
    const posts = parseChannelPreview(fixture("marshallog-before-22800.html"), "marshallog");
    expect(posts.length).toBeGreaterThan(1);
    const ids = posts.map((p) => p.messageId);
    expect([...ids].sort((a, b) => a - b)).toEqual(ids);
  });

  it("only returns posts belonging to the requested handle", () => {
    const posts = parseChannelPreview(fixture("marshallog-before-22800.html"), "marshallog");
    expect(posts.every((p) => p.handle === "marshallog")).toBe(true);
    expect(posts.every((p) => p.url === `https://t.me/marshallog/${p.messageId}`)).toBe(true);
  });

  it("returns [] for markup with no messages instead of throwing", () => {
    expect(parseChannelPreview("<html><body>nope</body></html>", "marshallog")).toEqual([]);
    expect(parseChannelPreview("", "marshallog")).toEqual([]);
  });
});
```

Add a second describe block in the same file for the count-scaling helper, using synthetic strings — these are the boundaries the fixtures happen not to cover:

```ts
import { parseViewCount } from "../../../src/adapters/telegram/parseChannelPreview";

describe("parseViewCount", () => {
  it("keeps a sub-1000 count exact, which is what the page serves", () => {
    expect(parseViewCount("879")).toBe(879);
    expect(parseViewCount("704")).toBe(704);
  });

  it("expands the K and M suffixes the page uses above 1000", () => {
    expect(parseViewCount("2.93K")).toBe(2930);
    expect(parseViewCount("1.4K")).toBe(1400);
    expect(parseViewCount("12K")).toBe(12000);
    expect(parseViewCount("1.2M")).toBe(1200000);
  });

  it("tolerates a thousands separator and surrounding whitespace", () => {
    expect(parseViewCount(" 1 234 ")).toBe(1234);
    expect(parseViewCount("1,234")).toBe(1234);
  });

  it("returns 0 for an absent or unreadable count", () => {
    expect(parseViewCount("")).toBe(0);
    expect(parseViewCount("—")).toBe(0);
  });
});
```

- [ ] **Step 3: Run to verify it fails**

Run: `pnpm vitest run tests/adapters/telegram/parseChannelPreview.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 4: Implement**

Read `src/adapters/twitterapi/expandUrls.ts` first: it is the repo's precedent for regex-over-markup as a pure, separately tested function, and this file should read like it.

The markup this parses, confirmed against the live pages:

```html
<div class="tgme_widget_message ..." data-post="marshallog/22794">
  <div class="tgme_widget_message_text js-message_text" dir="auto">…text with <a>, <br>, &amp;…</div>
  <span class="tgme_reaction …"><i class="emoji" style="…"><b>👍</b></i>2</span>
  <time datetime="2026-07-03T09:14:45+00:00">…</time>
  <span class="tgme_widget_message_views">2.93K</span>
</div>
```

Invariants:
- Split on the message-container boundary and parse each block independently, so one unreadable block cannot lose the rest. A block with no `data-post` matching the requested handle is skipped — a preview page embeds forwarded and reply-quoted messages from *other* channels, and attributing those to this KOL would invent deliverables.
- `postedAt` is normalized to a UTC ISO string with milliseconds (`new Date(raw).toISOString()`), because the page serves `+00:00` offsets and the sheet needs one comparable format. A block with no parseable `<time datetime>` is skipped, not defaulted — an undated post cannot be placed in a month window.
- `views` uses `parseViewCount`, exported for its own test. Absent element → `0`.
- Reactions: the count is the text *after* the closing `</i>`, the emoji is inside `<b>`. A reaction span with no trailing digits counts as `1`, which is how the page renders a single reaction in some layouts. Order is preserved.
- `text` is the message text with tags stripped, HTML entities unescaped, and `<br>` turned into `\n`. A photo-only post has no text element → `""`, never `undefined`.
- Pure: no `fetch`, no `fs`, no clock. Everything it needs arrives as arguments.

- [ ] **Step 5: Run to verify it passes**

Run: `pnpm vitest run tests/adapters/telegram/parseChannelPreview.test.ts`
Expected: PASS, both describe blocks.

- [ ] **Step 6: Commit**

```bash
git add src/adapters/telegram/parseChannelPreview.ts tests/adapters/telegram/
git commit -m "feat(telegram): parse public channel preview into posts, locked by real fixtures"
```

---

### Task 3: Reaction arithmetic and candidate detection

**Files:**
- Create: `src/domain/kol/reactions.ts`, `src/domain/kol/candidacy.ts`
- Test: `tests/domain/kol/reactions.test.ts`, `tests/domain/kol/candidacy.test.ts`

**Interfaces:**
- Consumes: `ChannelPost["reactions"]` from Task 1.
- Produces:
  ```ts
  export function sumReactions(reactions: { emoji: string; count: number }[]): number;
  export function formatReactions(reactions: { emoji: string; count: number }[]): string;
  export function isMantleCandidate(text: string): boolean;
  ```

- [ ] **Step 1: Write the failing tests**

`tests/domain/kol/reactions.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { sumReactions, formatReactions } from "../../../src/domain/kol/reactions";

describe("sumReactions", () => {
  it("matches the engagement the sheet recorded for Marine's USPXx post", () => {
    // Sheet Jul. r12 says 3; the page serves 👍2 + ❤1.
    expect(sumReactions([{ emoji: "👍", count: 2 }, { emoji: "❤", count: 1 }])).toBe(3);
  });

  it("is 0 for a post with no reactions", () => {
    expect(sumReactions([])).toBe(0);
  });
});

describe("formatReactions", () => {
  it("renders the human-auditable detail string", () => {
    expect(formatReactions([{ emoji: "👍", count: 2 }, { emoji: "❤", count: 1 }])).toBe("👍2 ❤1");
  });

  it("is an empty string for no reactions, so the cell reads as blank", () => {
    expect(formatReactions([])).toBe("");
  });
});
```

`tests/domain/kol/candidacy.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { isMantleCandidate } from "../../../src/domain/kol/candidacy";

describe("isMantleCandidate", () => {
  it("matches the Korean name, which is what KOL posts actually use", () => {
    expect(isMantleCandidate("🙃 맨틀, 프랭클린 미국 주식 ETF $USPXx 출시")).toBe(true);
  });

  it("matches the English name regardless of case", () => {
    expect(isMantleCandidate("USPXx Live on Mantle")).toBe(true);
    expect(isMantleCandidate("live on MANTLE now")).toBe(true);
  });

  it("matches the ticker with or without a dollar sign", () => {
    expect(isMantleCandidate("$MNT 매수")).toBe(true);
    expect(isMantleCandidate("MNT 스테이킹 안내")).toBe(true);
  });

  it("does not fire on MNT inside a longer token", () => {
    expect(isMantleCandidate("MNTUSDT 차트 봅니다")).toBe(false);
    expect(isMantleCandidate("MNTL 에어드랍")).toBe(false);
  });

  it("does not fire on an unrelated post", () => {
    expect(isMantleCandidate("비트코인 그냥 홀딩합니다")).toBe(false);
  });

  it("is false for empty text, so a photo-only post is not a candidate", () => {
    expect(isMantleCandidate("")).toBe(false);
  });
});
```

- [ ] **Step 2: Run to verify they fail**

Run: `pnpm vitest run tests/domain/kol/reactions.test.ts tests/domain/kol/candidacy.test.ts`
Expected: FAIL — modules not found.

- [ ] **Step 3: Implement**

Invariants:
- `formatReactions` joins `emoji + count` with a single space, in the order the parser produced. No sorting — the page's order is what a human comparing the cell against Telegram will see.
- `isMantleCandidate` matches `맨틀`, `mantle` case-insensitively, and `MNT` only at token boundaries. `MNT` is short enough to appear inside unrelated tickers, so a bare `includes` would generate false candidates; the two negative tests above are the contract. A leading `$` must not defeat the boundary.
- Both files are pure and take no clock. Deliberately wide detection is a spec decision: a false positive costs one human keystroke in the review tab, a miss costs a missed payment obligation.

- [ ] **Step 4: Run to verify they pass**

Run: `pnpm vitest run tests/domain/kol/reactions.test.ts tests/domain/kol/candidacy.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/domain/kol/reactions.ts src/domain/kol/candidacy.ts tests/domain/kol/reactions.test.ts tests/domain/kol/candidacy.test.ts
git commit -m "feat(kol): sum reactions and detect Mantle candidate posts"
```

---

### Task 4: Attribution — match a KOL post to the copy we produced

**Files:**
- Create: `src/domain/kol/attribution.ts`
- Test: `tests/domain/kol/attribution.test.ts`

**Interfaces:**
- Consumes: nothing from earlier tasks.
- Produces:
  ```ts
  export interface MatchCandidate { itemId: string; text: string; }
  export interface MatchResult { itemId: string; score: number; }

  export const MATCH_THRESHOLD = 0.30;
  export function normalizeForMatch(text: string): string;
  export function similarity(a: string, b: string): number;              // 0..1
  export function bestMatch(text: string, candidates: MatchCandidate[]): MatchResult | undefined;
  ```

- [ ] **Step 1: Write the failing test**

`tests/domain/kol/attribution.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import {
  normalizeForMatch, similarity, bestMatch, MATCH_THRESHOLD,
} from "../../../src/domain/kol/attribution";

describe("normalizeForMatch", () => {
  it("strips urls, emoji, and whitespace so only the words remain", () => {
    expect(normalizeForMatch("🙃 맨틀 출시 https://t.me/x 지금")).toBe("맨틀출시지금");
  });

  it("lowercases latin text so casing cannot change a score", () => {
    expect(normalizeForMatch("Mantle USPXx")).toBe("mantleuspxx");
  });

  it("is stable under reordered whitespace and newlines", () => {
    expect(normalizeForMatch("a b\n\nc")).toBe(normalizeForMatch("a  b c"));
  });
});

describe("similarity", () => {
  it("is 1 for identical text", () => {
    expect(similarity("맨틀에서 토큰화 주식이 거래됩니다", "맨틀에서 토큰화 주식이 거래됩니다")).toBe(1);
  });

  it("is 0 for text with nothing in common", () => {
    expect(similarity("맨틀 토큰화 주식", "오늘 점심 메뉴 추천")).toBe(0);
  });

  it("stays high when a KOL keeps our sentences but adds their own opener", () => {
    const ours = "프랭클린 템플턴의 USPX ETF를 토큰화해 맨틀 위에서 거래를 지원합니다";
    const theirs = "🙃 이거 꼭 보세요 프랭클린 템플턴의 USPX ETF를 토큰화해 맨틀 위에서 거래를 지원합니다";
    expect(similarity(ours, theirs)).toBeGreaterThan(MATCH_THRESHOLD);
  });

  it("stays high when a KOL reorders our lines, which edit distance would punish", () => {
    const ours = "맨틀에서 토큰화 주식 거래 지원. 플럭션에서 리워드 캠페인 진행 중.";
    const theirs = "플럭션에서 리워드 캠페인 진행 중. 맨틀에서 토큰화 주식 거래 지원.";
    expect(similarity(ours, theirs)).toBeGreaterThan(0.8);
  });

  it("falls below the threshold for a different campaign about the same chain", () => {
    const ours = "프랭클린 템플턴의 USPX ETF를 토큰화해 맨틀 위에서 거래를 지원합니다";
    const theirs = "맨틀 네트워크 데브방에서 이번 주 개발자 밋업이 열립니다 많이 오세요";
    expect(similarity(ours, theirs)).toBeLessThan(MATCH_THRESHOLD);
  });

  it("is 0 rather than NaN when either side normalizes to nothing", () => {
    expect(similarity("", "맨틀")).toBe(0);
    expect(similarity("🙃", "맨틀")).toBe(0);
  });

  it("is symmetric", () => {
    const a = "맨틀에서 토큰화 주식 거래 지원";
    const b = "맨틀에서 토큰화 주식 거래를 지원합니다";
    expect(similarity(a, b)).toBe(similarity(b, a));
  });
});

describe("bestMatch", () => {
  const ours = "프랭클린 템플턴의 USPX ETF를 토큰화해 맨틀 위에서 거래를 지원합니다";
  const other = "맨틀 데브방 개발자 밋업 공지입니다 많이 참여해주세요";

  it("picks the highest-scoring candidate", () => {
    const res = bestMatch(`🙃 ${ours}`, [
      { itemId: "x:222", text: other },
      { itemId: "x:111", text: ours },
    ]);
    expect(res!.itemId).toBe("x:111");
    expect(res!.score).toBeGreaterThan(MATCH_THRESHOLD);
  });

  it("returns undefined below the threshold rather than guessing", () => {
    expect(bestMatch("오늘 점심 뭐 먹지", [{ itemId: "x:111", text: ours }])).toBeUndefined();
  });

  it("returns undefined when there are no candidates, which is the July backfill case", () => {
    // No renderings exist before 2026-07-21, so a July sweep has nothing to match against.
    expect(bestMatch(ours, [])).toBeUndefined();
  });

  it("is deterministic when two candidates tie, preferring the earlier one", () => {
    const res = bestMatch(ours, [
      { itemId: "x:aaa", text: ours },
      { itemId: "x:bbb", text: ours },
    ]);
    expect(res!.itemId).toBe("x:aaa");
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `pnpm vitest run tests/domain/kol/attribution.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement**

Invariants:
- `normalizeForMatch` removes URLs, then emoji and symbol codepoints, then all whitespace, then lowercases. Order matters: stripping whitespace before URLs would weld a URL to its neighbouring word.
- `similarity` is Jaccard over the set of character 3-grams of the normalized strings: `|A ∩ B| / |A ∪ B|`. A **set** measure is the point — KOLs reorder our lines, and the reorder test above fails under any edit-distance ratio. Either side empty → `0`, never `NaN`. Symmetric by construction.
- A normalized string shorter than 3 characters yields no 3-grams; treat as `0` rather than dividing by zero.
- `bestMatch` scores every candidate, returns the maximum if `>= MATCH_THRESHOLD`, else `undefined`. Ties resolve to the first candidate in input order, so a re-run cannot silently re-attribute a row.
- `MATCH_THRESHOLD = 0.30` is an initial value, not a tuned one: the spec records that no renderings exist before `2026-07-21`, so it cannot be calibrated until the first real August sweep. Say so in a comment.

- [ ] **Step 4: Run to verify it passes**

Run: `pnpm vitest run tests/domain/kol/attribution.test.ts`
Expected: PASS.

If the reorder test or the different-campaign test fails, the n-gram size is the dial — do **not** move the threshold to make a test pass, because the threshold is also the production default. Record what you changed and why.

- [ ] **Step 5: Commit**

```bash
git add src/domain/kol/attribution.ts tests/domain/kol/attribution.test.ts
git commit -m "feat(kol): attribute a KOL post to our copy by 3-gram similarity"
```

---

### Task 5: `TelegramChannelGateway` port and `TmePreviewGateway`

**Files:**
- Create: `src/ports/TelegramChannelGateway.ts`, `src/adapters/telegram/TmePreviewGateway.ts`
- Test: `tests/adapters/telegram/tmePreviewGateway.test.ts`

**Interfaces:**
- Consumes: `parseChannelPreview` (Task 2), `ChannelPost` (Task 1), `monthWindow` from `src/domain/metrics/window.ts`.
- Produces:
  ```ts
  // src/ports/TelegramChannelGateway.ts
  export interface TelegramChannelGateway {
    fetchPostsInWindow(handle: string, startISO: string, endExclusiveISO: string): Promise<ChannelPost[]>;
  }

  // src/adapters/telegram/TmePreviewGateway.ts
  export type FetchText = (url: string) => Promise<string>;
  export class TmePreviewGateway implements TelegramChannelGateway {
    constructor(fetchText?: FetchText, maxPages?: number);  // defaults: real fetch, 20
  }
  ```

- [ ] **Step 1: Write the failing test**

`tests/adapters/telegram/tmePreviewGateway.test.ts`. Note the injected `fetchText` — no test in this file may touch the network.

```ts
import { describe, it, expect } from "vitest";
import { TmePreviewGateway } from "../../../src/adapters/telegram/TmePreviewGateway";

/**
 * Minimal but structurally real message block, matching the markup the fixtures contain.
 * The `tgme_widget_message_wrap` wrapper is load-bearing, not decoration: the Task 2 parser
 * splits pages on that boundary, so a block without it yields zero posts.
 */
function block(handle: string, id: number, iso: string, views = "1.0K"): string {
  return `<div class="tgme_widget_message_wrap js-widget_message_wrap"><div class="tgme_widget_message" data-post="${handle}/${id}">
    <div class="tgme_widget_message_text js-message_text" dir="auto">post ${id}</div>
    <time datetime="${iso}"></time>
    <span class="tgme_widget_message_views">${views}</span>
  </div></div>`;
}

function pageServer(pages: Record<string, string>) {
  const asked: string[] = [];
  const fetchText = async (url: string) => {
    asked.push(url);
    return pages[url] ?? "<html></html>";
  };
  return { fetchText, asked };
}

const JULY = ["2026-07-01T00:00:00.000Z", "2026-08-01T00:00:00.000Z"] as const;

describe("TmePreviewGateway", () => {
  it("returns only posts inside the window, excluding the exclusive end", async () => {
    const { fetchText } = pageServer({
      "https://t.me/s/kolx":
        block("kolx", 10, "2026-06-30T23:59:59+00:00") +
        block("kolx", 11, "2026-07-01T00:00:00+00:00") +
        block("kolx", 12, "2026-07-31T23:59:59+00:00") +
        block("kolx", 13, "2026-08-01T00:00:00+00:00"),
    });
    const posts = await new TmePreviewGateway(fetchText).fetchPostsInWindow("kolx", ...JULY);
    expect(posts.map((p) => p.messageId)).toEqual([11, 12]);
  });

  it("pages backwards with ?before until it passes the window start", async () => {
    const { fetchText, asked } = pageServer({
      "https://t.me/s/kolx": block("kolx", 30, "2026-07-20T00:00:00+00:00"),
      "https://t.me/s/kolx?before=30": block("kolx", 20, "2026-07-05T00:00:00+00:00"),
      "https://t.me/s/kolx?before=20": block("kolx", 10, "2026-06-15T00:00:00+00:00"),
    });
    const posts = await new TmePreviewGateway(fetchText).fetchPostsInWindow("kolx", ...JULY);

    expect(posts.map((p) => p.messageId)).toEqual([20, 30]);
    expect(asked).toEqual([
      "https://t.me/s/kolx",
      "https://t.me/s/kolx?before=30",
      "https://t.me/s/kolx?before=20",
    ]);
  });

  it("stops at an empty page instead of paging forever", async () => {
    const { fetchText, asked } = pageServer({
      "https://t.me/s/kolx": block("kolx", 30, "2026-07-20T00:00:00+00:00"),
    });
    const posts = await new TmePreviewGateway(fetchText).fetchPostsInWindow("kolx", ...JULY);
    expect(posts.map((p) => p.messageId)).toEqual([30]);
    expect(asked).toEqual(["https://t.me/s/kolx", "https://t.me/s/kolx?before=30"]);
  });

  it("honours the page cap so one busy channel cannot hang a sweep", async () => {
    // Every page is inside the window and hands back a lower id, so only the cap ends it.
    let next = 100000;
    const fetchText = async () => block("kolx", (next -= 10), "2026-07-15T00:00:00+00:00");
    const gw = new TmePreviewGateway(fetchText, 3);
    const posts = await gw.fetchPostsInWindow("kolx", ...JULY);
    expect(posts).toHaveLength(3);
  });

  it("returns posts sorted oldest first, regardless of page order", async () => {
    const { fetchText } = pageServer({
      "https://t.me/s/kolx": block("kolx", 30, "2026-07-20T00:00:00+00:00"),
      "https://t.me/s/kolx?before=30": block("kolx", 20, "2026-07-05T00:00:00+00:00"),
      "https://t.me/s/kolx?before=20": "<html></html>",
    });
    const posts = await new TmePreviewGateway(fetchText).fetchPostsInWindow("kolx", ...JULY);
    expect(posts.map((p) => p.postedAt)).toEqual([
      "2026-07-05T00:00:00.000Z",
      "2026-07-20T00:00:00.000Z",
    ]);
  });

  it("propagates a fetch failure so the caller can isolate the channel", async () => {
    const fetchText = async () => { throw new Error("HTTP 404"); };
    await expect(
      new TmePreviewGateway(fetchText).fetchPostsInWindow("gone", ...JULY),
    ).rejects.toThrow("HTTP 404");
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `pnpm vitest run tests/adapters/telegram/tmePreviewGateway.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement**

Read `src/ports/SourceGateway.ts` for the port's doc-comment conventions, and `src/shared/http/HttpClient.ts` for the retry/backoff shape this mirrors.

Invariants:
- Request `https://t.me/s/<handle>`, then `?before=<lowest messageId seen>` repeatedly. Stop when a page yields no posts, when its oldest post predates `startISO`, or at `maxPages` (default 20). All three stops are required: the first two are the normal exits, and the cap is the guard against a channel that posts hundreds of times a month.
- Filter to `postedAt >= startISO && postedAt < endExclusiveISO`. Half-open, matching `monthWindow`'s `endExclusiveISO`.
- Return oldest-first, de-duplicated by `messageId` — overlapping pages can repeat a post.
- **Do not reuse `HttpClient`.** It sets a JSON content type and returns `res.json()`; t.me serves HTML. The default `fetchText` is a local function that sends a browser `User-Agent`, retries a 429 or 5xx three times with exponential backoff, and throws `HTTP <status>` otherwise — the same policy as `HttpClient`, expressed for a text body. Keep it in this file; do not generalize shared HTTP for one caller.
- Errors propagate. Per-channel isolation is Task 7's job, and swallowing here would make an unreachable channel indistinguishable from a quiet one.
- `fetchText` is injected so tests never hit the network.

- [ ] **Step 4: Run to verify it passes**

Run: `pnpm vitest run tests/adapters/telegram/tmePreviewGateway.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/ports/TelegramChannelGateway.ts src/adapters/telegram/TmePreviewGateway.ts tests/adapters/telegram/tmePreviewGateway.test.ts
git commit -m "feat(telegram): fetch a channel's posts for a month window with paging"
```

---

### Task 6: `LoadKolMap`

**Files:**
- Create: `src/app/LoadKolMap.ts`
- Test: `tests/app/loadKolMap.test.ts`

**Interfaces:**
- Consumes: `SheetClient` from `src/ports/SheetClient.ts`, `KolMapEntry` and `extractTelegramHandle` from Task 1.
- Produces: `export class LoadKolMap { constructor(sheet: SheetClient); run(): Promise<KolMapEntry[]>; }`

- [ ] **Step 1: Write the failing test**

`tests/app/loadKolMap.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { LoadKolMap } from "../../src/app/LoadKolMap";
import type { SheetClient } from "../../src/ports/SheetClient";

function sheetWith(rows: string[][]): { sheet: SheetClient; ranges: string[] } {
  const ranges: string[] = [];
  const sheet: SheetClient = {
    getValues: async (range) => { ranges.push(range); return rows; },
    appendValues: async () => {},
    updateValues: async () => {},
    createSpreadsheet: async () => ({ spreadsheetId: "x" }),
    ensureTab: async () => {},
  };
  return { sheet, ranges };
}

const HEADER = ["kolId", "tgHandle", "sheetLabel", "pricePerPost", "active"];

describe("LoadKolMap", () => {
  it("maps columns by header name, not position", async () => {
    const { sheet } = sheetWith([
      ["sheetLabel", "kolId", "active", "tgHandle", "pricePerPost"],
      ["Marine", "marine", "TRUE", "https://t.me/marshallog", "100"],
    ]);
    expect(await new LoadKolMap(sheet).run()).toEqual([
      { kolId: "marine", tgHandle: "marshallog", sheetLabel: "Marine", pricePerPost: 100, active: true },
    ]);
  });

  it("extracts the handle from a url and trims the sheet's stray whitespace", async () => {
    const { sheet } = sheetWith([
      HEADER,
      ["marine", " https://t.me/marshallog", "Marine", "100", "TRUE"],
      ["atm", "https://t.me/Bounty_ATM ", "Airdrop ATM", "100", "TRUE"],
    ]);
    const out = await new LoadKolMap(sheet).run();
    expect(out.map((e) => e.tgHandle)).toEqual(["marshallog", "Bounty_ATM"]);
  });

  it("keeps a fractional price unrounded", async () => {
    // The rate table says Enjoyhobby is 62.5 while the July rows say 63; the map carries 62.5.
    const { sheet } = sheetWith([HEADER, ["enjoyhobby", "https://t.me/enjoymyhobby", "Enjoyhobby", "62.5", "TRUE"]]);
    expect((await new LoadKolMap(sheet).run())[0].pricePerPost).toBe(62.5);
  });

  // Placeholder handles must be at least 5 characters: `extractTelegramHandle` enforces
  // Telegram's real 5-32 rule, so a 3-letter stand-in would be dropped as unusable and the
  // test would pass for the wrong reason.
  it("drops inactive rows so a channel can leave the sweep without losing its row", async () => {
    const { sheet } = sheetWith([
      HEADER,
      ["a", "https://t.me/aaaaa", "A", "10", "TRUE"],
      ["b", "https://t.me/bbbbb", "B", "10", "FALSE"],
      ["c", "https://t.me/ccccc", "C", "10", ""],
    ]);
    expect((await new LoadKolMap(sheet).run()).map((e) => e.kolId)).toEqual(["a"]);
  });

  it("skips a row with no usable handle rather than sweeping a bad url", async () => {
    const { sheet } = sheetWith([
      HEADER,
      ["a", "https://x.com/aaa", "A", "10", "TRUE"],
      ["b", "", "B", "10", "TRUE"],
      ["c", "https://t.me/ccccc", "C", "10", "TRUE"],
    ]);
    expect((await new LoadKolMap(sheet).run()).map((e) => e.kolId)).toEqual(["c"]);
  });

  it("treats a missing or unreadable price as 0 rather than NaN", async () => {
    const { sheet } = sheetWith([HEADER, ["a", "https://t.me/aaaaa", "A", "", "TRUE"]]);
    expect((await new LoadKolMap(sheet).run())[0].pricePerPost).toBe(0);
  });

  it("returns [] for an empty tab", async () => {
    const { sheet } = sheetWith([]);
    expect(await new LoadKolMap(sheet).run()).toEqual([]);
  });

  it("throws a named error when a required column is absent", async () => {
    const { sheet } = sheetWith([["kolId", "sheetLabel"], ["a", "A"]]);
    await expect(new LoadKolMap(sheet).run()).rejects.toThrow(/tgHandle/);
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `pnpm vitest run tests/app/loadKolMap.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement**

Read `src/app/LoadRoster.ts` and follow it closely — same header-name mapping, same `A:Z` range constant with the comment explaining the tab coupling, same "skip unusable rows, throw on a missing column" split.

Invariants:
- Range is `'kol-map'!A:Z`. Headers are matched case-insensitively after trimming, so a human retyping `KolId` does not break the load.
- A missing required column throws and names the column — that is a setup error a human must fix. An individual row that is unusable (no handle, inactive) is skipped silently, because a half-filled row is normal in a human-maintained tab.
- `active` is true only for a case-insensitive `TRUE`/`Y`/`YES`/`1`. Blank is inactive: a newly added row should not join the sweep until someone marks it.
- `pricePerPost` parses as a float and never rounds. Unparseable → `0`, which surfaces in the review tab as an obviously wrong price rather than `NaN`.

- [ ] **Step 4: Run to verify it passes**

Run: `pnpm vitest run tests/app/loadKolMap.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/app/LoadKolMap.ts tests/app/loadKolMap.test.ts
git commit -m "feat(kol): load the kol-map registry tab"
```

---

### Task 7: `RecordKolTelegramPosts` — the sweep and the upsert

**Files:**
- Create: `src/app/RecordKolTelegramPosts.ts`
- Test: `tests/app/recordKolTelegramPosts.test.ts`

**Interfaces:**
- Consumes: everything from Tasks 1–6, plus `monthWindow` from `src/domain/metrics/window.ts`.
- Produces:
  ```ts
  export interface RecordKolTelegramInput {
    month: string;                       // YYYY-MM
    map: KolMapEntry[];
    renderings: MatchCandidate[];        // approved Telegram-channel copy
  }
  export interface RecordKolTelegramResult {
    created: number;
    refreshed: number;
    channelsSwept: number;
    channelsFailed: number;
  }
  export class RecordKolTelegramPosts {
    constructor(
      sheet: SheetClient,
      gateway: TelegramChannelGateway,
      now?: () => Date,
    );
    run(input: RecordKolTelegramInput): Promise<RecordKolTelegramResult>;
  }
  ```

- [ ] **Step 1: Write the failing test**

`tests/app/recordKolTelegramPosts.test.ts`. Read `tests/app/recordMetrics.test.ts` first and reuse its `fakeSheet` shape — same in-memory rows, same range-suffix matching, widened from `A:I` to `A:M`.

```ts
import { describe, it, expect } from "vitest";
import { RecordKolTelegramPosts } from "../../src/app/RecordKolTelegramPosts";
import { KOL_TELEGRAM_HEADER } from "../../src/domain/kol/models";
import type { ChannelPost, KolMapEntry } from "../../src/domain/kol/models";
import type { SheetClient } from "../../src/ports/SheetClient";
import type { TelegramChannelGateway } from "../../src/ports/TelegramChannelGateway";

const TAB = "kol-telegram-posts";

function fakeSheet() {
  const state: { rows: string[][]; ensured: string[] } = { rows: [], ensured: [] };
  const sheet: SheetClient = {
    ensureTab: async (t) => { state.ensured.push(t); },
    getValues: async (range) =>
      range.endsWith("A1:M1") ? (state.rows[0] ? [state.rows[0]] : []) : state.rows.slice(1),
    appendValues: async (_r, rows) => { for (const row of rows) state.rows.push(row); },
    updateValues: async (range, rows) => {
      if (range.endsWith("A1:M1")) { state.rows[0] = rows[0]; return; }
      const m = /A(\d+):M\1$/.exec(range);
      if (m) state.rows[Number(m[1]) - 1] = rows[0];
    },
    createSpreadsheet: async () => ({ spreadsheetId: "x" }),
  };
  return { sheet, state };
}

const col = (name: string) => KOL_TELEGRAM_HEADER.indexOf(name);
const cell = (row: string[], name: string) => row[col(name)];

const post = (handle: string, id: number, over: Partial<ChannelPost> = {}): ChannelPost => ({
  handle,
  messageId: id,
  url: `https://t.me/${handle}/${id}`,
  postedAt: "2026-07-10T00:00:00.000Z",
  views: 2000,
  reactions: [{ emoji: "👍", count: 2 }],
  text: "맨틀에서 토큰화 주식 거래 지원",
  ...over,
});

function gateway(byHandle: Record<string, ChannelPost[] | Error>): TelegramChannelGateway {
  return {
    fetchPostsInWindow: async (handle) => {
      const v = byHandle[handle];
      if (v instanceof Error) throw v;
      return v ?? [];
    },
  };
}

const MAP: KolMapEntry[] = [
  { kolId: "marine", tgHandle: "marshallog", sheetLabel: "Marine", pricePerPost: 100, active: true },
];
const AT = () => new Date("2026-07-31T00:00:00.000Z");

describe("RecordKolTelegramPosts", () => {
  it("writes the header once and appends a candidate post", async () => {
    const { sheet, state } = fakeSheet();
    const gw = gateway({ marshallog: [post("marshallog", 22794)] });
    const res = await new RecordKolTelegramPosts(sheet, gw, AT).run({
      month: "2026-07", map: MAP, renderings: [],
    });

    expect(res).toEqual({ created: 1, refreshed: 0, channelsSwept: 1, channelsFailed: 0 });
    expect(state.ensured).toContain(TAB);
    expect(state.rows[0]).toEqual(KOL_TELEGRAM_HEADER);

    const row = state.rows[1];
    expect(cell(row, "kolId")).toBe("marine");
    expect(cell(row, "deliverableLink")).toBe("https://t.me/marshallog/22794");
    expect(cell(row, "views")).toBe("2000");
    expect(cell(row, "engagements")).toBe("2");
    expect(cell(row, "reactionsDetail")).toBe("👍2");
    expect(cell(row, "pricePerPost")).toBe("100");
    expect(cell(row, "fetchedAt")).toBe("2026-07-31T00:00:00.000Z");
    expect(cell(row, "confirmed")).toBe("");
  });

  it("skips a post that never mentions Mantle", async () => {
    const { sheet, state } = fakeSheet();
    const gw = gateway({ marshallog: [post("marshallog", 1, { text: "비트코인 홀딩합니다" })] });
    const res = await new RecordKolTelegramPosts(sheet, gw, AT).run({
      month: "2026-07", map: MAP, renderings: [],
    });
    expect(res.created).toBe(0);
    expect(state.rows.slice(1)).toEqual([]);
  });

  it("attaches an itemId and score when our copy matches", async () => {
    const { sheet, state } = fakeSheet();
    const ours = "맨틀에서 토큰화 주식 거래 지원";
    const gw = gateway({ marshallog: [post("marshallog", 5, { text: `🙃 ${ours}` })] });
    await new RecordKolTelegramPosts(sheet, gw, AT).run({
      month: "2026-07", map: MAP, renderings: [{ itemId: "x:111", text: ours }],
    });
    expect(cell(state.rows[1], "itemId")).toBe("x:111");
    expect(Number(cell(state.rows[1], "matchScore"))).toBeGreaterThan(0.3);
  });

  it("leaves itemId, matchScore, and topic blank when nothing matches — the July backfill case", async () => {
    const { sheet, state } = fakeSheet();
    const gw = gateway({ marshallog: [post("marshallog", 5)] });
    await new RecordKolTelegramPosts(sheet, gw, AT).run({
      month: "2026-07", map: MAP, renderings: [],
    });
    expect(cell(state.rows[1], "itemId")).toBe("");
    expect(cell(state.rows[1], "matchScore")).toBe("");
    expect(cell(state.rows[1], "topic")).toBe("");
  });

  it("inherits a topic a human already typed for the same itemId", async () => {
    const { sheet, state } = fakeSheet();
    state.rows.push(KOL_TELEGRAM_HEADER);
    const existing = new Array(KOL_TELEGRAM_HEADER.length).fill("");
    existing[col("deliverableLink")] = "https://t.me/enjoymyhobby/1";
    existing[col("itemId")] = "x:111";
    existing[col("topic")] = "USPXx Live on Mantle";
    state.rows.push(existing);

    const ours = "맨틀에서 토큰화 주식 거래 지원";
    const gw = gateway({ marshallog: [post("marshallog", 5, { text: ours })] });
    await new RecordKolTelegramPosts(sheet, gw, AT).run({
      month: "2026-07", map: MAP, renderings: [{ itemId: "x:111", text: ours }],
    });

    const added = state.rows[2];
    expect(cell(added, "itemId")).toBe("x:111");
    expect(cell(added, "topic")).toBe("USPXx Live on Mantle");
  });

  it("refreshes metrics on re-run but never overwrites confirmed or an edited topic", async () => {
    const { sheet, state } = fakeSheet();
    state.rows.push(KOL_TELEGRAM_HEADER);
    const existing = new Array(KOL_TELEGRAM_HEADER.length).fill("");
    existing[col("kolId")] = "marine";
    existing[col("deliverableLink")] = "https://t.me/marshallog/22794";
    existing[col("views")] = "2800";
    existing[col("engagements")] = "3";
    existing[col("topic")] = "hand typed topic";
    existing[col("confirmed")] = "paid";
    existing[col("fetchedAt")] = "2026-07-03T00:00:00.000Z";
    state.rows.push(existing);

    const gw = gateway({ marshallog: [post("marshallog", 22794, { views: 2930, reactions: [{ emoji: "❤", count: 9 }] })] });
    const res = await new RecordKolTelegramPosts(sheet, gw, AT).run({
      month: "2026-07", map: MAP, renderings: [],
    });

    expect(res).toEqual({ created: 0, refreshed: 1, channelsSwept: 1, channelsFailed: 0 });
    expect(state.rows).toHaveLength(2);
    const row = state.rows[1];
    expect(cell(row, "views")).toBe("2930");
    expect(cell(row, "engagements")).toBe("9");
    expect(cell(row, "fetchedAt")).toBe("2026-07-31T00:00:00.000Z");
    expect(cell(row, "topic")).toBe("hand typed topic");
    expect(cell(row, "confirmed")).toBe("paid");
  });

  it("does not touch a rejected row and does not count it as refreshed", async () => {
    const { sheet, state } = fakeSheet();
    state.rows.push(KOL_TELEGRAM_HEADER);
    const rejected = new Array(KOL_TELEGRAM_HEADER.length).fill("");
    rejected[col("deliverableLink")] = "https://t.me/marshallog/22794";
    rejected[col("views")] = "2800";
    rejected[col("confirmed")] = "reject";
    state.rows.push(rejected);

    const gw = gateway({ marshallog: [post("marshallog", 22794, { views: 9999 })] });
    const res = await new RecordKolTelegramPosts(sheet, gw, AT).run({
      month: "2026-07", map: MAP, renderings: [],
    });

    expect(res).toEqual({ created: 0, refreshed: 0, channelsSwept: 1, channelsFailed: 0 });
    expect(cell(state.rows[1], "views")).toBe("2800");
  });

  it("isolates a failed channel and still records the others", async () => {
    const { sheet, state } = fakeSheet();
    const map: KolMapEntry[] = [
      ...MAP,
      { kolId: "gone", tgHandle: "gone", sheetLabel: "Gone", pricePerPost: 10, active: true },
      { kolId: "raoni", tgHandle: "Raoni1", sheetLabel: "Raoni", pricePerPost: 60, active: true },
    ];
    const gw = gateway({
      marshallog: [post("marshallog", 1)],
      gone: new Error("HTTP 404"),
      Raoni1: [post("Raoni1", 2)],
    });
    const res = await new RecordKolTelegramPosts(sheet, gw, AT).run({
      month: "2026-07", map, renderings: [],
    });

    expect(res).toEqual({ created: 2, refreshed: 0, channelsSwept: 3, channelsFailed: 1 });
    expect(state.rows.slice(1).map((r) => cell(r, "kolId")).sort()).toEqual(["marine", "raoni"]);
  });

  it("does not sweep an inactive channel", async () => {
    const { sheet } = fakeSheet();
    let asked = 0;
    const gw: TelegramChannelGateway = {
      fetchPostsInWindow: async () => { asked += 1; return []; },
    };
    const res = await new RecordKolTelegramPosts(sheet, gw, AT).run({
      month: "2026-07",
      map: [{ ...MAP[0], active: false }],
      renderings: [],
    });
    expect(asked).toBe(0);
    expect(res.channelsSwept).toBe(0);
  });

  it("rejects an invalid month before writing anything", async () => {
    const { sheet, state } = fakeSheet();
    const gw = gateway({});
    await expect(
      new RecordKolTelegramPosts(sheet, gw, AT).run({ month: "2026-13", map: MAP, renderings: [] }),
    ).rejects.toThrow(/2026-13/);
    expect(state.rows).toEqual([]);
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `pnpm vitest run tests/app/recordKolTelegramPosts.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement**

Read `src/app/RecordMetrics.ts` first. This is the same orchestration shape — `ensureTab`, write the header only when absent, loop the accounts with per-account `try`/`catch` and a `console.warn`, then upsert — extended with the preservation rules.

Invariants:
- Validate the month via `monthWindow` **before** any sheet call, so a typo cannot half-write a tab.
- Sweep only `active` entries. `channelsSwept` counts channels attempted, `channelsFailed` those that threw; a failure warns and continues, exactly as `RecordMetrics` does per account.
- Upsert key is `deliverableLink`. Read the data range once per run, not once per row: `RecordMetrics.upsert` re-reads inside its loop, which is acceptable for eight accounts but not for hundreds of posts. Build an index of link → row number, then write.
- On an existing row: overwrite only `views`, `engagements`, `reactionsDetail`, `fetchedAt`. Carry `topic` and `confirmed` through from the existing row. `itemId` and `matchScore` are only filled when the existing cells are blank — a human who corrected an attribution must not have it re-guessed.
- A row whose `confirmed` is `reject` is left completely untouched and counted in neither `created` nor `refreshed`.
- Topic inheritance: after attribution, if the row has an `itemId` and no topic, look for any row already carrying that `itemId` with a non-empty `topic` — in the sheet, or earlier in this same run — and copy it. This is what makes one human label serve every KOL row for a campaign.
- All cells are written as strings; the sheet API takes strings and mixed types would break the `getValues` round-trip. `matchScore` is fixed to two decimals; a blank match writes `""`, not `"0.00"`.
- `now` is injected. No `new Date()` inside the logic.

- [ ] **Step 4: Run to verify it passes**

Run: `pnpm vitest run tests/app/recordKolTelegramPosts.test.ts`
Expected: PASS, all ten tests.

- [ ] **Step 5: Commit**

```bash
git add src/app/RecordKolTelegramPosts.ts tests/app/recordKolTelegramPosts.test.ts
git commit -m "feat(kol): sweep KOL channels and upsert the review tab"
```

---

### Task 8: CLI, script, and Korean docs

**Files:**
- Create: `src/cli/kol-telegram-record.ts`
- Modify: `package.json`, `docs/ko/capabilities.md`, `docs/ko/artifacts.md`, `docs/ko/team-runbook.md`
- Test: `tests/cli/kolTelegramRecord.test.ts`

**Interfaces:**
- Consumes: `RecordKolTelegramPosts`, `LoadKolMap`, `TmePreviewGateway`, plus `loadGoogleAuthConfig` / `loadGoogleSheetConfig` from `src/config.ts`.
- Produces: the `pnpm kol-telegram:record [--month YYYY-MM]` command.

- [ ] **Step 1: Write the failing test**

Check `tests/cli/` for how existing CLI tests are structured before writing this, and follow the closest one. The CLI's own wiring is thin; what needs a test is the rendering-candidate selection, which is real logic and must not live inline in the CLI. Put it in `src/app/LoadKolMap.ts`'s sibling location as a small exported function.

`tests/cli/kolTelegramRecord.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { telegramMatchCandidates } from "../../src/app/telegramMatchCandidates";
import type { ChannelRendering } from "../../src/domain/formatting/models";

// `refined` and `createdAt` are required on ChannelRendering, and `status` is only
// "rendered" | "approved" — `pnpm typecheck` covers tests/, so the shape must be exact.
const rendering = (over: Partial<ChannelRendering>): ChannelRendering => ({
  itemId: "a",
  type: "announcement",
  channel: "telegram",
  text: "맨틀 공지",
  refined: false,
  createdAt: "2026-07-29T00:00:00.000Z",
  status: "approved",
  ...over,
});

describe("telegramMatchCandidates", () => {
  it("keeps approved Telegram-channel copy only", () => {
    const out = telegramMatchCandidates([
      rendering({ itemId: "a" }),
      rendering({ itemId: "b", type: "x", channel: "x", text: "mantle post" }),
      rendering({ itemId: "c", text: "초안", status: "rendered" }),
    ]);
    expect(out).toEqual([{ itemId: "a", text: "맨틀 공지" }]);
  });

  it("drops a rendering with empty text, which can never match", () => {
    expect(telegramMatchCandidates([rendering({ type: "kol", text: "" })])).toEqual([]);
  });

  it("returns [] for no renderings, so a July sweep still runs", () => {
    expect(telegramMatchCandidates([])).toEqual([]);
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `pnpm vitest run tests/cli/kolTelegramRecord.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement the CLI and the helper**

Read `src/cli/metrics-record.ts` and mirror it line for line — it is the closest sibling. Its order is: `registerErrorHandler` import, `skipIfLocal`, read args, build auth → sheet → gateway, load the roster, run the use case, print one summary line.

Invariants:
- `skipIfLocal("kol-telegram:record")` first. This command writes to a cloud sheet, so local mode must exit `0` — see `docs/ko/artifacts.md`, which lists every command with this behaviour; add this one to that list.
- `--month` defaults to `currentMonth(new Date())`, as in `metrics:record`.
- Renderings load through the `FormattingStore` port's `loadAll()` (`src/ports/FormattingStore.ts`, implemented by `src/adapters/store/JsonFormattingStore.ts`), never by reading the JSON path directly — that is what keeps local and cloud storage modes both working.
- `telegramMatchCandidates` filters to `status === "approved"` and `channel === "telegram"` with non-empty text, and maps to `{ itemId, text }`. It lives in `src/app/` and is exported so it can be tested; the CLI must contain no filtering logic of its own.
- The summary line reports all four counters and names the month, and when `channelsFailed > 0` it says so explicitly — a silent zero must never look like "no posts this month".

- [ ] **Step 4: Add the script**

In `package.json`, beside `metrics:record`:

```json
"kol-telegram:record": "tsx --env-file-if-exists=.env src/cli/kol-telegram-record.ts",
```

- [ ] **Step 5: Run the whole suite and the typechecker**

Run: `pnpm test && pnpm typecheck`
Expected: both PASS, with the new tests included and no existing test broken. `tsconfig.json` includes `tests`, so every test object above must satisfy its real interface — a shape that runs under vitest can still fail `tsc`.

- [ ] **Step 6: Write the Korean docs**

Korean, matching each file's existing tone and table shape. Read the `metrics:record` entry in each file and write the sibling entry:

- `docs/ko/capabilities.md` — one capability-table row (the table around line 146) plus a prose section like the one at line 203. State plainly that the command writes **only** `kol-telegram-posts`, that a human moves confirmed rows into the monthly tabs, and that `confirmed` is the human's column.
- `docs/ko/artifacts.md` — add the command to the local-mode skip table (line ~77) and write a full I/O row in the detailed table (line ~138): reads `'kol-map'` from the `GSHEET_ID` workbook and public `t.me/s/` pages, writes `kol-telegram-posts`, touches no human tab, needs no API key.
- `docs/ko/team-runbook.md` — operator instructions beside the monthly-metrics entry at line ~209. Include the two setup steps a human must do once: fill `kol-map` (13 handles from the rate table), and note that July attribution comes back blank because no copy exists before 2026-07-21.

- [ ] **Step 7: Commit**

```bash
git add src/cli/kol-telegram-record.ts src/app/telegramMatchCandidates.ts tests/cli/kolTelegramRecord.test.ts package.json docs/ko/
git commit -m "feat(kol): add kol-telegram:record CLI and document it"
```

---

### Task 9: Verify against the live workbook, read-only

**Files:** none — this task produces evidence, not code.

- [ ] **Step 1: Confirm the tabs and the rate-table handles are still what the spec recorded**

The workbook is edited by humans daily and the spec's readings are from 2026-07-30. Before running any write, re-read it. `GSHEET_ID` already points at `2026 Q3 KR Work Sheet`; expect the tabs ` Q3 KOL 계약 리스트`, `Jul.`, `Aug.`, `Sep.`, `KOL list`, `x-performance`, `history`. Confirm the rate-table block still carries 13 t.me links, and report the row range you found them in — if it has moved, `kol-map` still works, but the runbook's seeding instructions need the new range.

- [ ] **Step 2: Dry-run one channel against the real gateway**

Fetch a single channel for the current month through `TmePreviewGateway` and print what would be written, without touching the sheet. Confirm the page still parses: non-zero views, plausible dates, Korean text present. If Telegram's markup has changed, the fixtures in Task 2 fail first and this is where you find out before a run writes anything.

- [ ] **Step 3: Run for real on one month and report**

With `kol-map` filled, run `pnpm kol-telegram:record --month <YYYY-MM>` and report: rows created, rows refreshed, channels swept, channels failed and which. Then re-run it immediately and confirm `created` is `0` and `refreshed` equals the first run's `created` — that is idempotency demonstrated against the real sheet, not a fake one.

- [ ] **Step 4: Report the sheet defects to the team**

The spec's appendix lists the summary-block `SUMIF` column shifts, the `Aug.`/`Sep.` Coinboy `COUNTIF`, the header-row `COUNTIF` range, the budget-row range, and the stray `G10`. These are human edits in a shared workbook — **do not fix them by writing to the sheet.** Surface the appendix to the team and let a human apply it.

- [ ] **Step 5: Commit any expectation drift**

If Step 1 or 2 turned up a moved range or changed markup, update the spec's recorded readings and the fixtures, and commit with a message that says what moved.

---

## Self-Review

**Spec coverage.** §1 source choice → Tasks 2 and 5 (and the `HttpClient` note in Task 5 records why shared HTTP is not reused). §2 port/adapter → Task 5. §3 `kol-map` → Tasks 1 and 6, including the trimming and the unrounded `62.5`. §4 two-stage detection → Tasks 3 and 4, with the July-backfill blank case tested in Tasks 4 and 7 and the threshold pinned in Global Constraints. §4 topic bootstrapping → Task 7. §5 review-tab schema → Task 1's header constant, asserted in Tasks 1 and 7. §6 idempotency → Task 7, plus a live re-run in Task 9. §7 per-channel isolation → Task 5 (propagate) and Task 7 (isolate). §8 "does not write the monthly tabs" → Global Constraints, the docs in Task 8, and Task 9 Step 4. Non-goals: followers and comment/forward counts appear nowhere in any interface. The appendix's sheet defects are deliberately human work — Task 9 Step 4 says so rather than automating them.

**Gap found and closed.** Selecting which renderings are eligible match candidates was implied by the spec but had no task; it is now `telegramMatchCandidates` in Task 8, extracted out of the CLI so it can be tested.

**Type consistency.** `ChannelPost`, `KolMapEntry`, `MatchCandidate`, and `MatchResult` are defined once (Tasks 1 and 4) and referenced with those names throughout. `KOL_TELEGRAM_HEADER` is the only definition of column order; Task 7's test derives every column index from it rather than hardcoding positions, so a reordering breaks one constant and not eleven assertions. `fetchPostsInWindow(handle, startISO, endExclusiveISO)` has the same signature in the port, the adapter, and both fakes. `parseViewCount` is exported from `parseChannelPreview.ts` and tested there.
