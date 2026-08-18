# Human-edit signal Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the difference between the last machine draft and the Korean a human approved at 1차 검수 readable, and mine it for glossary candidates alongside the published-text signal.

**Architecture:** Every `lineage` row gains an `actor` (`"human" | "agent"`) decided at the use case's construction site, not passed per call. A pure picker turns one item's entries into a before/after pair — the last agent entry before the first human one, against the approved Korean. `substitutionEdits` is generalised from draft/published to before/after so one sentence aligner serves both feeds, and `glossary:mine` gains the second feed as a third signal in the review file it already writes.

**Tech Stack:** TypeScript (ESM, `tsx`), Postgres via `pg`, vitest. No new dependencies.

**Spec:** `docs/superpowers/specs/2026-08-18-human-edit-signal-design.md`

## Global Constraints

- **The actor is a constructor argument, never a per-call parameter or a CLI flag.** Spec §2: correctness must not depend on the local agent remembering a flag. Required, not defaulted — a new call site has to state an answer rather than inherit a wrong one (spec, Risk).
- **Nullable column, no backfill.** A null actor means "written before this existed" and is skipped by the miner. Never guess one from timestamps (spec §6).
- **`agent:translate` vs `agent:align` is not modelled.** Two values only: `"human"`, `"agent"` (spec §2).
- **No new CLI command.** The output is a third signal in `glossary:mine`'s existing review file (spec §5).
- **Nothing here writes a glossary entry, a few-shot row, or a style rule** — it produces candidates for a human (spec §6).
- Run the full suite with `npx vitest run`; typecheck with `npx tsc --noEmit`. The local dev Postgres must be up for `Pg*` tests (`docker start herald-db`).
- Commit subjects are conventional-commit, English sentence, may quote Korean terms (`src/cli/check-commit-subject.ts`).

---

## File Structure

| File | Responsibility |
| --- | --- |
| `src/domain/lineage/models.ts` | `LineageActor` type; `actor?` on `LineageEvent` (modify) |
| `src/adapters/db/schema.ts` | `ALTERED_COLUMNS` gains `lineage.actor` (modify) |
| `src/adapters/store/PgLineageStore.ts` | carry `actor` through insert, both selects (modify) |
| `src/app/SaveTranslation.ts` | take the actor, write it (modify) |
| `src/app/SaveConversion.ts`, `SaveRendering.ts`, `SaveOutletOverride.ts`, `ApproveRendering.ts` | same argument, so no stage writes a null forever (modify) |
| `src/app/createDeps.ts`, `src/cli/translate-save.ts`, `src/cli/convert-save.ts`, `src/cli/format-save.ts` | state `"human"` / `"agent"` (modify) |
| `src/domain/lineage/humanEdits.ts` | **new** — the baseline picker, pure |
| `src/domain/translation/glossaryMining.ts` | `TextPair`, generalised `substitutionEdits`, second feed (modify) |
| `src/domain/translation/glossaryReview.ts` | show which feed a candidate came from (modify) |
| `src/cli/glossary-mine.ts` | load lineage, build the human pairs (modify) |

---

### Task 1: `actor` reaches the database

**Files:**
- Modify: `src/domain/lineage/models.ts`
- Modify: `src/adapters/db/schema.ts:25-36` (`ALTERED_COLUMNS`)
- Modify: `src/adapters/store/PgLineageStore.ts`
- Test: `tests/adapters/store/PgLineageStore.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces: `LineageActor = "human" | "agent"`, and `LineageEvent.actor?: LineageActor` (so `LineageEntry` inherits it). `PgLineageStore.append/load/listEvents` round-trip the field.

- [ ] **Step 1: Write the failing test**

Append to `tests/adapters/store/PgLineageStore.test.ts`, inside the existing `describe("PgLineageStore", ...)`:

```typescript
  it("round-trips the actor, and leaves it absent when nothing said who", async () => {
    db = await createTestDb();
    const s = new PgLineageStore(db);
    await s.append(entry({ content: "v1", actor: "agent" }));
    await s.append(entry({ content: "v2", actor: "human" }));
    await s.append(entry({ content: "v3" }));

    const got = await s.load("x:1");
    expect(got.map((e) => e.actor)).toEqual(["agent", "human", undefined]);
  });

  /**
   * `listEvents` exists to answer rollup questions without pulling `content`, and "who edited this"
   * is exactly such a question — an actor that only `load()` could see would force the miner to
   * read every version of every item's copy to find out.
   */
  it("projects the actor into listEvents, still without the text columns", async () => {
    db = await createTestDb();
    const s = new PgLineageStore(db);
    await s.append(entry({ content: "v1", actor: "human" }));

    const events = await s.listEvents();
    expect(events[0].actor).toBe("human");
    expect(events[0]).not.toHaveProperty("content");
  });
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/adapters/store/PgLineageStore.test.ts`
Expected: FAIL — TypeScript rejects `actor` on `LineageEntry`, or the column does not exist.

- [ ] **Step 3: Add the type**

In `src/domain/lineage/models.ts`, above `LineageEvent`:

```typescript
/**
 * Who wrote a lineage entry. Two values, because the question this exists for is one line: did a
 * person change this, or did a machine? `translate:align` runs inside `herald-watch` every two
 * hours and saves through the same use case a dashboard edit does, so without this the two are
 * indistinguishable on disk — see docs/superpowers/specs/2026-08-18-human-edit-signal-design.md.
 *
 * `agent:translate` vs `agent:align` is deliberately not modelled: it is derivable from order (an
 * item's first agent entry is the draft, later ones are alignment revisions) and nothing needs it.
 */
export type LineageActor = "human" | "agent";
```

and add to `LineageEvent`, after `status`:

```typescript
  /**
   * Absent on every row written before 2026-08-18 — the information was never recorded and is not
   * recoverable, so a null is "nobody said", never "an agent did it". Readers skip such rows.
   */
  actor?: LineageActor;
```

- [ ] **Step 4: Add the column**

In `src/adapters/db/schema.ts`, append to `ALTERED_COLUMNS`:

```typescript
  // `actor` — who wrote the entry. `lineage` predates it, so every existing row is null and stays
  // null; see the 2026-08-18 human-edit-signal spec for why no backfill is possible.
  { table: "lineage", column: "actor", type: "text" },
```

- [ ] **Step 5: Carry it through the store**

In `src/adapters/store/PgLineageStore.ts`: add `actor: string | null;` to `LineageRow`; add `actor: row.actor as LineageActor,` to `toLineageEntry`'s `omitNulls` object; widen `LineageEventRow` to `Pick<LineageRow, "item_id" | "stage" | "status" | "actor" | "at">`; then

```typescript
      `insert into lineage (item_id, stage, variant, content, status, source_text, actor, at)
       values ($1, $2, $3, $4, $5, $6, $7, $8)`,
```

with `entry.actor ?? null,` inserted before `entry.at,`; add `actor` to both select lists (`load` and `listEvents`); and in `listEvents`'s map add `actor: r.actor as LineageActor,`. Import `LineageActor` from the domain models.

- [ ] **Step 6: Run tests to verify they pass**

Run: `npx vitest run tests/adapters/store/PgLineageStore.test.ts tests/adapters/db/schema.test.ts`
Expected: PASS. `schema.test.ts` checks every `(table, column)` pair independently — if it fails, the pair was added in the wrong shape.

- [ ] **Step 7: Write the failing render test**

Spec §6: `pnpm lineage` shows the actor, because the column is free there. Append to
`tests/domain/lineage/render.test.ts`:

```typescript
  it("names who wrote an entry, and says so when nobody recorded it", () => {
    const out = renderLineage([
      { itemId: "x:1", stage: "translated", content: "초안", status: "translated", actor: "agent", at: "2026-08-18T00:00:00.000Z" },
      { itemId: "x:1", stage: "translated", content: "검수본", status: "approved", actor: "human", at: "2026-08-18T01:00:00.000Z" },
      { itemId: "x:1", stage: "translated", content: "옛 행", status: "translated", at: "2026-08-18T02:00:00.000Z" },
    ]);
    expect(out).toContain("· 에이전트");
    expect(out).toContain("· 사람");
    expect(out).not.toContain("· undefined");
  });
```

- [ ] **Step 8: Run it to verify it fails**

Run: `npx vitest run tests/domain/lineage/render.test.ts`
Expected: FAIL — the rendered line has no actor in it.

- [ ] **Step 9: Render it**

In `src/domain/lineage/render.ts:22`, extend the header line. A null prints nothing at all rather
than a placeholder — an old row has no answer, and inventing "미상" would put a word where the
absence is the information:

```typescript
    const who = e.actor === "human" ? " · 사람" : e.actor === "agent" ? " · 에이전트" : "";
    out.push(`── ${e.at} · ${e.stage}${variant}${status}${who}`);
```

- [ ] **Step 10: Run the store, schema, render and round-trip tests**

Run: `npx vitest run tests/domain/lineage tests/adapters/store/PgLineageStore.test.ts tests/adapters/db/schema.test.ts tests/cli/dbMigrate.test.ts`
Expected: PASS. `db:export`/`db:import` need no change — they move whole `LineageEntry` objects, so
the new key rides along — but run any `tests/cli/db*` file that touches lineage to prove it.

- [ ] **Step 11: Commit**

```bash
git add src/domain/lineage src/adapters/db/schema.ts src/adapters/store/PgLineageStore.ts tests/domain/lineage tests/adapters/store/PgLineageStore.test.ts
git commit -m "feat(lineage): record who wrote each entry"
```

---

### Task 2: every producer states an actor

**Files:**
- Modify: `src/app/SaveTranslation.ts:29-35`, `SaveConversion.ts:20-25`, `SaveRendering.ts`, `SaveOutletOverride.ts`, `ApproveRendering.ts:26-31`
- Modify: `src/app/createDeps.ts:282,913,914,935`, `src/cli/translate-save.ts:40`, `src/cli/convert-save.ts:40`, `src/cli/format-save.ts:45`
- Test: `tests/app/SaveTranslation.test.ts`, `tests/app/createDeps.test.ts`

**Interfaces:**
- Consumes: `LineageActor` (Task 1).
- Produces: each use case's constructor takes `actor: LineageActor` as its **last** parameter, and passes it to every `lineage.append` it makes.

- [ ] **Step 1: Write the failing test**

Append to `tests/app/SaveTranslation.test.ts` (match the file's existing harness for the store fakes):

```typescript
  it("stamps the lineage entry with the actor it was constructed for", async () => {
    const appended: { actor?: string }[] = [];
    const lineage = { append: async (e: { actor?: string }) => { appended.push(e); },
      load: async () => [], listItems: async () => [], listEvents: async () => [] };
    const uc = new SaveTranslation(store, fewShots, () => "2026-08-18T00:00:00.000Z", lineage as never, "human");

    await uc.run({ itemId: "x:1", source: "x", sourceText: "en", koreanText: "한국어", approve: false });

    expect(appended[0].actor).toBe("human");
  });
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/app/SaveTranslation.test.ts`
Expected: FAIL — the constructor takes no fifth argument.

- [ ] **Step 3: Take and write the actor**

In `src/app/SaveTranslation.ts`, add to the constructor after `lineage`:

```typescript
    /**
     * Which kind of caller built this — see `LineageActor`. Required rather than defaulted: a new
     * call site that inherits a neighbour's answer would mislabel human edits as machine ones, and
     * nothing downstream could tell. One value per process; no process is sometimes a human.
     */
    private readonly actor: LineageActor,
```

and add `actor: this.actor,` to the `lineage.append({ ... })` call. Repeat in `SaveConversion`, `SaveRendering`, `SaveOutletOverride` and `ApproveRendering` — same parameter, same comment reference, `actor: this.actor` on each `append`.

> **Required, not `actor?`.** The spec's Risk section turns on exactly this: an optional parameter
> lets a future call site inherit a wrong answer in silence, and a mislabelled human edit is worse
> than no label. The cost is that every existing construction stops compiling — which is the point,
> and is what the next step is for.

- [ ] **Step 3b: Make every existing construction state an answer**

`npx tsc --noEmit` now lists every call site, production and test. Production sites are Step 4.
For the test constructions, pass `"agent"` unless the test is about the dashboard — a use-case test
that does not care which is which should still say one, because reading it later, the value is how
you know the test did not care.

- [ ] **Step 4: State it at every call site**

```typescript
// src/app/createDeps.ts:282  — the dashboard: a 1차 검수 edit, and the 되돌리기 path
const saveTranslation = new SaveTranslation(translationStore, stores.fewShotStore, undefined, stores.lineageStore, "human");
// src/app/createDeps.ts:913,914,935 — same, "human" as the last argument
// src/cli/translate-save.ts:40 — `pnpm translate:save`, from drafting AND from translate:align
const usecase = new SaveTranslation(translationStore, stores.fewShotStore, undefined, stores.lineageStore, "agent");
// src/cli/convert-save.ts:40, src/cli/format-save.ts:45 — "agent"
```

- [ ] **Step 5: Write the call-site test**

Append to `tests/app/createDeps.test.ts`, in the existing describe:

```typescript
  /**
   * The use case cannot see which process built it, so the call site is the only place the
   * human/agent split can be checked. A dashboard save labelled "agent" would feed machine phrasing
   * into a corpus whose whole purpose is to record what humans decided, and nothing downstream
   * could tell.
   */
  describe("lineage actor", () => {
    it("builds the dashboard's SaveTranslation as a human writer", async () => {
      const db = await createTestDb();
      try {
        const deps = createDeps({ db, routes: "local" });
        await deps.saveTranslation.run({
          itemId: "x:1", source: "x", sourceText: "en", koreanText: "한국어", approve: false,
        });
        const entries = await new PgLineageStore(db).load("x:1");
        expect(entries.map((e) => e.actor)).toEqual(["human"]);
      } finally {
        await db.close();
      }
    });
  });
```

Add `import { PgLineageStore } from "../../src/adapters/store/PgLineageStore";` to the file's imports.
`createTestDb` and `createDeps({ db, routes: "local" })` are the shapes this file already uses
(`tests/app/createDeps.test.ts:52`); do not introduce a second fixture shape. If `deps` exposes the
use case under a different name than `saveTranslation`, use that name — read `createDeps.ts:282`.

- [ ] **Step 6: Run tests to verify they pass**

Run: `npx vitest run tests/app tests/adapters` then `npx tsc --noEmit`
Expected: PASS, clean typecheck.

- [ ] **Step 7: Commit**

```bash
git add src/app src/cli tests/app
git commit -m "feat(lineage): let each producer say whether a person or a machine wrote it"
```

---

### Task 3: the baseline picker

**Files:**
- Create: `src/domain/lineage/humanEdits.ts`
- Test: `tests/domain/lineage/humanEdits.test.ts`

**Interfaces:**
- Consumes: `LineageEntry`, `LineageActor` (Task 1).
- Produces:

```typescript
export interface TextPair { itemId: string; before: string; after: string; }
export function humanEditPairs(entries: LineageEntry[]): TextPair[];
```

`entries` is one item's `translated` entries in insertion order (what `LineageStore.load` returns). Returns zero or one pair per item.

- [ ] **Step 1: Write the failing test**

Create `tests/domain/lineage/humanEdits.test.ts`:

```typescript
import { describe, it, expect } from "vitest";
import { humanEditPairs } from "../../../src/domain/lineage/humanEdits";
import type { LineageEntry } from "../../../src/domain/lineage/models";

const e = (over: Partial<LineageEntry>): LineageEntry => ({
  itemId: "x:1", stage: "translated", content: "", at: "2026-08-18T00:00:00.000Z", ...over,
});

describe("humanEditPairs", () => {
  it("pairs the last agent draft against what the human left", () => {
    expect(humanEditPairs([
      e({ content: "초안", actor: "agent" }),
      e({ content: "정렬본", actor: "agent" }),
      e({ content: "검수본", actor: "human" }),
    ])).toEqual([{ itemId: "x:1", before: "정렬본", after: "검수본" }]);
  });

  /** The question is what the reviewer changed, not what the pipeline changed. */
  it("uses the aligned text as the baseline, not the original draft", () => {
    const [pair] = humanEditPairs([
      e({ content: "초안", actor: "agent" }),
      e({ content: "정렬본", actor: "agent" }),
      e({ content: "검수본", actor: "human" }),
    ]);
    expect(pair.before).not.toBe("초안");
  });

  it("takes the human's last word when a reviewer saved twice", () => {
    expect(humanEditPairs([
      e({ content: "정렬본", actor: "agent" }),
      e({ content: "중간", actor: "human" }),
      e({ content: "최종", actor: "human" }),
    ])).toEqual([{ itemId: "x:1", before: "정렬본", after: "최종" }]);
  });

  /** A re-run after an edit must not become the baseline — it comes after the human, not before. */
  it("ignores an agent entry that lands after the human's", () => {
    expect(humanEditPairs([
      e({ content: "정렬본", actor: "agent" }),
      e({ content: "검수본", actor: "human" }),
      e({ content: "재실행", actor: "agent" }),
    ])).toEqual([{ itemId: "x:1", before: "정렬본", after: "검수본" }]);
  });

  it("yields nothing when no human ever touched it", () => {
    expect(humanEditPairs([e({ content: "초안", actor: "agent" })])).toEqual([]);
  });

  it("yields nothing when the human changed nothing", () => {
    expect(humanEditPairs([
      e({ content: "같은 글", actor: "agent" }),
      e({ content: "같은 글", actor: "human" }),
    ])).toEqual([]);
  });

  /** Null actors predate the column; guessing one would manufacture the confidence this exists for. */
  it("skips an item whose entries have no actor at all", () => {
    expect(humanEditPairs([e({ content: "초안" }), e({ content: "고친 글" })])).toEqual([]);
  });

  it("yields nothing when a human entry has no agent entry before it", () => {
    expect(humanEditPairs([e({ content: "사람이 처음 쓴 글", actor: "human" })])).toEqual([]);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/domain/lineage/humanEdits.test.ts`
Expected: FAIL — "Failed to load url ../../../src/domain/lineage/humanEdits".

- [ ] **Step 3: Write the implementation**

Create `src/domain/lineage/humanEdits.ts`:

```typescript
import type { LineageEntry } from "./models";

/** One before/after pair to diff. Shared with `glossaryMining.ts`, which mines both feeds. */
export interface TextPair {
  itemId: string;
  before: string;
  after: string;
}

/**
 * What a reviewer changed at 1차 검수, for one item's `translated` entries in insertion order.
 *
 * The baseline is the last **agent** entry before the first **human** one — not the original machine
 * draft. `translate:align` revises the draft before a reviewer ever sees it (`herald-watch`, every
 * two hours), so diffing against the first draft would credit the reviewer with the alignment
 * pass's work. See docs/superpowers/specs/2026-08-18-human-edit-signal-design.md §3.
 *
 * Returns nothing — rather than an empty-ish pair — when there is no human entry, no agent entry
 * before it, or the human left the text byte-identical. "The reviewer changed nothing" is a fact
 * about the draft, not an edit to mine.
 */
export function humanEditPairs(entries: LineageEntry[]): TextPair[] {
  const firstHuman = entries.findIndex((e) => e.actor === "human");
  if (firstHuman === -1) return [];

  const baseline = entries.slice(0, firstHuman).filter((e) => e.actor === "agent").at(-1);
  if (baseline === undefined) return [];

  const after = entries.filter((e) => e.actor === "human").at(-1)!;
  if (after.content === baseline.content) return [];

  return [{ itemId: after.itemId, before: baseline.content, after: after.content }];
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run tests/domain/lineage/humanEdits.test.ts`
Expected: PASS (8 tests).

- [ ] **Step 5: Commit**

```bash
git add src/domain/lineage/humanEdits.ts tests/domain/lineage/humanEdits.test.ts
git commit -m "feat(lineage): read what a reviewer changed after the alignment pass"
```

---

### Task 4: one sentence aligner, two feeds

**Files:**
- Modify: `src/domain/translation/glossaryMining.ts:299-360` (`SubstitutionEdit`, `MinedTranslation`, `substitutionEdits`), and its caller at `:666`
- Test: `tests/domain/translation/glossaryMining.test.ts`

**Interfaces:**
- Consumes: `TextPair` (Task 3).
- Produces: `substitutionEdits(pairs: TextPair[], source: EditSource): SubstitutionEdit[]`, where `EditSource = "published" | "review"` and `SubstitutionEdit` gains `source: EditSource`. `SubstitutionEdit.draft`/`.published` keep their names — they are what the review file prints.

- [ ] **Step 1: Write the failing test**

Append to `tests/domain/translation/glossaryMining.test.ts`:

```typescript
  it("mines a reviewer's edit with the same aligner, tagged as review evidence", () => {
    const edits = substitutionEdits(
      [{ itemId: "x:1", before: "가장 최근에 구매하신 토큰화 자산은 무엇입니까?", after: "가장 최근에 구매한 토큰화 자산은 무엇인가요?" }],
      "review",
    );
    expect(edits).toEqual([{ itemId: "x:1", draft: "구매하신 무엇입니까?", published: "구매한 무엇인가요?", source: "review" }]);
  });
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/domain/translation/glossaryMining.test.ts`
Expected: FAIL — `substitutionEdits` takes one argument and returns no `source`.

- [ ] **Step 3: Generalise the function**

In `src/domain/translation/glossaryMining.ts` replace `MinedTranslation`'s use inside `substitutionEdits` with the shared pair, keeping the algorithm byte-for-byte:

```typescript
/** Which feed an edit came from — a reviewer's own correction, or whoever published the post. */
export type EditSource = "published" | "review";

export function substitutionEdits(pairs: TextPair[], source: EditSource): SubstitutionEdit[] {
  const edits: SubstitutionEdit[] = [];
  for (const t of pairs) {
    if (!t.after || !t.before) continue;
    const draftSentences = sentencesOf(t.before);
    const publishedSentences = sentencesOf(t.after);
    // ... rest unchanged, and the push becomes:
    edits.push({ itemId: t.itemId, draft: gone.join(" "), published: came.join(" "), source });
  }
  return edits;
}
```

Add `source: EditSource;` to `SubstitutionEdit`. Import `TextPair` from `../lineage/humanEdits`.

- [ ] **Step 4: Adapt the existing caller**

At `glossaryMining.ts:666`, inside `mineGlossaryCandidates`:

```typescript
  const publishedPairs: TextPair[] = translations
    .filter((t) => t.publishedText && t.koreanText)
    .map((t) => ({ itemId: t.itemId, before: t.koreanText, after: t.publishedText! }));
  const edits = substitutionEdits(publishedPairs, "published");
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `npx vitest run tests/domain/translation`
Expected: PASS — including every pre-existing published-text case. Those passing unchanged is the proof the generalisation altered no behaviour; if one fails, the aligner changed and the diff is wrong, not the test.

- [ ] **Step 6: Commit**

```bash
git add src/domain/translation/glossaryMining.ts tests/domain/translation/glossaryMining.test.ts
git commit -m "refactor(glossary): mine any before/after pair, not only draft against published"
```

---

### Task 5: the third signal reaches the review file

**Files:**
- Modify: `src/domain/translation/glossaryMining.ts` (`MiningInput`, `GlossaryCandidate`, the `byPair` rollup at `:667-712`)
- Modify: `src/domain/translation/glossaryReview.ts:94`
- Modify: `src/cli/glossary-mine.ts:78-137`
- Test: `tests/domain/translation/glossaryMining.test.ts`, `tests/domain/translation/glossaryReview.test.ts`

**Interfaces:**
- Consumes: `humanEditPairs` (Task 3), `substitutionEdits(pairs, source)` (Task 4).
- Produces: `MiningInput.humanEdits: TextPair[]`; `GlossaryCandidate.sources?: EditSource[]`.

- [ ] **Step 1: Write the failing test**

Append to `tests/domain/translation/glossaryMining.test.ts`:

```typescript
  it("raises a candidate from a reviewer's edit alone, and says where it came from", () => {
    const result = mineGlossaryCandidates({
      sourceTweets: ["Openstock pre-IPO access"],
      translations: [{ itemId: "x:1", sourceText: "Openstock pre-IPO access", koreanText: "오픈스톡 프리 IPO 접근" }],
      humanEdits: [{ itemId: "x:1", before: "프리 IPO 접근 권한이 있습니다", after: "프리 IPO 이용이 가능합니다" }],
      glossary: [{ term: "Mantle", action: "translate", target: "맨틀" }],
      dismissed: [],
      corpusTweets: [],
      corpusRuns: [],
      now: "2026-08-18T00:00:00.000Z",
    });
    const sub = result.candidates.find((c) => c.signal === "substitution");
    expect(sub?.sources).toEqual(["review"]);
  });

  /** The same pair seen in both feeds is stronger evidence, not two findings. */
  it("merges a pair that both feeds produced, keeping both sources", () => {
    const result = mineGlossaryCandidates({
      sourceTweets: [],
      translations: [{ itemId: "x:1", sourceText: "en", koreanText: "구매하신 자산", publishedText: "구매한 자산" }],
      humanEdits: [{ itemId: "x:2", before: "구매하신 자산", after: "구매한 자산" }],
      glossary: [{ term: "Mantle", action: "translate", target: "맨틀" }],
      dismissed: [],
      corpusTweets: [],
      corpusRuns: [],
      now: "2026-08-18T00:00:00.000Z",
    });
    const sub = result.candidates.find((c) => c.signal === "substitution");
    expect(sub?.sources).toEqual(["published", "review"]);
    expect(sub?.itemIds).toEqual(["x:1", "x:2"]);
  });
```

Match the existing tests' fixture shape for `glossary` entries if it differs from the above.

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/domain/translation/glossaryMining.test.ts`
Expected: FAIL — `humanEdits` is not a `MiningInput` field.

- [ ] **Step 3: Take the second feed and merge**

In `glossaryMining.ts`: add `humanEdits: TextPair[];` to `MiningInput`; add `sources?: EditSource[];` to `GlossaryCandidate` with the comment *"Which feeds produced this pair — a reviewer's own correction is stronger evidence than an unattributed rewrite."*; then

```typescript
  const edits = [
    ...substitutionEdits(publishedPairs, "published"),
    ...substitutionEdits(input.humanEdits, "review"),
  ];
```

and widen the `byPair` accumulator to carry sources:

```typescript
  const byPair = new Map<string, { draft: string; published: string; itemIds: string[]; sources: EditSource[] }>();
  for (const e of edits) {
    const key = `${normalizeTerm(e.draft)} → ${normalizeTerm(e.published)}`;
    const seen = byPair.get(key) ?? { draft: e.draft, published: e.published, itemIds: [], sources: [] };
    if (!seen.itemIds.includes(e.itemId)) seen.itemIds.push(e.itemId);
    if (!seen.sources.includes(e.source)) seen.sources.push(e.source);
    byPair.set(key, seen);
  }
```

Destructure `sources` in the `for (const [, { ... }] of byPair)` loop and put `sources,` on the pushed candidate and on the `rejected.push` object.

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run tests/domain/translation/glossaryMining.test.ts`
Expected: PASS.

- [ ] **Step 5: Show the source in the review file**

Write the failing test first, in `tests/domain/translation/glossaryReview.test.ts`:

```typescript
  it("says which feed a substitution came from, so the reader knows how strong the evidence is", () => {
    const rows = renderCandidateReview(
      {
        candidates: [{
          key: "구매하신 → 구매한", signal: "substitution", tier: "A", term: "구매한",
          draft: "구매하신", published: "구매한", occurrences: 1, itemIds: ["x:1"], sources: ["review"],
        }],
        rejected: [],
        corpus: { state: "missing" },
      } as never,
      { path: "/tmp/c.json", now: "2026-08-18T00:00:00.000Z", sourceTweetCount: 0, translationCount: 0 },
    );
    expect(JSON.stringify(rows)).toContain("검수 수정");
  });
```

Match the file's existing fixture shape for `MiningResult`/`corpus` if it differs. Run
`npx vitest run tests/domain/translation/glossaryReview.test.ts` and watch it fail, then in
`renderCandidateReview` (`glossaryReview.ts:94`) emit the label beside the substitution fields the
row already carries:

```typescript
const SOURCE_LABEL = { published: "게시 수정", review: "검수 수정" } as const;
// on a substitution row, alongside its existing draft/published fields:
근거: (c.sources ?? []).map((s) => SOURCE_LABEL[s]).join(" + "),
```

Run the test again and watch it pass.

- [ ] **Step 6: Build the feed in the CLI**

In `src/cli/glossary-mine.ts`, alongside the existing `Promise.all`, load the lineage and build the pairs — then pass `humanEdits` into `mineGlossaryCandidates`:

```typescript
  // One `load()` per item rather than a whole-table read: `listEvents` deliberately drops `content`
  // (`LineageStore.listEvents`), and the diff needs the text.
  const lineageItems = await stores.lineageStore.listItems();
  const humanEdits: TextPair[] = (
    await Promise.all(
      lineageItems.map(async (s) =>
        humanEditPairs((await stores.lineageStore.load(s.itemId)).filter((e) => e.stage === "translated")),
      ),
    )
  ).flat();
```

Add `humanEdits` to the `mineGlossaryCandidates({ ... })` call, and extend the stdout summary line at `:136` to name both feeds, e.g. `` `… and ${humanEdits.length} reviewer edit(s)` ``.

- [ ] **Step 7: Run the whole suite and typecheck**

Run: `npx vitest run && npx tsc --noEmit`
Expected: all green.

- [ ] **Step 8: Commit**

```bash
git add src/domain/translation src/cli/glossary-mine.ts tests/domain/translation
git commit -m "feat(glossary): mine the 1차 검수 edit beside the published one"
```

---

### Task 6: documentation

**Files:**
- Modify: `docs/ko/artifacts.md:150` (`pnpm glossary:mine` row), `docs/ko/capabilities.md`

**Interfaces:**
- Consumes: everything above. Produces: no code.

- [ ] **Step 1: Update the `glossary:mine` inputs row**

`docs/ko/artifacts.md:150` currently names its inputs as source tweets, the translation ledger "발행 원문이 채워진 행의 초안↔발행 대조용", the glossary, the dismissal list and the reference corpus. Add the lineage ledger: `lineage`(`stage="translated"` 행 — 정렬 이후 사람이 고친 부분을 뜨기 위해, `actor`가 없는 옛 행은 제외).

- [ ] **Step 2: Note the second feed in the capability table**

In `docs/ko/capabilities.md`, find the glossary-mining capability row and add that the candidate list now comes from two edit feeds — 게시된 글과의 차이, 그리고 1차 검수에서 사람이 고친 차이 — and that the review file says which.

- [ ] **Step 3: Run the docs tests**

Run: `npx vitest run tests/docs`
Expected: PASS.

- [ ] **Step 4: Commit**

```bash
git add docs/ko
git commit -m "docs(glossary): name the reviewer-edit feed among glossary:mine's inputs"
```

---

## Deployment

Both halves, in the runbook's order — the schema change makes this mandatory, not optional:

```bash
pnpm deploy:check                                    # must be 0 fail
npx vercel deploy --prod
pnpm deploy:smoke https://mantle-kr-herald.vercel.app
bash deploy/herald-deploy.sh --yes                   # runs pnpm db:migrate — adds lineage.actor
pnpm doctor                                          # expect 0 warn · 0 fail
```

`herald-deploy.sh` migrates after it installs the code, and the timers do not fire mid-script, so the column exists before anything writes it. Do not hand-deploy these steps out of order.
