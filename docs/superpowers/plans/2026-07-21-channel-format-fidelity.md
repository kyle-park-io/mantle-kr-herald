# Channel Format Fidelity Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the §6 channel-format stage produce text that is correct for every place it is actually pasted — X, Typefully, Telegram (app and bot), KakaoTalk, plain-text mail — by storing one canonical post per channel and deriving each destination's spelling at output time.

**Architecture:** `output/formatted/renderings.json` stores **canonical** text (`**bold**`, `[text](url)`, blank line = paragraph, two blank lines = post boundary). A new `emitters/` layer turns canonical into destination-specific strings on demand; nothing destination-specific is ever stored or separately approved. A new weighted-length counter fixes a real bug: X counts Hangul as 2 characters, so the current 280-code-point check never fires for over-limit Korean posts.

**Tech Stack:** TypeScript (ESM, `strict`), Node 22 + `tsx`, Vitest, React 19 + Vite + Tailwind v4 for the dashboard. Backend dependencies stay **`zod`-only** — this plan adds no runtime dependency.

## Global Constraints

- Design spec: `docs/superpowers/specs/2026-07-21-channel-format-fidelity-design.md`. Read it before Task 1.
- **Code and code comments in English. Korean only in user-facing strings** (worksheet copy, CLI warnings, dashboard labels) — matches the existing codebase.
- **No new runtime dependency.** The weighted counter is implemented in-repo; do not add `twitter-text`.
- **No emitter ever splits text on a length threshold.** Segments come only from post boundaries the writer typed. Every limit produces a warning instead.
- **Unicode bold is removed, not made opt-in.**
- **Telegram bot output targets `parse_mode: "HTML"`**, never MarkdownV2.
- All paths resolve through `src/paths.ts`; never use `process.cwd()`.
- Run `pnpm test` and `pnpm typecheck` before every commit. Task 9 also needs `pnpm typecheck:web`.
- Commit after each task with the message given in the task's final step.

## File Structure

**Create:**
- `src/domain/formatting/weightedLength.ts` — X's weighted character count. Sole owner of the 280/23 constants.
- `src/domain/formatting/canonical.ts` — canonical normalisation and the shared text helpers every emitter uses.
- `src/domain/formatting/emitters/types.ts` — `Destination`, `EmitSegment`, `EmitResult`.
- `src/domain/formatting/emitters/x.ts` — `emitXPaste`, `emitXTypefully`.
- `src/domain/formatting/emitters/telegram.ts` — `emitTelegramPaste`, `emitTelegramBot`.
- `src/domain/formatting/emitters/kakao.ts` — `emitKakaoPaste`.
- `src/domain/formatting/emitters/prMail.ts` — `emitPrMail`.
- `src/domain/formatting/emitters/index.ts` — `emit`, `emitAll`, `DESTINATIONS_BY_CHANNEL`.

**Delete:**
- `src/domain/formatting/channelFormat.ts` — replaced by `canonical.ts` + `emitters/`.
- `tests/domain/formatting/channelFormat.test.ts` — replaced by `canonical.test.ts`.

**Modify:**
- `src/domain/formatting/models.ts` — drop `FormatOptions` and `FormatResult`.
- `src/domain/formatting/refinementWorksheet.ts` — generated header, per-segment report.
- `src/app/FormatVariants.ts`, `src/app/PrepareRefinements.ts` — canonical + emitters.
- `src/cli/format.ts` — drop `--x-bold`, better warning output.
- `src/adapters/web/apiHandlers.ts` — `GET …/emissions`.
- `web/src/types.ts`, `web/src/api.ts`, `web/src/components/RenderingDetail.tsx` — destination tabs.
- `docs/ko/artifacts.md`, `docs/ko/capabilities.md`, `CHANGELOG.md`.

---

### Task 1: X weighted length counter

The bug that started this work. Isolated first because nothing else depends on it and it can be tested exhaustively.

**Files:**
- Create: `src/domain/formatting/weightedLength.ts`
- Test: `tests/domain/formatting/weightedLength.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces: `weightedLength(text: string): number`, `X_MAX_WEIGHTED = 280`, `TCO_LENGTH = 23`.

- [ ] **Step 1: Write the failing test**

Create `tests/domain/formatting/weightedLength.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { weightedLength, X_MAX_WEIGHTED, TCO_LENGTH } from "../../../src/domain/formatting/weightedLength";

describe("weightedLength", () => {
  it("counts ASCII as 1 per character", () => {
    expect(weightedLength("a".repeat(280))).toBe(280);
    expect(weightedLength("a".repeat(281))).toBe(281);
  });

  it("counts Hangul as 2 per character — 140 characters fills a post", () => {
    expect(weightedLength("가".repeat(140))).toBe(X_MAX_WEIGHTED);
    expect(weightedLength("가".repeat(141))).toBe(282);
  });

  it("counts any URL as exactly 23, whatever its real length", () => {
    expect(weightedLength("https://x.io")).toBe(TCO_LENGTH);
    expect(weightedLength(`https://example.com/${"a".repeat(200)}`)).toBe(TCO_LENGTH);
  });

  it("adds URL weight to surrounding text rather than replacing it", () => {
    // "공지 " = 2 Hangul (4) + 1 space (1) = 5, plus the URL's 23
    expect(weightedLength("공지 https://x.io")).toBe(5 + TCO_LENGTH);
  });

  it("counts emoji as 2 and newline as 1", () => {
    expect(weightedLength("🎉")).toBe(2);
    expect(weightedLength("\n")).toBe(1);
  });

  it("normalises to NFC before counting", () => {
    // U+1100 U+1161 (decomposed) is NFC-composed to U+AC00 "가" — 2, not 4
    expect(weightedLength("가")).toBe(2);
    expect(weightedLength("가")).toBe(weightedLength("가"));
  });

  it("counts the empty string as 0", () => {
    expect(weightedLength("")).toBe(0);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm vitest run tests/domain/formatting/weightedLength.test.ts`
Expected: FAIL — `Failed to resolve import ".../weightedLength"`.

- [ ] **Step 3: Write the implementation**

Create `src/domain/formatting/weightedLength.ts`:

```ts
/**
 * X counts characters by weight, not by code point. twitter-text v3 gives every code point
 * outside these ranges the default weight of 200, so a Hangul syllable costs 2 and a pure-Korean
 * post maxes out at 140 characters — not 280. Counting code points (the old behaviour) meant a
 * Korean post between 141 and 280 characters was over the real limit with no warning.
 * https://docs.x.com/fundamentals/counting-characters
 * https://github.com/twitter/twitter-text/blob/master/config/v3.json
 */
const WEIGHT_100_RANGES: readonly (readonly [number, number])[] = [
  [0x0000, 0x10ff],
  [0x2000, 0x200d],
  [0x2010, 0x201f],
  [0x2032, 0x2037],
];
const SCALE = 100;
const DEFAULT_WEIGHT = 200;

/** Every URL is wrapped by t.co and costs this much, whatever its real length or scheme. */
export const TCO_LENGTH = 23;

/** Weighted units available in one post on a free account. */
export const X_MAX_WEIGHTED = 280;

const URL = /https?:\/\/\S+/g;

function weightOf(codePoint: number): number {
  for (const [start, end] of WEIGHT_100_RANGES) {
    if (codePoint >= start && codePoint <= end) return SCALE;
  }
  return DEFAULT_WEIGHT;
}

/**
 * X's weighted length of `text`.
 *
 * Known limitation: twitter-text's real extractor also treats scheme-less hosts ("example.com")
 * as URLs, which this regex misses and therefore under-counts. Canonical text writes links as
 * [text](url) with an explicit scheme, so this is acceptable — pull in the `twitter-text` package
 * if that ever stops being true.
 */
export function weightedLength(text: string): number {
  const normalised = text.normalize("NFC");
  let total = 0;
  let plain = "";
  let cursor = 0;
  for (const match of normalised.matchAll(URL)) {
    const start = match.index ?? 0;
    plain += normalised.slice(cursor, start);
    total += TCO_LENGTH * SCALE;
    cursor = start + match[0].length;
  }
  plain += normalised.slice(cursor);
  for (const ch of plain) total += weightOf(ch.codePointAt(0)!);
  return total / SCALE;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm vitest run tests/domain/formatting/weightedLength.test.ts`
Expected: PASS, 7 tests.

- [ ] **Step 5: Run the full suite, typecheck, and commit**

```bash
pnpm test && pnpm typecheck
git add src/domain/formatting/weightedLength.ts tests/domain/formatting/weightedLength.test.ts
git commit -m "feat: count X post length by weight so Korean is measured correctly"
```

---

### Task 2: Canonical normalisation

Canonical text is the semantic source of truth stored in `renderings.json`. This task adds it alongside the existing `channelFormat.ts`, which is not touched yet — the switchover happens in Task 6.

**Files:**
- Create: `src/domain/formatting/canonical.ts`
- Test: `tests/domain/formatting/canonical.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces: `toCanonical(text: string): string`, `splitPosts(canonical: string): string[]`, `stripBold(text: string): string`, `linksToPlain(text: string): string`, `linksToLabel(text: string): string`.

- [ ] **Step 1: Write the failing test**

Create `tests/domain/formatting/canonical.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { toCanonical, splitPosts, stripBold, linksToPlain, linksToLabel } from "../../../src/domain/formatting/canonical";

describe("toCanonical", () => {
  it("keeps a single blank line as a paragraph break", () => {
    expect(toCanonical("첫 문단\n\n둘째 문단")).toBe("첫 문단\n\n둘째 문단");
  });

  it("keeps two blank lines as a post boundary", () => {
    expect(toCanonical("트윗 하나\n\n\n트윗 둘")).toBe("트윗 하나\n\n\n트윗 둘");
  });

  it("collapses more than two blank lines down to exactly one boundary", () => {
    expect(toCanonical("a\n\n\n\n\n\nb")).toBe("a\n\n\nb");
  });

  it("normalises CRLF and trims the ends", () => {
    expect(toCanonical("  a\r\nb  ")).toBe("a\nb");
  });
});

describe("splitPosts", () => {
  it("splits on post boundaries and trims each post", () => {
    expect(splitPosts("하나\n\n\n둘\n\n\n셋")).toEqual(["하나", "둘", "셋"]);
  });

  it("keeps paragraph breaks inside a post", () => {
    expect(splitPosts("첫 줄\n\n같은 트윗\n\n\n다음 트윗")).toEqual(["첫 줄\n\n같은 트윗", "다음 트윗"]);
  });

  it("returns a single post when there is no boundary", () => {
    expect(splitPosts("혼자")).toEqual(["혼자"]);
  });

  it("returns one empty post for empty input rather than an empty list", () => {
    expect(splitPosts("")).toEqual([""]);
  });
});

describe("text helpers", () => {
  it("strips bold markers across newlines", () => {
    expect(stripBold("**첫 줄\n둘째 줄**")).toBe("첫 줄\n둘째 줄");
  });

  it("rewrites a markdown link as 'text (url)'", () => {
    expect(linksToPlain("공지 [자세히](https://x.io)")).toBe("공지 자세히 (https://x.io)");
  });

  it("keeps only the label when the destination renders links as entities", () => {
    expect(linksToLabel("공지 [자세히](https://x.io)")).toBe("공지 자세히");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm vitest run tests/domain/formatting/canonical.test.ts`
Expected: FAIL — `Failed to resolve import ".../canonical"`.

- [ ] **Step 3: Write the implementation**

Create `src/domain/formatting/canonical.ts`:

```ts
/**
 * Canonical text is what `renderings.json` stores: the post's meaning, not any destination's
 * spelling. Its whole vocabulary is `**bold**`, `[text](url)`, one blank line for a paragraph
 * break, and two blank lines for a post boundary (x channel only). Emitters turn this into
 * whatever a given destination actually accepts.
 */
/**
 * Exported so emitters that rewrite these constructs match canonical's definition exactly.
 * Use them only with `String.replace`, which resets `lastIndex`; `.test()`/`.exec()` on a shared
 * /g regex carries state between calls and will skip matches.
 */
export const BOLD = /\*\*([\s\S]+?)\*\*/g;
export const MD_LINK = /\[([^\]]+)\]\(([^)]+)\)/g;

/** Two blank lines. Written out because the whole file turns on this being exactly three \n. */
const POST_BOUNDARY = "\n\n\n";

/**
 * Normalise text into canonical form. Channel-independent by definition.
 *
 * Note the blank-line rule differs from the pre-canonical formatter, which collapsed 3+ newlines
 * to 2 and would therefore have destroyed every post boundary.
 */
export function toCanonical(text: string): string {
  return text.replace(/\r\n/g, "\n").replace(/\n{4,}/g, POST_BOUNDARY).trim();
}

/** Split canonical text on post boundaries. Always returns at least one entry. */
export function splitPosts(canonical: string): string[] {
  const parts = canonical.split(/\n{3,}/).map((p) => p.trim()).filter((p) => p.length > 0);
  return parts.length > 0 ? parts : [canonical.trim()];
}

/** Drop bold markers, keeping the inner text. For destinations with no formatting at all. */
export function stripBold(text: string): string {
  return text.replace(BOLD, "$1");
}

/** Rewrite `[text](url)` as `text (url)` for destinations with no link syntax. */
export function linksToPlain(text: string): string {
  return text.replace(MD_LINK, "$1 ($2)");
}

/** Keep only the label of `[text](url)` — what shows once the link becomes a native entity. */
export function linksToLabel(text: string): string {
  return text.replace(MD_LINK, "$1");
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm vitest run tests/domain/formatting/canonical.test.ts`
Expected: PASS, 11 tests.

- [ ] **Step 5: Run the full suite, typecheck, and commit**

```bash
pnpm test && pnpm typecheck
git add src/domain/formatting/canonical.ts tests/domain/formatting/canonical.test.ts
git commit -m "feat: add canonical rendering text with explicit post boundaries"
```

---

### Task 3: Emitter types and the X destinations

**Files:**
- Create: `src/domain/formatting/emitters/types.ts`, `src/domain/formatting/emitters/x.ts`
- Test: `tests/domain/formatting/emitters/x.test.ts`

**Interfaces:**
- Consumes: `splitPosts`, `stripBold`, `linksToPlain` (Task 2); `weightedLength`, `X_MAX_WEIGHTED` (Task 1).
- Produces: type `Destination`, interfaces `EmitSegment` / `EmitResult`, functions `emitXPaste(canonical: string): EmitResult` and `emitXTypefully(canonical: string): EmitResult`.

- [ ] **Step 1: Write the failing test**

Create `tests/domain/formatting/emitters/x.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { emitXPaste, emitXTypefully } from "../../../../src/domain/formatting/emitters/x";

describe("emitXPaste", () => {
  it("strips bold to plain text — never unicode bold", () => {
    const r = emitXPaste("**메인넷** 출시");
    expect(r.segments[0].text).toBe("메인넷 출시");
    // U+1D5D4 is MATHEMATICAL SANS-SERIF BOLD CAPITAL A; nothing in that block may appear
    expect([...r.segments[0].text].every((c) => c.codePointAt(0)! < 0x1d400)).toBe(true);
  });

  it("rewrites markdown links as 'text (url)'", () => {
    expect(emitXPaste("공지 [자세히](https://x.io)").segments[0].text).toBe("공지 자세히 (https://x.io)");
  });

  it("turns post boundaries into segments and labels them", () => {
    const r = emitXPaste("하나\n\n\n둘\n\n\n셋");
    expect(r.segments.map((s) => s.text)).toEqual(["하나", "둘", "셋"]);
    expect(r.segments.map((s) => s.label)).toEqual(["트윗 1/3", "트윗 2/3", "트윗 3/3"]);
  });

  it("leaves a single post unlabelled", () => {
    expect(emitXPaste("혼자").segments[0].label).toBeUndefined();
  });

  it("measures each segment by weight, so 140 Hangul is at the limit and 141 is over", () => {
    const ok = emitXPaste("가".repeat(140));
    expect(ok.segments[0].length).toBe(280);
    expect(ok.segments[0].overLimit).toBe(false);
    expect(ok.warnings).toEqual([]);

    const over = emitXPaste("가".repeat(141));
    expect(over.segments[0].overLimit).toBe(true);
    expect(over.warnings).toEqual(["282/280 (2 초과)"]);
  });

  it("names the offending tweet when only one segment of a thread is over", () => {
    const r = emitXPaste(`짧음\n\n\n${"가".repeat(200)}`);
    expect(r.warnings).toEqual(["트윗 2/2: 400/280 (120 초과)"]);
  });

  it("never splits on its own — an over-limit post stays one segment", () => {
    expect(emitXPaste("가".repeat(500)).segments).toHaveLength(1);
  });
});

describe("emitXTypefully", () => {
  // Asserts real output, not `toEqual(emitXPaste(...))` — the two are the same function today,
  // so comparing them would assert nothing and would keep passing if both broke together.
  it("emits plain-text segments split on post boundaries, measured against the 280 limit", () => {
    const r = emitXTypefully("**하나**\n\n\n[둘](https://x.io)");
    expect(r.segments.map((s) => s.text)).toEqual(["하나", "둘 (https://x.io)"]);
    expect(r.segments.map((s) => s.limit)).toEqual([280, 280]);
    expect(r.warnings).toEqual([]);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm vitest run tests/domain/formatting/emitters/x.test.ts`
Expected: FAIL — `Failed to resolve import ".../emitters/x"`.

- [ ] **Step 3: Write the types**

Create `src/domain/formatting/emitters/types.ts`:

```ts
/**
 * Where a rendering actually ends up. A channel can have more than one: the same Telegram post
 * is spelled differently depending on whether a human pastes it into the app or a bot sends it
 * through the API.
 */
export type Destination =
  | "x_paste"
  | "x_typefully"
  | "telegram_paste"
  | "telegram_bot"
  | "kakao_paste"
  | "pr_mail";

export interface EmitSegment {
  text: string;
  /** Position label, e.g. "트윗 2/3". Absent when there is only one segment. */
  label?: string;
  /** Weighted units for x, characters for telegram/kakao, worst line in octets for pr_mail. */
  length: number;
  limit: number;
  overLimit: boolean;
}

export interface EmitResult {
  segments: EmitSegment[];
  warnings: string[];
}
```

- [ ] **Step 4: Write the X emitters**

Create `src/domain/formatting/emitters/x.ts`:

```ts
import { linksToPlain, splitPosts, stripBold } from "../canonical";
import { X_MAX_WEIGHTED, weightedLength } from "../weightedLength";
import type { EmitResult, EmitSegment } from "./types";

/**
 * X composers take plain text: pasted markdown is not parsed. Unicode "bold" is not a substitute
 * — screen readers skip the styled word entirely, X search does not match it, and every such
 * character costs 2 weighted units. Emphasis belongs in line breaks and structure instead.
 *
 * This never splits an over-limit post. A machine cut lands badly in Korean prose, and a cut made
 * silently here would never be reviewed by anyone; the writer splits, in `pnpm format --refine`.
 */
function emitX(canonical: string): EmitResult {
  const posts = splitPosts(canonical);
  const warnings: string[] = [];

  const segments: EmitSegment[] = posts.map((post, i) => {
    const text = linksToPlain(stripBold(post));
    const length = weightedLength(text);
    const overLimit = length > X_MAX_WEIGHTED;
    const segment: EmitSegment = { text, length, limit: X_MAX_WEIGHTED, overLimit };
    if (posts.length > 1) segment.label = `트윗 ${i + 1}/${posts.length}`;
    if (overLimit) {
      const where = posts.length > 1 ? `트윗 ${i + 1}/${posts.length}: ` : "";
      warnings.push(`${where}${length}/${X_MAX_WEIGHTED} (${length - X_MAX_WEIGHTED} 초과)`);
    }
    return segment;
  });

  return { segments, warnings };
}

export const emitXPaste = emitX;

/**
 * Typefully's editor is documented to re-split pasted text ("Make thread"), and no first-party
 * source describes a separator that pins our boundaries. Identical to `emitXPaste` until that is
 * verified against the live app — see "Unverified" in the design spec.
 */
export const emitXTypefully = emitX;
```

- [ ] **Step 5: Run test to verify it passes**

Run: `pnpm vitest run tests/domain/formatting/emitters/x.test.ts`
Expected: PASS, 8 tests.

- [ ] **Step 6: Run the full suite, typecheck, and commit**

```bash
pnpm test && pnpm typecheck
git add src/domain/formatting/emitters/ tests/domain/formatting/emitters/
git commit -m "feat: emit X paste and Typefully text from canonical renderings"
```

---

### Task 4: Telegram destinations

The subtle one. Paste and bot are genuinely different strings, and the escaping order in `emitTelegramBot` is load-bearing.

**Files:**
- Create: `src/domain/formatting/emitters/telegram.ts`
- Test: `tests/domain/formatting/emitters/telegram.test.ts`

**Interfaces:**
- Consumes: `stripBold`, `linksToPlain`, `linksToLabel` (Task 2); `EmitResult` (Task 3).
- Produces: `emitTelegramPaste(canonical: string): EmitResult`, `emitTelegramBot(canonical: string): EmitResult`, `TELEGRAM_MAX = 4096`.

- [ ] **Step 1: Write the failing test**

Create `tests/domain/formatting/emitters/telegram.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { emitTelegramPaste, emitTelegramBot, TELEGRAM_MAX } from "../../../../src/domain/formatting/emitters/telegram";

describe("emitTelegramPaste", () => {
  it("emits plain text — a client is not documented to parse markdown on paste", () => {
    const r = emitTelegramPaste("**중요** [자세히](https://x.io)");
    expect(r.segments[0].text).toBe("중요 자세히 (https://x.io)");
    expect(r.segments[0].text).not.toContain("*");
  });

  it("warns past 4096 characters without splitting", () => {
    const r = emitTelegramPaste("가".repeat(TELEGRAM_MAX + 5));
    expect(r.segments).toHaveLength(1);
    expect(r.segments[0].overLimit).toBe(true);
    expect(r.warnings[0]).toContain("4101/4096");
  });
});

describe("emitTelegramBot", () => {
  it("converts bold and links to HTML entities", () => {
    const r = emitTelegramBot("**중요** [자세히](https://x.io)");
    expect(r.segments[0].text).toBe('<b>중요</b> <a href="https://x.io">자세히</a>');
  });

  it("escapes &, < and > before inserting tags", () => {
    const r = emitTelegramBot("a < b & c > d");
    expect(r.segments[0].text).toBe("a &lt; b &amp; c &gt; d");
  });

  it("escapes & inside a URL query string", () => {
    const r = emitTelegramBot("[링크](https://x.io/?a=1&b=2)");
    expect(r.segments[0].text).toBe('<a href="https://x.io/?a=1&amp;b=2">링크</a>');
  });

  it("leaves Korean full stops, parentheses and hyphens untouched — the MarkdownV2 trap", () => {
    // MarkdownV2 would require escaping every one of . ( ) - here; HTML mode requires none
    const r = emitTelegramBot("맨틀(Mantle)은 L2-체인입니다. 확인해 주세요!");
    expect(r.segments[0].text).toBe("맨틀(Mantle)은 L2-체인입니다. 확인해 주세요!");
  });

  it("measures visible length after entity parsing, not the raw HTML", () => {
    // visible text is "중요 자세히" = 6 characters; the tags and URL do not count
    const r = emitTelegramBot("**중요** [자세히](https://x.io)");
    expect(r.segments[0].length).toBe(6);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm vitest run tests/domain/formatting/emitters/telegram.test.ts`
Expected: FAIL — `Failed to resolve import ".../emitters/telegram"`.

- [ ] **Step 3: Write the implementation**

Create `src/domain/formatting/emitters/telegram.ts`:

```ts
import { BOLD, MD_LINK, linksToLabel, linksToPlain, stripBold } from "../canonical";
import type { EmitResult } from "./types";

/** sendMessage's text limit, counted after entity parsing. https://core.telegram.org/bots/api */
export const TELEGRAM_MAX = 4096;

function single(text: string, visibleLength: number): EmitResult {
  const overLimit = visibleLength > TELEGRAM_MAX;
  return {
    segments: [{ text, length: visibleLength, limit: TELEGRAM_MAX, overLimit }],
    warnings: overLimit
      ? [`${visibleLength}/${TELEGRAM_MAX}자 (${visibleLength - TELEGRAM_MAX} 초과) — 나누어 보내야 합니다`]
      : [],
  };
}

/**
 * Telegram's API docs put markdown parsing on each client, and its own bug tracker records client
 * formatting diverging from the Bot API's. Nothing is documented to render on the paste path, so
 * emit plain text — `*bold*` here would show up as literal asterisks.
 */
export function emitTelegramPaste(canonical: string): EmitResult {
  const text = linksToPlain(stripBold(canonical));
  return single(text, [...text].length);
}

/**
 * For `sendMessage` with `parse_mode: "HTML"` — never MarkdownV2, which requires escaping 18
 * characters including `.`, `(`, `)` and `-`, all of which saturate Korean prose. HTML mode needs
 * only `&`, `<` and `>`.
 *
 * Escaping runs before tag insertion. That is safe because HTML escaping never introduces `*`,
 * `[`, `]`, `(` or `)`, and it is necessary so that an `&` inside a URL query string is escaped
 * too.
 */
export function emitTelegramBot(canonical: string): EmitResult {
  const escaped = canonical
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
  const html = escaped.replace(BOLD, "<b>$1</b>").replace(MD_LINK, '<a href="$2">$1</a>');
  // "after entities parsing" means the text the reader sees: no markup, no href.
  const visible = [...stripBold(linksToLabel(canonical))].length;
  return single(html, visible);
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm vitest run tests/domain/formatting/emitters/telegram.test.ts`
Expected: PASS, 7 tests.

- [ ] **Step 5: Run the full suite, typecheck, and commit**

```bash
pnpm test && pnpm typecheck
git add src/domain/formatting/emitters/telegram.ts tests/domain/formatting/emitters/telegram.test.ts
git commit -m "feat: emit Telegram paste text and HTML-mode bot text separately"
```

---

### Task 5: KakaoTalk, PR mail, and the dispatcher

**Files:**
- Create: `src/domain/formatting/emitters/kakao.ts`, `src/domain/formatting/emitters/prMail.ts`, `src/domain/formatting/emitters/index.ts`
- Test: `tests/domain/formatting/emitters/kakao.test.ts`, `tests/domain/formatting/emitters/prMail.test.ts`, `tests/domain/formatting/emitters/index.test.ts`

**Interfaces:**
- Consumes: `stripBold`, `linksToPlain` (Task 2); `EmitResult`, `Destination` (Task 3); the emitters from Tasks 3–4; `Channel` from `src/domain/formatting/models.ts`.
- Produces: `emitKakaoPaste`, `KAKAO_FOLD = 500`, `emitPrMail`, `MAIL_MAX_LINE_OCTETS = 998`, `emit(canonical, destination): EmitResult`, `emitAll(canonical, channel): Partial<Record<Destination, EmitResult>>`, `DESTINATIONS_BY_CHANNEL`.

- [ ] **Step 1: Write the failing tests**

Create `tests/domain/formatting/emitters/kakao.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { emitKakaoPaste, KAKAO_FOLD } from "../../../../src/domain/formatting/emitters/kakao";

describe("emitKakaoPaste", () => {
  it("emits plain text — KakaoTalk has no formatting at all", () => {
    const r = emitKakaoPaste("**공지** [자세히](https://x.io)");
    expect(r.segments[0].text).toBe("공지 자세히 (https://x.io)");
  });

  it("warns past the 500-character fold without splitting", () => {
    const r = emitKakaoPaste("가".repeat(KAKAO_FOLD + 1));
    expect(r.segments).toHaveLength(1);
    expect(r.segments[0].overLimit).toBe(true);
    expect(r.warnings[0]).toContain("전체보기");
  });

  it("stays quiet at exactly 500 characters", () => {
    expect(emitKakaoPaste("가".repeat(KAKAO_FOLD)).warnings).toEqual([]);
  });
});
```

Create `tests/domain/formatting/emitters/prMail.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { emitPrMail, MAIL_MAX_LINE_OCTETS } from "../../../../src/domain/formatting/emitters/prMail";

describe("emitPrMail", () => {
  it("lifts the first line into 제목 and keeps the rest as the body", () => {
    const r = emitPrMail("맨틀, 메인넷 출시\n\n**본문** 내용입니다.");
    expect(r.segments[0].text).toBe("제목: 맨틀, 메인넷 출시\n\n본문 내용입니다.");
  });

  it("does not hard-wrap — mail clients re-wrap pasted text themselves", () => {
    const long = "가".repeat(200);
    expect(emitPrMail(`제목줄\n\n${long}`).segments[0].text).toContain(long);
  });

  it("warns when a line exceeds 998 octets, counting Hangul as 3 octets each", () => {
    // 333 Hangul = 999 octets, one past the RFC 5322 MUST
    const r = emitPrMail(`제목줄\n\n${"가".repeat(333)}`);
    expect(r.segments[0].overLimit).toBe(true);
    expect(r.warnings[0]).toContain(String(MAIL_MAX_LINE_OCTETS));
  });

  it("stays quiet when every line fits", () => {
    expect(emitPrMail("제목줄\n\n짧은 본문").warnings).toEqual([]);
  });
});
```

Create `tests/domain/formatting/emitters/index.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { emit, emitAll, DESTINATIONS_BY_CHANNEL } from "../../../../src/domain/formatting/emitters";
import { emitTelegramBot } from "../../../../src/domain/formatting/emitters/telegram";

describe("emit", () => {
  it("dispatches to the named destination", () => {
    expect(emit("**중요**", "telegram_bot")).toEqual(emitTelegramBot("**중요**"));
  });
});

describe("emitAll", () => {
  it("returns only the destinations that apply to the channel", () => {
    expect(Object.keys(emitAll("본문", "telegram"))).toEqual(["telegram_paste", "telegram_bot"]);
    expect(Object.keys(emitAll("본문", "kakao"))).toEqual(["kakao_paste"]);
    expect(Object.keys(emitAll("본문", "x"))).toEqual(["x_paste", "x_typefully"]);
  });
});

describe("DESTINATIONS_BY_CHANNEL", () => {
  it("covers every channel", () => {
    expect(Object.keys(DESTINATIONS_BY_CHANNEL)).toEqual(["x", "telegram", "kakao", "pr_mail"]);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm vitest run tests/domain/formatting/emitters/`
Expected: FAIL — three unresolved imports (`kakao`, `prMail`, `emitters/index`). The `x` and `telegram` suites still pass.

- [ ] **Step 3: Write the Kakao emitter**

Create `src/domain/formatting/emitters/kakao.ts`:

```ts
import { linksToPlain, stripBold } from "../canonical";
import type { EmitResult } from "./types";

/**
 * Past this, KakaoTalk folds the bubble behind a 「전체보기」 button and the body is hidden until
 * the reader taps it. Kakao's own CS spec: "단일형 버튼 미사용시 : 1,000자(500자 초과시 전체보기
 * 버튼을 통해 확인가능)". https://cs.kakao.com/helps_html/1073201585?locale=ko
 */
export const KAKAO_FOLD = 500;

/** KakaoTalk parses no markup of any kind and its composer offers no formatting. */
export function emitKakaoPaste(canonical: string): EmitResult {
  const text = linksToPlain(stripBold(canonical));
  const length = [...text].length;
  const overLimit = length > KAKAO_FOLD;
  return {
    segments: [{ text, length, limit: KAKAO_FOLD, overLimit }],
    warnings: overLimit
      ? [`${length}/${KAKAO_FOLD}자 — 「전체보기」로 접힙니다. 나누는 것을 권합니다`]
      : [],
  };
}
```

- [ ] **Step 4: Write the PR mail emitter**

Create `src/domain/formatting/emitters/prMail.ts`:

```ts
import { linksToPlain, stripBold } from "../canonical";
import type { EmitResult } from "./types";

/**
 * RFC 5322 §2.1.1 makes 998 a MUST per line, and RFC 5321 §4.5.3.1.6 enforces it in **octets**.
 * UTF-8 Hangul is 3 octets per syllable, so this is reached at ~332 Korean characters — a very
 * different number from the 78-character SHOULD.
 */
export const MAIL_MAX_LINE_OCTETS = 998;

const encoder = new TextEncoder();
const octets = (line: string): number => encoder.encode(line).length;

/**
 * Subject on the first line, body after. Deliberately not hard-wrapped at 78 columns: that SHOULD
 * applies to mail actually put on the wire, and pre-wrapped text pasted into Gmail or Outlook is
 * re-wrapped by the client and reads as ragged. Subject encoding (RFC 2047) belongs to whatever
 * eventually sends the mail, not to this emitter.
 *
 * `length` and `limit` here describe the longest line in octets, not the whole message.
 */
export function emitPrMail(canonical: string): EmitResult {
  const plain = linksToPlain(stripBold(canonical));
  const lines = plain.split("\n");
  const subject = (lines.shift() ?? "").trim();
  const body = lines.join("\n").trim();
  const text = `제목: ${subject}\n\n${body}`;

  const measured = text.split("\n").map((line, i) => ({ line: i + 1, n: octets(line) }));
  const warnings = measured
    .filter(({ n }) => n > MAIL_MAX_LINE_OCTETS)
    .map(({ line, n }) => `${line}번째 줄이 ${n}옥텟 — RFC 5322 상한 ${MAIL_MAX_LINE_OCTETS}옥텟 초과`);
  const worst = Math.max(0, ...measured.map(({ n }) => n));

  return {
    segments: [{ text, length: worst, limit: MAIL_MAX_LINE_OCTETS, overLimit: warnings.length > 0 }],
    warnings,
  };
}
```

- [ ] **Step 5: Write the dispatcher**

Create `src/domain/formatting/emitters/index.ts`:

```ts
import type { Channel } from "../models";
import { emitKakaoPaste } from "./kakao";
import { emitPrMail } from "./prMail";
import { emitTelegramBot, emitTelegramPaste } from "./telegram";
import type { Destination, EmitResult } from "./types";
import { emitXPaste, emitXTypefully } from "./x";

export type { Destination, EmitResult, EmitSegment } from "./types";

const EMITTERS: Record<Destination, (canonical: string) => EmitResult> = {
  x_paste: emitXPaste,
  x_typefully: emitXTypefully,
  telegram_paste: emitTelegramPaste,
  telegram_bot: emitTelegramBot,
  kakao_paste: emitKakaoPaste,
  pr_mail: emitPrMail,
};

/**
 * A rendering is already channel-scoped — which channels a type fans out to was decided upstream
 * by DEFAULT_CHANNELS_BY_TYPE — so only these destinations apply to it. A kakao rendering has no
 * meaningful telegram_bot spelling.
 */
export const DESTINATIONS_BY_CHANNEL: Record<Channel, Destination[]> = {
  x: ["x_paste", "x_typefully"],
  telegram: ["telegram_paste", "telegram_bot"],
  kakao: ["kakao_paste"],
  pr_mail: ["pr_mail"],
};

export function emit(canonical: string, destination: Destination): EmitResult {
  return EMITTERS[destination](canonical);
}

/** Every destination that applies to `channel`, keyed by destination. */
export function emitAll(canonical: string, channel: Channel): Partial<Record<Destination, EmitResult>> {
  const out: Partial<Record<Destination, EmitResult>> = {};
  for (const destination of DESTINATIONS_BY_CHANNEL[channel]) {
    out[destination] = emit(canonical, destination);
  }
  return out;
}
```

- [ ] **Step 6: Run tests to verify they pass**

Run: `pnpm vitest run tests/domain/formatting/`
Expected: PASS — all emitter suites plus `weightedLength` and `canonical`.

- [ ] **Step 7: Run the full suite, typecheck, and commit**

```bash
pnpm test && pnpm typecheck
git add src/domain/formatting/emitters/ tests/domain/formatting/emitters/
git commit -m "feat: emit KakaoTalk and PR mail text, add the destination dispatcher"
```

---

### Task 6: Switch the app layer to canonical + emitters

The changeover. `formatForChannel` and every trace of unicode bold go away in one commit so the tree is never half-migrated.

**Files:**
- Modify: `src/domain/formatting/models.ts:19-25`, `src/app/FormatVariants.ts`, `src/app/PrepareRefinements.ts`, `src/cli/format.ts`
- Delete: `src/domain/formatting/channelFormat.ts`, `tests/domain/formatting/channelFormat.test.ts`
- Test: `tests/app/FormatVariants.test.ts` (update), `tests/app/PrepareRefinements.test.ts` (update)

**Interfaces:**
- Consumes: `toCanonical` (Task 2), `emitAll` (Task 5).
- Produces: `FormatVariants` and `PrepareRefinements` constructors lose their `FormatOptions` parameter — `new FormatVariants(conversionStore, formattingStore, now?)` and `new PrepareRefinements(conversionStore)`. `FormatOptions` and `FormatResult` no longer exist.

- [ ] **Step 1: Update the existing tests to the new constructor shapes**

In `tests/app/FormatVariants.test.ts`, every `new FormatVariants(s.conversionStore, s.formattingStore, {}, () => "…")` drops the `{}`:

```ts
const uc = new FormatVariants(s.conversionStore, s.formattingStore, () => "2026-03-03T00:00:00.000Z");
```

Add a test that canonical text is what gets stored:

```ts
it("stores canonical text — bold and links survive, destination syntax does not", async () => {
  const s = stores([variant({ convertedText: "**메인넷** [자세히](https://x.io)" })]);
  const uc = new FormatVariants(s.conversionStore, s.formattingStore, () => "2026-03-03T00:00:00.000Z");
  const { renderings } = await uc.run({});
  expect(renderings[0].text).toBe("**메인넷** [자세히](https://x.io)");
});

it("warns via the channel's destinations, counting Hangul as 2 for x", async () => {
  const s = stores([variant({ type: "x", convertedText: "가".repeat(141) })]);
  const uc = new FormatVariants(s.conversionStore, s.formattingStore, () => "2026-03-03T00:00:00.000Z");
  const { warnings } = await uc.run({});
  expect(warnings[0].messages.some((m) => m.includes("282/280"))).toBe(true);
});
```

In `tests/app/PrepareRefinements.test.ts`, the existing assertion `expect(worksheet).toContain("메인넷 출시")` must become `expect(worksheet).toContain("**메인넷** 출시")` — the draft is canonical now, so `**` is no longer stripped.

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm vitest run tests/app/FormatVariants.test.ts tests/app/PrepareRefinements.test.ts`
Expected: FAIL — the new canonical assertions fail against the old `formatForChannel` behaviour.

- [ ] **Step 3: Remove `FormatOptions` and `FormatResult`**

In `src/domain/formatting/models.ts`, delete these two blocks entirely:

```ts
export interface FormatOptions {
  xBold?: "plain" | "unicode";
}

export interface FormatResult {
  text: string;
  warnings: string[];
}
```

Leave `Channel`, `ALL_CHANNELS`, `DEFAULT_CHANNELS_BY_TYPE` and `ChannelRendering` untouched.

- [ ] **Step 4: Delete the old formatter, keeping its channel-map coverage**

`channelFormat.test.ts` also covers `DEFAULT_CHANNELS_BY_TYPE` and `ALL_CHANNELS`, which are not
going away. Move that block to a new `tests/domain/formatting/models.test.ts` first:

```ts
import { describe, it, expect } from "vitest";
import { DEFAULT_CHANNELS_BY_TYPE, ALL_CHANNELS } from "../../../src/domain/formatting/models";

describe("DEFAULT_CHANNELS_BY_TYPE", () => {
  it("maps each type to its default channels", () => {
    expect(DEFAULT_CHANNELS_BY_TYPE.x).toEqual(["x"]);
    expect(DEFAULT_CHANNELS_BY_TYPE.announcement).toEqual(["telegram", "kakao"]);
    expect(DEFAULT_CHANNELS_BY_TYPE.kol).toEqual(["telegram"]);
    expect(DEFAULT_CHANNELS_BY_TYPE.pr).toEqual(["pr_mail"]);
    // telegram carries two types on purpose: an announcement and a KOL request are different copy
    expect(DEFAULT_CHANNELS_BY_TYPE.announcement).toContain("telegram");
    expect(DEFAULT_CHANNELS_BY_TYPE.kol).toContain("telegram");
    expect(ALL_CHANNELS).toEqual(["x", "telegram", "kakao", "pr_mail"]);
  });
});
```

Then remove the old files:

```bash
git rm src/domain/formatting/channelFormat.ts tests/domain/formatting/channelFormat.test.ts
```

The `formatForChannel` cases themselves are not carried over — each one is now an emitter test in
Tasks 3–5.

- [ ] **Step 5: Rewrite `FormatVariants`**

In `src/app/FormatVariants.ts`, replace the first three imports and the class body's formatting
call. The full new file:

```ts
import { ALL_TYPES, type ConversionType, type ContentVariant } from "../domain/conversion/models";
import { toCanonical } from "../domain/formatting/canonical";
import { emitAll } from "../domain/formatting/emitters";
import { DEFAULT_CHANNELS_BY_TYPE, type Channel, type ChannelRendering } from "../domain/formatting/models";
import type { ConversionStore } from "../ports/ConversionStore";
import type { FormattingStore } from "../ports/FormattingStore";

export interface FormatSelector {
  ids?: string[];
  types?: ConversionType[];
  channels?: Channel[];
}

export interface FormatWarning {
  itemId: string;
  type: ConversionType;
  channel: Channel;
  messages: string[];
}

/** Load the approved variants matching the selector's types + ids. Shared by the §6 use-cases. */
export async function selectApprovedVariants(store: ConversionStore, selector: FormatSelector): Promise<ContentVariant[]> {
  const types = selector.types ?? ALL_TYPES;
  const wantedIds = selector.ids && selector.ids.length > 0 ? new Set(selector.ids) : undefined;
  return (await store.loadAll()).filter(
    (v) => v.status === "approved" && types.includes(v.type) && (!wantedIds || wantedIds.has(v.itemId)),
  );
}

export class FormatVariants {
  constructor(
    private readonly conversionStore: ConversionStore,
    private readonly formattingStore: FormattingStore,
    private readonly now: () => string = () => new Date().toISOString(),
  ) {}

  async run(selector: FormatSelector): Promise<{ renderings: ChannelRendering[]; warnings: FormatWarning[] }> {
    const approved = await selectApprovedVariants(this.conversionStore, selector);

    const renderings: ChannelRendering[] = [];
    const warnings: FormatWarning[] = [];
    for (const v of approved) {
      const channels = selector.channels ?? DEFAULT_CHANNELS_BY_TYPE[v.type];
      // The same canonical text is stored for every channel on purpose: it is a common starting
      // point that the writer can then refine per channel, which is what per-channel approval is for.
      const text = toCanonical(v.convertedText);
      for (const channel of channels) {
        const rendering: ChannelRendering = {
          itemId: v.itemId, type: v.type, channel, text, refined: false, createdAt: this.now(), status: "rendered",
        };
        await this.formattingStore.upsert(rendering);
        renderings.push(rendering);
        const messages = Object.values(emitAll(text, channel)).flatMap((r) => r.warnings);
        if (messages.length > 0) warnings.push({ itemId: v.itemId, type: v.type, channel, messages });
      }
    }
    return { renderings, warnings };
  }
}
```

- [ ] **Step 6: Rewrite `PrepareRefinements`**

In `src/app/PrepareRefinements.ts`, drop the `FormatOptions` import and constructor parameter and
use `toCanonical` for the draft. Replace the imports and the class:

```ts
import type { ConversionType } from "../domain/conversion/models";
import { toCanonical } from "../domain/formatting/canonical";
import { DEFAULT_CHANNELS_BY_TYPE, type Channel } from "../domain/formatting/models";
import { assembleRefinementWorksheet, type RefinementDraft } from "../domain/formatting/refinementWorksheet";
import type { ConversionStore } from "../ports/ConversionStore";
import { selectApprovedVariants, type FormatSelector } from "./FormatVariants";

export interface PendingRendering {
  itemId: string;
  type: ConversionType;
  channel: Channel;
}

export class PrepareRefinements {
  constructor(private readonly conversionStore: ConversionStore) {}

  async run(selector: FormatSelector): Promise<{ worksheet: string; pending: PendingRendering[] }> {
    const approved = await selectApprovedVariants(this.conversionStore, selector);

    const drafts: RefinementDraft[] = [];
    for (const v of approved) {
      const channels = selector.channels ?? DEFAULT_CHANNELS_BY_TYPE[v.type];
      const draft = toCanonical(v.convertedText);
      for (const channel of channels) {
        drafts.push({ itemId: v.itemId, type: v.type, channel, draft });
      }
    }

    const worksheet = assembleRefinementWorksheet(drafts);
    const pending = drafts.map((d) => ({ itemId: d.itemId, type: d.type, channel: d.channel }));
    return { worksheet, pending };
  }
}
```

(The `assembleRefinementWorksheet` signature changes in Task 7; leave the single-argument call here.)

- [ ] **Step 7: Update the CLI**

In `src/cli/format.ts`, change the `models` import to drop `FormatOptions`:

```ts
import { ALL_CHANNELS, type Channel } from "../domain/formatting/models";
```

Replace the `const opts: FormatOptions = …` line with an explicit rejection:

```ts
if (process.argv.includes("--x-bold")) {
  throw new Error(
    "--x-bold was removed. Unicode bold (𝗔) is skipped entirely by screen readers, is not matched " +
      "by X search, and costs 2 weighted characters per letter. Write **bold** in the canonical " +
      "text instead — each destination decides how to spell it.",
  );
}
```

Drop `opts` from both construction sites:

```ts
const { worksheet, pending } = await new PrepareRefinements(conversionStore).run(selector);
```

```ts
const { renderings, warnings } = await new FormatVariants(conversionStore, new JsonFormattingStore(paths.formattedDir)).run(selector);
```

- [ ] **Step 8: Run the full suite**

Run: `pnpm test && pnpm typecheck`
Expected: PASS. If `tests/app/PrepareRefinements.test.ts` still asserts stripped bold, fix the
assertion as described in Step 1 — canonical keeps `**`.

- [ ] **Step 9: Commit**

```bash
git add -A src/domain/formatting src/app/FormatVariants.ts src/app/PrepareRefinements.ts src/cli/format.ts tests/
git commit -m "refactor: store canonical renderings and drop the unicode-bold formatter"
```

---

### Task 7: Refinement worksheet

Gives `--refine` a header that states every constraint, generated from the same constants the emitters use so the two can never drift.

**Files:**
- Modify: `src/domain/formatting/refinementWorksheet.ts`, `src/app/PrepareRefinements.ts`, `src/cli/format.ts`
- Test: `tests/app/PrepareRefinements.test.ts`

**Interfaces:**
- Consumes: `emit`, `DESTINATIONS_BY_CHANNEL` (Task 5); `GlossaryEntry` from `src/domain/translation/models.ts`; `renderGlossaryEntry` from `src/domain/translation/promptAssembler.ts`; `GlossaryStore` port; `JsonGlossaryStore` adapter.
- Produces: `assembleRefinementWorksheet(drafts: RefinementDraft[], glossary: GlossaryEntry[]): string`; `PrepareRefinements` constructor becomes `(conversionStore, glossaryStore)`.

- [ ] **Step 1: Write the failing test**

Append to `tests/app/PrepareRefinements.test.ts`. Add these imports at the top of the file:

```ts
import type { GlossaryStore } from "../../src/ports/GlossaryStore";
import type { GlossaryEntry } from "../../src/domain/translation/models";

function glossaryStore(list: GlossaryEntry[] = []): GlossaryStore {
  return { load: async () => list, upsertEntry: async () => {} };
}
const entry = (term: string, target: string): GlossaryEntry =>
  ({ term, rule: "transliterate", target, updatedAt: "2026-01-01T00:00:00.000Z" });
```

Every existing `new PrepareRefinements(conversionStore([...]))` becomes
`new PrepareRefinements(conversionStore([...]), glossaryStore())`. Then add:

```ts
describe("PrepareRefinements — worksheet header", () => {
  it("states the constraints of the channels present in the batch, and no others", async () => {
    const { worksheet } = await new PrepareRefinements(
      conversionStore([variant({ type: "announcement" })]),
      glossaryStore(),
    ).run({});
    expect(worksheet).toContain("## 채널 제약");
    expect(worksheet).toContain("telegram: 메시지당 4096자");
    expect(worksheet).toContain("500자 초과 시");
    expect(worksheet).not.toContain("트윗당 280 가중치"); // no x channel in this batch
  });

  it("warns against unicode bold in the 쓰는 법 section", async () => {
    const { worksheet } = await new PrepareRefinements(conversionStore([variant()]), glossaryStore()).run({});
    expect(worksheet).toContain("스크린리더");
  });

  it("includes only glossary terms that appear in a draft", async () => {
    const { worksheet } = await new PrepareRefinements(
      conversionStore([variant({ convertedText: "Mantle 메인넷 출시" })]),
      glossaryStore([entry("Mantle", "맨틀"), entry("Ethereum", "이더리움")]),
    ).run({});
    expect(worksheet).toContain("Mantle");
    expect(worksheet).not.toContain("Ethereum");
  });

  it("omits the glossary section entirely when no term appears", async () => {
    const { worksheet } = await new PrepareRefinements(
      conversionStore([variant({ convertedText: "아무 용어 없음" })]),
      glossaryStore([entry("Mantle", "맨틀")]),
    ).run({});
    expect(worksheet).not.toContain("## 용어집");
  });

  it("reports weighted length per tweet and names the segment that is over", async () => {
    const { worksheet } = await new PrepareRefinements(
      conversionStore([variant({ type: "x", convertedText: `짧음\n\n\n${"가".repeat(200)}` })]),
      glossaryStore(),
    ).run({});
    expect(worksheet).toContain("트윗 1/2");
    expect(worksheet).toContain("⚠");
    expect(worksheet).toContain("400/280");
    expect(worksheet).toContain("120 초과");
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm vitest run tests/app/PrepareRefinements.test.ts`
Expected: FAIL — `PrepareRefinements` takes one argument, and the worksheet has no header sections.

- [ ] **Step 3: Rewrite the worksheet assembler**

Replace `src/domain/formatting/refinementWorksheet.ts` entirely:

```ts
import { typeLabel, type ConversionType } from "../conversion/models";
import type { GlossaryEntry } from "../translation/models";
import { renderGlossaryEntry } from "../translation/promptAssembler";
import { DESTINATIONS_BY_CHANNEL, emit } from "./emitters";
import { KAKAO_FOLD } from "./emitters/kakao";
import { TELEGRAM_MAX } from "./emitters/telegram";
import type { Channel } from "./models";
import { TCO_LENGTH, X_MAX_WEIGHTED } from "./weightedLength";

export interface RefinementDraft {
  itemId: string;
  type: ConversionType;
  channel: Channel;
  draft: string;
}

/** Generated from the emitters' own constants, so the worksheet can never drift from the code. */
const CONSTRAINT: Record<Channel, string> = {
  x: `- x: 트윗당 ${X_MAX_WEIGHTED} 가중치 (**한글·이모지는 2**, 그 외 1, URL은 길이 무관 ${TCO_LENGTH})`,
  telegram: `- telegram: 메시지당 ${TELEGRAM_MAX}자`,
  kakao: `- kakao: **${KAKAO_FOLD}자 초과 시 말풍선이 「전체보기」로 접힙니다**`,
  pr_mail: `- pr_mail: 첫 줄이 제목`,
};

const HOW_TO = [
  "## 쓰는 법",
  "- 볼드는 `**이렇게**`, 링크는 `[텍스트](URL)`로 씁니다. 목적지별 문법 변환은 코드가 합니다.",
  "- x 채널에서 **빈 줄 두 개 = 트윗 경계**입니다.",
  "- 유니코드 볼드(𝗔)는 쓰지 마세요 — 스크린리더가 단어를 통째로 건너뜁니다.",
].join("\n");

/** The primary destination is the one whose numbers the worksheet reports. */
function report(channel: Channel, draft: string): string {
  const { segments } = emit(draft, DESTINATIONS_BY_CHANNEL[channel][0]);
  return segments
    .map((s) => {
      const mark = s.overLimit ? "⚠ " : "";
      const where = s.label ? `${s.label} — ` : "";
      const over = s.overLimit ? ` (${s.length - s.limit} 초과)` : "";
      return `${mark}${where}**${s.length}/${s.limit}**${over}`;
    })
    .join("\n");
}

function glossarySection(glossary: GlossaryEntry[], allDrafts: string): string | undefined {
  const haystack = allDrafts.toLowerCase();
  const used = glossary.filter((e) => haystack.includes(e.term.toLowerCase()));
  if (used.length === 0) return undefined;
  return ["## 용어집 (초안에 등장하는 것만)", ...used.map(renderGlossaryEntry)].join("\n");
}

export function assembleRefinementWorksheet(drafts: RefinementDraft[], glossary: GlossaryEntry[]): string {
  const channels = [...new Set(drafts.map((d) => d.channel))];
  const constraints = ["## 채널 제약", ...channels.map((c) => CONSTRAINT[c])].join("\n");
  const glossaryBlock = glossarySection(glossary, drafts.map((d) => d.draft).join("\n"));

  const blocks = drafts.map((d) =>
    [
      `## ${d.itemId} · ${typeLabel(d.type)} · ${d.channel}`,
      report(d.channel, d.draft),
      "",
      "초안:",
      d.draft,
      "보정:",
      "",
    ].join("\n"),
  );

  return [
    "# Mantle KR 채널 포매팅 보정 작업",
    "",
    HOW_TO,
    "",
    constraints,
    "",
    ...(glossaryBlock ? [glossaryBlock, ""] : []),
    ...blocks,
  ].join("\n");
}
```

- [ ] **Step 4: Inject the glossary through `PrepareRefinements`**

In `src/app/PrepareRefinements.ts`, add the import and the constructor dependency, and pass the
glossary through:

```ts
import type { GlossaryStore } from "../ports/GlossaryStore";
```

```ts
  constructor(
    private readonly conversionStore: ConversionStore,
    private readonly glossaryStore: GlossaryStore,
  ) {}
```

```ts
    const glossary = await this.glossaryStore.load();
    const worksheet = assembleRefinementWorksheet(drafts, glossary);
```

- [ ] **Step 5: Wire the adapter in the CLI**

In `src/cli/format.ts`, add the import:

```ts
import { JsonGlossaryStore } from "../adapters/store/JsonGlossaryStore";
```

and pass the store:

```ts
const { worksheet, pending } = await new PrepareRefinements(
  conversionStore,
  new JsonGlossaryStore(paths.translationConfigDir),
).run(selector);
```

- [ ] **Step 6: Run tests to verify they pass**

Run: `pnpm test && pnpm typecheck`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add src/domain/formatting/refinementWorksheet.ts src/app/PrepareRefinements.ts src/cli/format.ts tests/app/PrepareRefinements.test.ts
git commit -m "feat: give the refine worksheet channel constraints and a length report"
```

---

### Task 8: Emissions API route

**Files:**
- Modify: `src/adapters/web/apiHandlers.ts:107-141`
- Test: `tests/adapters/web/apiHandlers.test.ts`

**Interfaces:**
- Consumes: `emitAll` (Task 5).
- Produces: `GET /api/renderings/:itemId/:type/:channel/emissions` → `Partial<Record<Destination, EmitResult>>`.

- [ ] **Step 1: Write the failing test**

Append to `tests/adapters/web/apiHandlers.test.ts`:

```ts
describe("GET /api/renderings/:id/:type/:channel/emissions", () => {
  it("returns only the destinations of that rendering's channel", async () => {
    const deps = makeDeps([], [rnd({ channel: "telegram", type: "announcement", text: "**중요**" })]);
    const res = await handleApi(deps, "GET", "/api/renderings/x%3A1/announcement/telegram/emissions", undefined);
    expect(res.status).toBe(200);
    expect(Object.keys(res.json as object)).toEqual(["telegram_paste", "telegram_bot"]);
  });

  it("emits each destination's own spelling", async () => {
    const deps = makeDeps([], [rnd({ channel: "telegram", type: "announcement", text: "**중요**" })]);
    const res = await handleApi(deps, "GET", "/api/renderings/x%3A1/announcement/telegram/emissions", undefined);
    const json = res.json as Record<string, { segments: { text: string }[] }>;
    expect(json.telegram_paste.segments[0].text).toBe("중요");
    expect(json.telegram_bot.segments[0].text).toBe("<b>중요</b>");
  });

  it("404s for an unknown rendering", async () => {
    const deps = makeDeps([], []);
    const res = await handleApi(deps, "GET", "/api/renderings/x%3A9/x/x/emissions", undefined);
    expect(res.status).toBe(404);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm vitest run tests/adapters/web/apiHandlers.test.ts`
Expected: FAIL — the first two cases get `404` because the route does not exist.

- [ ] **Step 3: Add the route**

In `src/adapters/web/apiHandlers.ts`, add the import:

```ts
import { emitAll } from "../../domain/formatting/emitters";
```

Inside the existing `if (segments.length >= 5) { … }` block (the one that decodes `itemId`, `type`
and `channel`), add after the `approve` handler:

```ts
      if (method === "GET" && segments.length === 6 && segments[5] === "emissions") {
        const existing = (await deps.formattingStore.loadAll()).find(
          (r) => r.itemId === itemId && r.type === type && r.channel === channel,
        );
        if (!existing) return { status: 404, json: { error: "not found" } };
        return { status: 200, json: emitAll(existing.text, channel) };
      }
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm vitest run tests/adapters/web/apiHandlers.test.ts`
Expected: PASS.

- [ ] **Step 5: Run the full suite, typecheck, and commit**

```bash
pnpm test && pnpm typecheck
git add src/adapters/web/apiHandlers.ts tests/adapters/web/apiHandlers.test.ts
git commit -m "feat: serve per-destination emissions for a rendering"
```

---

### Task 9: Dashboard destination tabs

**Files:**
- Modify: `web/src/types.ts`, `web/src/api.ts`, `web/src/components/RenderingDetail.tsx`

**Interfaces:**
- Consumes: the emissions route (Task 8).
- Produces: no backend interface. `api.emissions(itemId, type, channel)` on the frontend.

- [ ] **Step 1: Mirror the types**

Append to `web/src/types.ts`, next to the existing mirrored types:

```ts
// Mirrors src/domain/formatting/emitters/types.ts — keep in sync.
export type Destination =
  | "x_paste" | "x_typefully"
  | "telegram_paste" | "telegram_bot"
  | "kakao_paste" | "pr_mail";

export interface EmitSegment {
  text: string;
  label?: string;
  length: number;
  limit: number;
  overLimit: boolean;
}
export interface EmitResult {
  segments: EmitSegment[];
  warnings: string[];
}
export type Emissions = Partial<Record<Destination, EmitResult>>;

export const DESTINATION_LABEL: Record<Destination, string> = {
  x_paste: "X 붙여넣기",
  x_typefully: "Typefully",
  telegram_paste: "텔레그램",
  telegram_bot: "텔레그램 봇",
  kakao_paste: "카카오",
  pr_mail: "메일",
};
```

- [ ] **Step 2: Add the API call**

In `web/src/api.ts`, add `Emissions` to the type import from `./types`, then add to the `api`
object after `approveRendering`:

```ts
  emissions: (itemId: string, type: ConversionType, channel: Channel) =>
    fetch(`${rPath(itemId, type, channel)}/emissions`).then((r) => json<Emissions>(r)),
```

- [ ] **Step 3: Render the tabs and copy buttons**

In `web/src/components/RenderingDetail.tsx`, replace the `Rendering` type import with:

```ts
import { api } from "../api";
import { DESTINATION_LABEL, type Destination, type Emissions, type Rendering } from "../types";
```

Add this state and effect after the existing `copied` state, and delete the old `copy` function:

```ts
  const [emissions, setEmissions] = useState<Emissions>({});
  const [tab, setTab] = useState<Destination | null>(null);
  const [copiedKey, setCopiedKey] = useState<string | null>(null);

  useEffect(() => {
    let live = true;
    api
      .emissions(props.item.itemId, props.item.type, props.item.channel)
      .then((e) => {
        if (!live) return;
        setEmissions(e);
        setTab(Object.keys(e)[0] as Destination);
      })
      .catch(() => {
        if (live) setEmissions({});
      });
    return () => {
      live = false;
    };
  }, [props.item.itemId, props.item.type, props.item.channel, props.item.text]);

  const copy = async (key: string, text: string) => {
    await navigator.clipboard.writeText(text);
    setCopiedKey(key);
    setTimeout(() => setCopiedKey(null), 1500);
  };
```

Replace the single 복사 button in the button row with nothing (the button row keeps only 저장 and
승인), and append this block after the button row's closing `</div>`:

```tsx
      {tab && (
        <div className="mt-6">
          <h3 className="text-lg font-semibold text-neutral-700 mb-2">목적지별 출력</h3>
          <div className="flex gap-1.5 mb-3 flex-wrap">
            {(Object.keys(emissions) as Destination[]).map((d) => (
              <button
                key={d}
                className={`px-3 py-1 text-sm rounded-md border ${
                  d === tab ? "bg-indigo-600 text-white border-indigo-600" : "bg-white border-neutral-300"
                }`}
                onClick={() => setTab(d)}
              >
                {DESTINATION_LABEL[d]}
              </button>
            ))}
          </div>
          {emissions[tab]?.segments.map((s, i) => (
            <div key={i} className="mb-2 border border-neutral-200 rounded p-2">
              <div className="flex items-center gap-2 mb-1 text-sm">
                {s.label && <span className="text-neutral-500">{s.label}</span>}
                <span className={s.overLimit ? "text-red-600 font-semibold" : "text-neutral-500"}>
                  {s.length}/{s.limit}
                  {s.overLimit ? " ⚠" : ""}
                </span>
                <button
                  className="ml-auto px-2.5 py-0.5 border border-neutral-300 rounded bg-white text-sm"
                  onClick={() => copy(`${tab}:${i}`, s.text)}
                >
                  {copiedKey === `${tab}:${i}` ? "복사됨 ✓" : "복사"}
                </button>
              </div>
              <div className="whitespace-pre-wrap text-sm text-neutral-700">{s.text}</div>
            </div>
          ))}
          {(emissions[tab]?.segments.length ?? 0) > 1 && (
            <button
              className="px-3.5 py-1.5 border border-neutral-300 rounded-md bg-white"
              onClick={() => copy(`${tab}:all`, emissions[tab]!.segments.map((s) => s.text).join("\n\n"))}
            >
              {copiedKey === `${tab}:all` ? "전체 복사됨 ✓" : "전체 복사"}
            </button>
          )}
        </div>
      )}
```

Delete the now-unused `copied` state declaration, which the old single 복사 button was the only
reader of. Keep `badgeClass` — the status badge still uses it.

- [ ] **Step 4: Typecheck the frontend**

Run: `pnpm typecheck:web`
Expected: PASS, no errors.

- [ ] **Step 5: Verify in the running app**

```bash
pnpm format            # regenerate renderings.json as canonical
pnpm serve
```

Open `http://localhost:5757`, go to 2차 검수 (채널), select a rendering, and confirm: the tab strip
shows only that channel's destinations, each segment shows a length against its limit, and 복사
puts that segment's text on the clipboard. Stop the server when done.

- [ ] **Step 6: Commit**

```bash
git add web/src/types.ts web/src/api.ts web/src/components/RenderingDetail.tsx
git commit -m "feat: show per-destination output with copy buttons in the review dashboard"
```

---

### Task 10: Documentation

**Files:**
- Modify: `docs/ko/artifacts.md`, `docs/ko/capabilities.md`, `CHANGELOG.md`

**Interfaces:**
- Consumes: everything above. Produces: no code.

- [ ] **Step 1: Update `docs/ko/artifacts.md`**

In §3 (명령어별 입출력), the `pnpm format` and `pnpm format:save` rows describe
`output/formatted/renderings.json`. Add that the stored text is now **canonical**
(`**볼드**`, `[텍스트](URL)`, 빈 줄 두 개 = 트윗 경계) and that `--x-bold`가 제거되었음을 적습니다.
In the `pnpm serve` row, add the emissions endpoint to what the dashboard reads.

- [ ] **Step 2: Update `docs/ko/capabilities.md`**

§3 (지원 범위) lists the four channels. Add the six destinations and state that a channel is
approved once while destinations are derived. §4 (할 수 없는 것) gains three entries:

- 자동 전송은 아직 없습니다 — 텔레그램 봇·Typefully·X API는 다음 작업입니다.
- 스레드 자동 분할은 하지 않습니다 — 작성자가 `--refine`에서 나눕니다.
- Typefully 에디터 붙여넣기 동작은 아직 실검증되지 않았습니다.

Correct any statement that X's limit is 280 characters: for Korean it is 140.

- [ ] **Step 3: Update `CHANGELOG.md`**

Add an entry in the existing style covering: the X weighted-length fix (call it a bug fix, since
over-limit Korean posts previously passed silently), canonical renderings, the six destinations,
the removal of `--x-bold`, the richer `--refine` worksheet, and the dashboard copy buttons.

- [ ] **Step 4: Verify and commit**

Run: `pnpm test && pnpm typecheck && pnpm typecheck:web`
Expected: PASS.

```bash
git add docs/ko/artifacts.md docs/ko/capabilities.md CHANGELOG.md
git commit -m "docs: describe canonical renderings and the six channel destinations"
```

---

## Operator step after the plan lands

`output/formatted/renderings.json` still holds pre-canonical text (bold already stripped for `x`,
`*bold*` for `telegram`). There is no migration code by design — `variants.json` is the upstream
source and `output/` is gitignored local working data. Regenerate:

```bash
pnpm format
```

Renderings that were edited by hand in the dashboard will be overwritten by this. If any are worth
keeping, copy them out first.

## Manual verification still owed

`x_typefully` ships identical to `x_paste`. Before relying on it, paste a three-post canonical
draft into Typefully and observe whether the editor preserves the boundaries. Record the answer in
the design spec's *Unverified* section and adjust `src/domain/formatting/emitters/x.ts` if needed.
