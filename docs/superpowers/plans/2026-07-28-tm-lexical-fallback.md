# TM Alignment Lexical Fallback Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** When the align pass's anchor-based precedent selection leaves slots empty (an anchorless draft), fill them by English-source lexical similarity above a threshold — so `translate:align` also fires on plain 공지.

**Architecture:** A pure `lexical.ts` (tokenize + Jaccard similarity + stopwords), then `selectPrecedents` composes anchor picks first + lexical fill for the remainder. Domain-only; `PrepareAlignment`/CLI untouched (`selectPrecedents`'s signature is unchanged).

**Tech Stack:** ESM TypeScript, `vitest`, `zod`-only runtime dep (this feature adds none), pure string/set math.

## Global Constraints

- Runtime deps stay **zod-only**; no dependency, no network — pure string/set math.
- Anchor behavior is **unchanged**: an anchored draft that already has `k` anchor precedents gets exactly today's result; lexical only fills slots anchors left empty, and only for matches **≥ `LEXICAL_MIN_SIMILARITY`**.
- `selectPrecedents(sourceText, tm, k)`'s signature and return type are unchanged (`PrepareAlignment` is not touched).
- Better coverage never costs precision: a sub-threshold lexical match is **dropped, not attached**.
- Matching is on the **English** source (`sourceText` vs each pair's `source`).
- `selectByAnchors` and `selectRelevantTm` are **not** modified (batch prompt stays anchor-only).
- Public repo: tests use synthetic English/Korean strings only. Every test can fail: pin exact Jaccard values, pair sources, and counts.

---

## File Structure

- **Create** `src/domain/tm/lexical.ts` — `LEXICAL_STOPWORDS`, `tokenize`, `lexicalSimilarity`.
- **Modify** `src/domain/tm/selection.ts` — `selectPrecedents` gains the lexical-fill branch + `LEXICAL_MIN_SIMILARITY`.
- **Test:** create `tests/domain/tm/lexical.test.ts`; extend `tests/domain/tm/selection.test.ts` (the `selectPrecedents` describe block).

---

## Task 1: `lexical.ts` — tokenize + Jaccard similarity

**Files:** Create `src/domain/tm/lexical.ts`; Test `tests/domain/tm/lexical.test.ts`

**Interfaces:**
- Produces: `LEXICAL_STOPWORDS: Set<string>`, `tokenize(text: string): string[]`, `lexicalSimilarity(a: string, b: string): number` (`[0,1]`).

- [ ] **Step 1: Write the failing test** (`tests/domain/tm/lexical.test.ts`)

```ts
import { describe, it, expect } from "vitest";
import { lexicalSimilarity } from "../../../src/domain/tm/lexical";

describe("lexicalSimilarity", () => {
  it("is 1 for identical content", () => {
    expect(lexicalSimilarity("tokenized stocks trade onchain", "tokenized stocks trade onchain")).toBe(1);
  });

  it("is 0 for disjoint content", () => {
    expect(lexicalSimilarity("tokenized stocks liquidity", "hackathon builders seoul")).toBe(0);
  });

  it("computes the exact Jaccard for partial overlap", () => {
    // A={tokenized,stocks,trade} B={tokenized,stocks,weekend} → inter 2, union 4 → 0.5
    expect(lexicalSimilarity("tokenized stocks trade", "tokenized stocks weekend")).toBe(0.5);
  });

  it("drops stopwords and <=2-char tokens (texts differing only in those score 1)", () => {
    expect(lexicalSimilarity("the tokenized stocks", "tokenized stocks on it")).toBe(1);
  });

  it("is 0 when one side has no content tokens", () => {
    expect(lexicalSimilarity("the a on to", "tokenized stocks")).toBe(0);
  });
});
```

- [ ] **Step 2: Run to verify it fails** — `pnpm exec vitest run tests/domain/tm/lexical.test.ts` → FAIL (module not found).

- [ ] **Step 3: Implement** `src/domain/tm/lexical.ts`

```ts
// A small English function-word set. Dropping these (plus tokens ≤2 chars) keeps lexical similarity
// on the content tokens (tokenized, stocks, liquidity, mantle, …) instead of inflating it with
// "the/of/on". Matching is on the English source both a draft and a TM pair's `source` share.
export const LEXICAL_STOPWORDS = new Set<string>([
  "the", "a", "an", "and", "or", "of", "to", "in", "on", "for", "with", "at", "by", "from",
  "is", "are", "be", "was", "were", "it", "its", "this", "that", "these", "those",
  "as", "but", "if", "so", "than", "then", "into", "over", "out", "up", "down",
  "you", "your", "we", "our", "they", "their", "has", "have", "had",
  "not", "no", "yes", "can", "will", "just", "now", "all",
]);

export function tokenize(text: string): string[] {
  return text
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((t) => t.length > 2 && !LEXICAL_STOPWORDS.has(t));
}

/** Jaccard similarity of the two texts' content-token sets, in [0, 1]. 0 when either side is empty. */
export function lexicalSimilarity(a: string, b: string): number {
  const setA = new Set(tokenize(a));
  const setB = new Set(tokenize(b));
  if (setA.size === 0 || setB.size === 0) return 0;
  let inter = 0;
  for (const t of setA) if (setB.has(t)) inter += 1;
  const union = setA.size + setB.size - inter;
  return union === 0 ? 0 : inter / union;
}
```

- [ ] **Step 4: Run to verify pass** — 5/5. **Step 5: Commit** `git commit -m "feat(tm): lexicalSimilarity — Jaccard over content tokens"`.

---

## Task 2: `selectPrecedents` — anchor-first + lexical fill

**Files:** Modify `src/domain/tm/selection.ts`; Test `tests/domain/tm/selection.test.ts` (extend)

**Interfaces:**
- Consumes: `lexicalSimilarity` from `./lexical` (Task 1); `selectByAnchors`, `extractAnchors` (unchanged).
- `selectPrecedents(sourceText, tm, k)` — same signature/return; now fills anchor-empty slots by lexical similarity ≥ `LEXICAL_MIN_SIMILARITY`.

- [ ] **Step 1: Write the failing tests** — add to the existing `describe("selectPrecedents", …)` block in `tests/domain/tm/selection.test.ts` (reuse its `pair` helper):

```ts
  it("fills an anchorless draft by lexical similarity above the threshold", () => {
    const tm2 = [
      pair("Tokenized stocks trade onchain every weekend", "주말 거래"),
      pair("Hackathon builders gather in Seoul", "해커톤"),
    ];
    // draft has no $/#/@ anchors → anchor picks 0 → lexical fill
    const got = selectPrecedents("Tokenized stocks now trade onchain on weekends", tm2, 3);
    expect(got.map((e) => e.target)).toEqual(["주말 거래"]);
  });

  it("skips a weak lexical match (below threshold) rather than attaching it", () => {
    const tm2 = [pair("Hackathon builders gather in Seoul for the demo day", "해커톤")];
    expect(selectPrecedents("Tokenized stocks trade onchain", tm2, 3)).toEqual([]);
  });

  it("keeps anchor picks first, then lexical-fills the rest without duplicating", () => {
    const tm2 = [
      pair("$MNT staking on Mantle", "스테이킹"),                 // anchor: shares $mnt
      pair("Staking rewards on Mantle network grow", "리워드"),   // lexical: shares mantle/staking/network
      pair("Unrelated hackathon in Seoul", "무관"),
    ];
    const got = selectPrecedents("$MNT staking on Mantle network", tm2, 3);
    expect(got[0].target).toBe("스테이킹");                       // anchor pick first
    expect(got.map((e) => e.target)).toContain("리워드");         // lexical fill
    expect(got.map((e) => e.target)).not.toContain("무관");
    expect(new Set(got.map((e) => e.target)).size).toBe(got.length); // no duplicate
  });
```

- [ ] **Step 2: Run to verify they fail** — `pnpm exec vitest run tests/domain/tm/selection.test.ts` → the new cases FAIL (current `selectPrecedents` returns `[]`/anchors-only, no lexical fill).

- [ ] **Step 3: Implement** — in `src/domain/tm/selection.ts`, add the import and constant, and replace `selectPrecedents`:

Add at the top (with the other imports):
```ts
import { lexicalSimilarity } from "./lexical";
```

Add near the top of the module:
```ts
const LEXICAL_MIN_SIMILARITY = 0.2;
```

Replace the existing `selectPrecedents` with:
```ts
export function selectPrecedents(sourceText: string, tm: FewShotExample[], k: number): FewShotExample[] {
  const anchorPicks = selectByAnchors(extractAnchors(sourceText), tm, k);
  if (anchorPicks.length >= k) return anchorPicks;

  const chosen = new Set(anchorPicks); // identity-based: the same objects live in `tm`
  const lexicalPicks = tm
    .filter((ex) => !chosen.has(ex))
    .map((ex) => ({ ex, score: lexicalSimilarity(sourceText, ex.source) }))
    .filter((s) => s.score >= LEXICAL_MIN_SIMILARITY)
    .sort((a, b) => b.score - a.score) // stable in V8: equal scores keep input order
    .slice(0, k - anchorPicks.length)
    .map((s) => s.ex);

  return [...anchorPicks, ...lexicalPicks];
}
```

- [ ] **Step 4: Run to verify pass, AND that the pre-existing `selectPrecedents` tests still pass**

Run: `pnpm exec vitest run tests/domain/tm/selection.test.ts`
Expected: PASS — the 3 new cases AND every pre-existing `selectPrecedents`/`selectRelevantTm` case. The pre-existing anchor-only cases still hold because their TM pairs are lexically disjoint from their drafts (anchor matches already fill `k`, or the leftover pairs fall below the threshold). **If a pre-existing case now fails** because a leftover pair is lexically similar enough to be filled, that is expected new behavior — do NOT weaken the new logic; instead adjust that test's synthetic data so its non-anchor pairs are lexically disjoint (they are meant to test anchor ranking), and if a test is literally named "returns nothing when the draft has no anchors", reframe it to "…when no anchor AND no lexical match above threshold" keeping it green (its pair is already lexically disjoint). Report any such adjustment in the report.

- [ ] **Step 5: Typecheck + commit**

```bash
pnpm exec tsc --noEmit
git add src/domain/tm/selection.ts tests/domain/tm/selection.test.ts
git commit -m "feat(tm): selectPrecedents fills anchorless drafts by lexical similarity"
```

- [ ] **Step 6: Full suite**

Run: `pnpm test`
Expected: green (only the TM selection tests are affected; `PrepareAlignment`/`translate:align` call `selectPrecedents` unchanged).

---

## Self-Review

**1. Spec coverage:** Decision 1 (anchor-first + lexical-fill, signature unchanged) → Task 2 `selectPrecedents`. Decision 2 (Jaccard over content tokens, stopwords + ≤2-char dropped) → Task 1 `tokenize`/`lexicalSimilarity`. Decision 3 (threshold, skip weak) → Task 2 `LEXICAL_MIN_SIMILARITY` + the "skips a weak match" test. Decision 4 (scope: `selectPrecedents` only, domain-only, `selectRelevantTm` untouched) → the plan touches only `lexical.ts` + `selection.ts` + their tests. Testing section → Tasks 1-2. Every spec decision maps to a step.

**2. Placeholder scan:** No TBD/TODO; all code and test steps are complete.

**3. Type consistency:** `lexicalSimilarity(a: string, b: string): number` (Task 1) is imported and called in Task 2. `selectPrecedents(sourceText, tm, k): FewShotExample[]` is unchanged in signature (verified against `PrepareAlignment`'s call `selectPrecedents(d.sourceText, tm, PRECEDENTS_PER_DRAFT)`), so no caller changes. `selectByAnchors`/`extractAnchors`/`FewShotExample` are reused as-is. The lexical test's expected Jaccard values (1, 0, 0.5, 1, 0) were hand-verified against the `tokenize` rules (lowercase, split on non-`[a-z0-9]`, drop ≤2-char + stopwords).
