# Item lineage — per-item, append-only stage archive — design

Date: 2026-07-28
Status: approved for planning
Scope: a new lineage/archival layer that preserves each stage's output for an item, so nothing is
lost when a later stage overwrites it, and so you can see at which point and how an item changed.
One subsystem. Consumption is file-browsing + a `pnpm lineage` CLI (dashboard deferred).

## Context

Every content store in the pipeline is **upsert-by-id = overwrite**: `translations.json`,
`variants.json`, `renderings.json`. So when the alignment pass revises a translation, or `--refine`
rewrites a variant/rendering, or 2차 검수 approves a rendering, the **previous version at that stage is
gone** from the store. The timestamped agent worksheets (`worksheets/*.md`) capture the per-run
*input* incidentally, but they are keyed by batch, not by item, and do not hold the produced output.
There is no per-item record of "source → translation v1 → v2 (aligned) → variant → rendering → …".

Kyle wants both **(a) audit/preservation** — never lose a stage's output, reproducible — and
**(b) stage-by-stage debugging** — see at which point and how an item changed, to decide where to
improve. This is a per-item, append-only **lineage** layer.

## Decisions

### 1. Append-only lineage entry per stage output

Each time a content-producing use-case saves an item's stage output, it appends a snapshot:

```ts
interface LineageEntry {
  itemId: string;
  stage: "translated" | "converted" | "rendered"; // the revised/overwritten stages
  variant?: string;   // stage qualifier: type ("announcement") or "type/channel" ("announcement/telegram")
  content: string;    // the meaningful text produced at this stage (see per-stage mapping)
  status?: string;    // the record's status at this point (translated/approved/converted/rendered)
  sourceText?: string;// only on a "translated" entry: the English 원문, so 원본 shows in the journey
  at: string;         // ISO timestamp
}
```

The **revision number is not stored** — it is the append order among entries with the same
`(itemId, stage, variant)`. **Diffs are not stored** — the CLI computes them at view time between
consecutive same-stage entries (this is what shows "정렬이 뎁스→유동성으로 바꿈"). Full content
snapshots (not diffs) are stored: text is cheap, and a snapshot is what audit and reproduction need.

**Which stages (v1):** the three that overwrite/revise — `translated` (initial draft + every
align/re-save), `converted` (initial + every refine), `rendered` (initial + every refine + the
approve status-change). The **source (원문)** rides on the first `translated` entry's `sourceText`
(it is already durably in `x/items.json`, never lost — the lineage only needs to surface it).
`collected` and `sent` as first-class stages are non-goals (their stores are append/merge, not
lossy) — see Non-goals.

Per-stage `content` mapping: `translated` → `Translation.koreanText`; `converted` →
`ContentVariant.convertedText`; `rendered` → `ChannelRendering.text`.

### 2. Best-effort capture at the save use-cases

Instrument the four save use-cases that write these stores, each taking an **optional** injected
`LineageStore` and appending on a successful save — **best-effort**, wrapped so a lineage failure
never breaks the pipeline (mirrors `SendChannels`' best-effort recorder):

- `SaveTranslation` → `translated` (+ `sourceText`, + `status`).
- `SaveConversion` → `converted` (`variant` = type, + `status`).
- `SaveRendering` → `rendered` (`variant` = `type/channel`, + `status`).
- `ApproveRendering` → `rendered` (`variant` = `type/channel`, `status` = "approved").

Capturing at the use-case (not the raw store) keeps it semantic — the use-case knows the stage — and
means the store classes stay unchanged. The append records what was written, so align (a second
`SaveTranslation`) and refine (a second `SaveConversion`/`SaveRendering`) and approve naturally
become new same-stage entries; the CLI diff shows what each changed. A coarse trigger label
(aligned/refined) is a later nicety — the stage + diff already answer "어느 지점에서 어떻게".

### 3. Always-on, git-ignored, per-item JSONL

Lineage is **always on** (Kyle wants continuous preservation), wired at every save site
(`translate-save`, `convert-save`, `format-save`, and the dashboard `serve`). It writes to
`output/lineage/` — git-ignored local scratch, like the rest of `output/`.

**One file per item:** `output/lineage/<safeId>.jsonl`, where `safeId` = `itemId` with `:` replaced
by `_` (`x:2072…` → `x_2072….jsonl`), one JSON entry per line, appended. Opening one file shows that
item's whole journey. Append is read-nothing (`fs.appendFile` a line); load parses the lines.

### 4. `pnpm lineage [itemId]` CLI + a pure view renderer

- `pnpm lineage <itemId>` — prints the chronological journey for the item: for each entry, the
  stage/variant/status/timestamp and its content, and **a unified-ish diff against the previous
  entry of the same (stage, variant)** so a revision (align, refine, approve) shows exactly what
  changed. The very first `translated` entry prints the `sourceText` (원문) first.
- `pnpm lineage` (no id) — lists the items that have a lineage file (id + entry count + last stage).
- The journey assembly and diff are a **pure renderer** (`renderLineage(entries): string`),
  independently testable; the CLI is thin I/O around it.

## Architecture

- **Domain:** `src/domain/lineage/models.ts` — `LineageEntry`, `LineageStage`. `renderLineage`/diff
  helper in `src/domain/lineage/render.ts` (pure).
- **Port:** `src/ports/LineageStore.ts` — `append(entry): Promise<void>`, `load(itemId):
  Promise<LineageEntry[]>`, `listItems(): Promise<{ itemId: string; entries: number; lastStage:
  string }[]>`.
- **Adapter:** `src/adapters/store/JsonlLineageStore.ts` — `output/lineage/<safeId>.jsonl`
  (`append` via `fs.appendFile`; `load` reads+parses; `listItems` reads the dir). Id-sanitization
  `:`→`_` with the inverse for `load(itemId)`.
- **App:** the four save use-cases each gain an optional `lineage?: LineageStore` ctor arg and a
  best-effort append after their successful write. No behavior change when it is absent.
- **CLI:** `src/cli/lineage.ts` (`pnpm lineage [itemId]`), and a `buildLineage()` helper
  (`src/cli/lineage-wiring.ts`) that constructs the always-on `JsonlLineageStore`, injected at the
  four save sites + `serve`.
- **Reuse:** `paths` (add `lineageDir`), `argValue`, `registerErrorHandler`, the best-effort pattern
  from `buildRecorder`/`SendChannels`, `readJsonFile`/atomic-write conventions.

### Data flow

```
translate:save (initial)  → SaveTranslation → translations.json (upsert)
                                            └→ lineage.append{stage:translated, content:KO_v1, sourceText, status:translated}
translate:align → agent → translate:save   → SaveTranslation → translations.json (overwrite v2)
                                            └→ lineage.append{stage:translated, content:KO_v2, sourceText, status:translated}
convert:save (+refine)   → SaveConversion  → lineage.append{stage:converted, variant:announcement, content:…}
format:save (+refine)    → SaveRendering   → lineage.append{stage:rendered, variant:announcement/telegram, content:…}
2차 approve (dashboard)   → ApproveRendering → lineage.append{stage:rendered, variant:…/telegram, status:approved}

pnpm lineage x:2072…  → load output/lineage/x_2072….jsonl → renderLineage → journey + per-revision diff
```

## Error handling

- **Best-effort append:** every use-case wraps its `lineage.append` in its own try/catch (a warning
  on failure); a lineage write never fails or blocks the save. Absent `LineageStore` = no-op.
- **Malformed/partial JSONL line** on `load` → skip that line with a warning, render the rest (never
  throw — a corrupt line must not hide the whole journey).
- **Unknown itemId** (`pnpm lineage <id>` with no file) → a clean "no lineage for <id>" message,
  exit 0.
- Append is additive-only; it never rewrites or truncates an existing file.

## Testing

- `JsonlLineageStore` (temp dir): `append` then `load` round-trips entries in order; `:`→`_`
  sanitization maps `x:1` to `x_1.jsonl` and `load("x:1")` reads it back; a malformed line is
  skipped on load; `listItems` reports id + count + last stage.
- `renderLineage` (pure): a single entry renders stage/status/content; two same-`(stage,variant)`
  entries render a diff that names the changed text; the first `translated` entry surfaces
  `sourceText`; entries across stages render in chronological order. Pin concrete strings.
- Each instrumented use-case (fake stores + fake lineage): a successful save appends exactly one
  entry with the right `stage`/`variant`/`content`; a lineage-append failure is swallowed and the
  save still reports success; no `LineageStore` = no append and unchanged behavior.
- All synthetic data; no live calls.

## Non-goals

- **`sent` and `collected` as lineage stages** — `channels.json` and `x/items.json` are append/merge,
  not lossy overwrites, so their history already survives; folding them in is a later extension.
- **Semantic trigger labels** (aligned/refined/reapproved) — deferred; the stage + diff already show
  the change. Would need a trigger threaded from each caller.
- **Stored diffs** — computed at view time.
- **Retroactive lineage** — already-overwritten intermediates cannot be recovered; lineage starts
  capturing from first run after merge. (Current store state is the first snapshot going forward.)
- **Dashboard timeline UI**, **rollback/restore from lineage**, **retention/auto-expiry** — later;
  `output/lineage/` grows append-only for now (a future `pnpm clean` rule can prune).

## Global constraints

- Runtime deps stay **zod-only**; no new dependency; no network call. `append` uses `fs.appendFile`.
- Best-effort everywhere: lineage NEVER breaks or blocks a save; absent store = pure no-op.
- Only additive: the instrumented use-cases keep their existing behavior and return values unchanged
  when no `LineageStore` is injected; the stores themselves are untouched.
- `output/lineage/` is git-ignored local scratch (matches the rest of `output/`). Public repo: tests
  use synthetic items only, no real post text or PII committed.
- Every test can fail: pin concrete stage/variant/content strings, not something a mutation would
  still satisfy.

## Open items to verify (not blockers to planning)

- After merge, run the pipeline on one item through translate → align → convert → format → approve
  and confirm `output/lineage/<id>.jsonl` holds the ordered entries and `pnpm lineage <id>` shows
  the align diff (뎁스→유동성) and the approve status-change.
- Confirm the dashboard save paths (`serve.ts`) inject `buildLineage()` too, so approvals/edits made
  in the UI are captured, not just CLI saves.
