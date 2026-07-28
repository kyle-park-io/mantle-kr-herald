# X Premium-aware Tweet Limit Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let the x-channel weighted limit follow the posting account — X Premium ⇒ 25,000, standard ⇒ 280 — driven by one env flag, so Mantle's long-form tweets stop being blocked at send.

**Architecture:** A new `X_PREMIUM_MAX_WEIGHTED = 25000` constant + a `loadXMaxWeighted()` config reader (env `X_PREMIUM`). The resolved limit threads to the one place it matters — `emitX`'s `overLimit`/warning math — through an **optional `xMaxWeighted` parameter defaulting to `X_MAX_WEIGHTED` (280)**, so every existing call and test is unchanged. Callers (SendChannels, FormatVariants, refinement worksheet, dashboard) resolve the limit from config at the CLI/adapter boundary and inject it; domain code never reads `process.env`.

**Tech Stack:** Hexagonal TypeScript (domain/ports/adapters/app/cli), ESM, zod-only runtime dep, vitest. Chat/UI copy Korean; code + comments English.

## Global Constraints

- The `xMaxWeighted` parameter/field **defaults to `X_MAX_WEIGHTED` (280)** at every seam — omitting it must reproduce today's behavior byte-for-byte (all existing tests stay green).
- `X_PREMIUM` enables premium **only** when the trimmed value is exactly `"true"`; unset / `"false"` / anything else ⇒ 280.
- `X_PREMIUM_MAX_WEIGHTED = 25000`. Do not change `X_MAX_WEIGHTED = 280` or the telegram/kakao/pr_mail limits.
- **Domain functions never read `process.env`.** The limit is resolved via `loadXMaxWeighted()` at the CLI/adapter boundary and injected inward.
- One flag governs **both** x destinations (`x_paste`, `x_typefully`) — same brand account.
- After every task: `pnpm test` green and `pnpm exec tsc --noEmit` clean.

---

### Task 1: Constant + config reader + `.env.example`

**Files:**
- Modify: `src/domain/formatting/weightedLength.ts` (add constant)
- Modify: `src/config.ts` (add `loadXMaxWeighted`)
- Modify: `.env.example` (document `X_PREMIUM`)
- Test: `tests/config/loadXMaxWeighted.test.ts`

**Interfaces:**
- Produces: `X_PREMIUM_MAX_WEIGHTED: number` (=25000) from `weightedLength.ts`; `loadXMaxWeighted(): number` from `config.ts`.

- [ ] **Step 1: Write the failing test**

`tests/config/loadXMaxWeighted.test.ts`:
```ts
import { describe, it, expect, afterEach } from "vitest";
import { loadXMaxWeighted } from "../../src/config";

const orig = process.env.X_PREMIUM;
afterEach(() => { if (orig === undefined) delete process.env.X_PREMIUM; else process.env.X_PREMIUM = orig; });

describe("loadXMaxWeighted", () => {
  it("returns 25000 when X_PREMIUM is exactly 'true'", () => {
    process.env.X_PREMIUM = "true";
    expect(loadXMaxWeighted()).toBe(25000);
  });
  it("tolerates surrounding whitespace", () => {
    process.env.X_PREMIUM = "  true  ";
    expect(loadXMaxWeighted()).toBe(25000);
  });
  it("returns 280 when unset, 'false', or anything else", () => {
    delete process.env.X_PREMIUM;
    expect(loadXMaxWeighted()).toBe(280);
    process.env.X_PREMIUM = "false";
    expect(loadXMaxWeighted()).toBe(280);
    process.env.X_PREMIUM = "1";
    expect(loadXMaxWeighted()).toBe(280);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm exec vitest run tests/config/loadXMaxWeighted.test.ts`
Expected: FAIL — `loadXMaxWeighted` is not exported.

- [ ] **Step 3: Implement**

In `src/domain/formatting/weightedLength.ts`, after `export const X_MAX_WEIGHTED = 280;`:
```ts
/** X Premium long-post ceiling (25,000 chars). Used for the x weighted limit when the posting
 *  account is Premium; standard accounts stay at X_MAX_WEIGHTED. */
export const X_PREMIUM_MAX_WEIGHTED = 25000;
```
In `src/config.ts`, add the import and the reader (place the import with the other imports at the top):
```ts
import { X_MAX_WEIGHTED, X_PREMIUM_MAX_WEIGHTED } from "./domain/formatting/weightedLength";
```
```ts
/** The x-channel weighted limit for this run: X Premium (25,000) when X_PREMIUM=true, else the
 *  standard 280. One flag for the whole pipeline — it serves a single brand account. */
export function loadXMaxWeighted(): number {
  return process.env.X_PREMIUM?.trim() === "true" ? X_PREMIUM_MAX_WEIGHTED : X_MAX_WEIGHTED;
}
```

- [ ] **Step 4: Document `X_PREMIUM` in `.env.example`**

Add a block (near the Typefully / X send settings):
```
# Set to true only when the X account posts are published to is X Premium — enables long-form
# tweets up to 25,000 chars for x sends (Typefully). Default (unset/false) enforces the standard
# 280-weighted limit.
X_PREMIUM=false
```

- [ ] **Step 5: Run test to verify it passes**

Run: `pnpm exec vitest run tests/config/loadXMaxWeighted.test.ts`
Expected: PASS (3 tests).

- [ ] **Step 6: Commit**

```bash
git add src/domain/formatting/weightedLength.ts src/config.ts .env.example tests/config/loadXMaxWeighted.test.ts
git commit -m "feat(x-limit): X_PREMIUM_MAX_WEIGHTED constant + loadXMaxWeighted config reader"
```

---

### Task 2: Thread the limit through `emit`

**Files:**
- Modify: `src/domain/formatting/emitters/x.ts` (`emitX` gains the param)
- Modify: `src/domain/formatting/emitters/index.ts` (`EMITTERS` type + `emit`/`emitAll` pass it)
- Test: `tests/domain/formatting/emitters/index.test.ts` (add cases)

**Interfaces:**
- Consumes: `X_MAX_WEIGHTED` (default), `X_PREMIUM_MAX_WEIGHTED` (Task 1).
- Produces: `emit(canonical, destination, xMaxWeighted?)`, `emitAll(canonical, channel, xMaxWeighted?)` — both default `xMaxWeighted` to `X_MAX_WEIGHTED`; only the x emitter reads it.

- [ ] **Step 1: Write the failing test**

Add to `tests/domain/formatting/emitters/index.test.ts`:
```ts
import { emit } from "../../../../src/domain/formatting/emitters";

describe("x weighted limit is configurable", () => {
  const longKo = "가".repeat(150); // 300 weighted — over 280, under 25000

  it("flags an over-280 x post at the default limit", () => {
    const seg = emit(longKo, "x_typefully").segments[0];
    expect(seg.limit).toBe(280);
    expect(seg.overLimit).toBe(true);
  });

  it("does not flag it when xMaxWeighted is 25000 (Premium)", () => {
    const seg = emit(longKo, "x_typefully", 25000).segments[0];
    expect(seg.limit).toBe(25000);
    expect(seg.overLimit).toBe(false);
  });

  it("a non-x destination ignores xMaxWeighted", () => {
    // telegram uses its own limit; passing xMaxWeighted must not change its result
    const a = emit("짧은 공지", "telegram_bot").segments;
    const b = emit("짧은 공지", "telegram_bot", 25000).segments;
    expect(b).toEqual(a);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm exec vitest run tests/domain/formatting/emitters/index.test.ts`
Expected: FAIL — the 25000 case still reports `limit:280`, `overLimit:true` (the arg is ignored / not accepted).

- [ ] **Step 3: Implement — `emitX` reads the limit**

In `src/domain/formatting/emitters/x.ts`, change the signature and the three `X_MAX_WEIGHTED` uses:
```ts
function emitX(canonical: string, xMaxWeighted: number = X_MAX_WEIGHTED): EmitResult {
```
```ts
    const overLimit = length > xMaxWeighted;
    const segment: EmitSegment = { text, length, limit: xMaxWeighted, overLimit };
```
```ts
      warnings.push(`${where}${length}/${xMaxWeighted} (${length - xMaxWeighted} 초과)`);
```
(`emitXPaste`/`emitXTypefully = emitX` stay as-is — they inherit the parameter.)

- [ ] **Step 4: Implement — `emit`/`emitAll` pass it through**

In `src/domain/formatting/emitters/index.ts`:
- Widen the `EMITTERS` map type so the value accepts the optional second arg:
```ts
const EMITTERS: Record<Destination, (canonical: string, xMaxWeighted?: number) => EmitResult> = {
```
(The non-x emitters keep their single-param signatures — a function taking fewer params satisfies the wider type and ignores the extra arg.)
- Thread the parameter:
```ts
export function emit(canonical: string, destination: Destination, xMaxWeighted: number = X_MAX_WEIGHTED): EmitResult {
  return EMITTERS[destination](stripMedia(canonical), xMaxWeighted);
}

export function emitAll(canonical: string, channel: Channel, xMaxWeighted: number = X_MAX_WEIGHTED): Partial<Record<Destination, EmitResult>> {
  const out: Partial<Record<Destination, EmitResult>> = {};
  for (const destination of DESTINATIONS_BY_CHANNEL[channel]) {
    out[destination] = emit(canonical, destination, xMaxWeighted);
  }
  return out;
}
```
Add the import: `import { X_MAX_WEIGHTED } from "../weightedLength";` (keep the existing `stripMedia` import from the media-in-source feature).

- [ ] **Step 5: Run tests to verify they pass**

Run: `pnpm exec vitest run tests/domain/formatting/emitters/`
Expected: PASS — new cases plus every existing emitter test (default arg = 280).

- [ ] **Step 6: Commit**

```bash
git add src/domain/formatting/emitters/x.ts src/domain/formatting/emitters/index.ts tests/domain/formatting/emitters/index.test.ts
git commit -m "feat(x-limit): emit/emitAll thread an optional xMaxWeighted to the x emitter"
```

---

### Task 3: `SendChannels` uses the limit (the load-bearing send fix)

**Files:**
- Modify: `src/app/SendChannels.ts` (ctor field + pass to `emit`)
- Modify: `src/cli/send-channels.ts` (inject `loadXMaxWeighted()`)
- Test: `tests/app/sendChannels.test.ts` (add cases)

**Interfaces:**
- Consumes: `emit(..., xMaxWeighted)` (Task 2), `loadXMaxWeighted()` (Task 1), `X_MAX_WEIGHTED` (default).
- Produces: `SendChannels` ctor gains a trailing `xMaxWeighted: number = X_MAX_WEIGHTED`.

- [ ] **Step 1: Write the failing test**

Add to `tests/app/sendChannels.test.ts`:
```ts
  it("fail-fasts an over-280 x rendering at the default (standard) limit", async () => {
    const store = fakeStore([rendering({ itemId: "x:1", channel: "x", status: "approved", text: "가".repeat(150) })]);
    const { ledger } = fakeLedger();
    const sender = okSender("x");
    const res = await new SendChannels(store, { telegram: undefined, x: sender }, ledger).run({ targets: ["x"] });
    expect(res).toEqual({ sent: 0, skipped: 0, failed: 1 });
  });

  it("sends an over-280 x rendering when xMaxWeighted is 25000 (Premium)", async () => {
    const store = fakeStore([rendering({ itemId: "x:1", channel: "x", status: "approved", text: "가".repeat(150) })]);
    const { ledger } = fakeLedger();
    const sent: string[][] = [];
    const sender: ChannelSender = { name: "x", send: async (req) => { sent.push(req.segments); return { postId: "1" }; } };
    const res = await new SendChannels(store, { telegram: undefined, x: sender }, ledger, undefined, undefined, undefined, 25000).run({ targets: ["x"] });
    expect(res).toEqual({ sent: 1, skipped: 0, failed: 0 });
    expect(sent[0][0]).toBe("가".repeat(150));
  });
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm exec vitest run tests/app/sendChannels.test.ts`
Expected: FAIL — the 25000 case: the ctor ignores the 7th arg, so the guard still fires and `failed:1`.

- [ ] **Step 3: Implement**

In `src/app/SendChannels.ts`:
- Add the import: `import { X_MAX_WEIGHTED } from "../domain/formatting/weightedLength";`
- Add the trailing ctor field:
```ts
    private readonly now: () => string = () => new Date().toISOString(),
    private readonly xMaxWeighted: number = X_MAX_WEIGHTED,
  ) {}
```
- Pass it to `emit`:
```ts
      const emitResult = emit(r.text, DELIVERY_DESTINATION[r.channel], this.xMaxWeighted);
```

- [ ] **Step 4: Wire the CLI**

In `src/cli/send-channels.ts`:
- Add: `import { loadXMaxWeighted } from "../config";`
- Change the construction:
```ts
const result = await new SendChannels(store, senders, ledger, record, archive, undefined, loadXMaxWeighted()).run({ targets, ids });
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `pnpm exec vitest run tests/app/sendChannels.test.ts && pnpm exec tsc --noEmit`
Expected: PASS — new cases plus every existing SendChannels test; types clean.

- [ ] **Step 6: Commit**

```bash
git add src/app/SendChannels.ts src/cli/send-channels.ts tests/app/sendChannels.test.ts
git commit -m "feat(x-limit): SendChannels honors xMaxWeighted so Premium long-form posts are not fail-fasted"
```

---

### Task 4: Display consistency — format warnings, refinement worksheet, dashboard

**Files:**
- Modify: `src/app/FormatVariants.ts` (ctor field + pass to `emitAll`)
- Modify: `src/domain/formatting/refinementWorksheet.ts` (`assembleRefinementWorksheet` param + `report`/x-constraint use it)
- Modify: `src/app/PrepareRefinements.ts` (ctor field + pass to `assembleRefinementWorksheet`)
- Modify: `src/cli/format.ts` (inject `loadXMaxWeighted()` into both use-cases)
- Modify: `src/adapters/web/apiHandlers.ts` (`ApiDeps.xMaxWeighted` + pass to `emitAll`)
- Modify: `src/cli/serve.ts` (`deps.xMaxWeighted = loadXMaxWeighted()`)
- Test: `tests/app/formatVariants.test.ts` (add a case)

**Interfaces:**
- Consumes: `emitAll(..., xMaxWeighted)` (Task 2), `assembleRefinementWorksheet(..., xMaxWeighted)`, `loadXMaxWeighted()` (Task 1).
- Produces: `FormatVariants` and `PrepareRefinements` ctors gain a trailing `xMaxWeighted = X_MAX_WEIGHTED`; `assembleRefinementWorksheet(drafts, glossary, xMaxWeighted = X_MAX_WEIGHTED)`; `ApiDeps` gains `xMaxWeighted: number`.

- [ ] **Step 1: Write the failing test**

Add to `tests/app/formatVariants.test.ts` (follow the existing setup in that file for building an approved variant + fake stores):
```ts
  it("does not warn an over-280 x variant when xMaxWeighted is 25000", async () => {
    const conversionStore = fakeConversionStore([approvedVariant({ itemId: "x:1", type: "x", convertedText: "가".repeat(150) })]);
    const { renderings, warnings } = await new FormatVariants(conversionStore, fakeFormattingStore(), undefined, 25000).run({ types: ["x"] });
    expect(renderings.some((r) => r.channel === "x")).toBe(true);
    expect(warnings).toEqual([]); // 300 weighted is under 25000 → no 초과 warning
  });
```
(Use whatever the file's existing helpers are named — `approvedVariant`/`fakeConversionStore`/`fakeFormattingStore` are placeholders for the file's own fixtures; match them. If the file lacks a fake formatting store, reuse the one the existing tests build.)

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm exec vitest run tests/app/formatVariants.test.ts`
Expected: FAIL — the ctor ignores the 4th arg, so the x variant still warns `300/280 (20 초과)`.

- [ ] **Step 3: `FormatVariants` takes + passes the limit**

In `src/app/FormatVariants.ts`:
- Add the import: `import { X_MAX_WEIGHTED } from "../domain/formatting/weightedLength";`
- Add the trailing ctor field:
```ts
    private readonly now: () => string = () => new Date().toISOString(),
    private readonly xMaxWeighted: number = X_MAX_WEIGHTED,
  ) {}
```
- Pass it to `emitAll`:
```ts
        for (const [destination, result] of Object.entries(emitAll(text, channel, this.xMaxWeighted)) as [Destination, EmitResult][]) {
```

- [ ] **Step 4: `refinementWorksheet` + `PrepareRefinements` take the limit**

In `src/domain/formatting/refinementWorksheet.ts`:
- Change `report` to accept + use the limit:
```ts
function report(channel: Channel, draft: string, xMaxWeighted: number): string {
  const { segments } = emit(draft, DESTINATIONS_BY_CHANNEL[channel][0], xMaxWeighted);
```
- Replace the static `CONSTRAINT` map's x line with a per-call builder so the printed x limit matches the run. Replace the `CONSTRAINT` const + its use in `assembleRefinementWorksheet` with:
```ts
/** Static for every channel except x, whose limit depends on the account (see xMaxWeighted). */
function constraintLine(channel: Channel, xMaxWeighted: number): string {
  if (channel === "x") return `- x: 트윗당 ${xMaxWeighted} 가중치 (**한글·이모지는 2**, 그 외 1, URL은 길이 무관 ${TCO_LENGTH})`;
  return { telegram: `- telegram: 메시지당 ${TELEGRAM_MAX}자`, kakao: `- kakao: **${KAKAO_FOLD}자 초과 시 말풍선이 「전체보기」로 접힙니다**`, pr_mail: `- pr_mail: 첫 줄이 제목` }[channel];
}
```
- Change the public signature + the two call sites inside it:
```ts
export function assembleRefinementWorksheet(drafts: RefinementDraft[], glossary: GlossaryEntry[], xMaxWeighted: number = X_MAX_WEIGHTED): string {
```
```ts
  const constraints = ["## 채널 제약", ...channels.map((c) => constraintLine(c, xMaxWeighted))].join("\n");
```
```ts
      report(d.channel, d.draft, xMaxWeighted),
```

In `src/app/PrepareRefinements.ts`:
- Add `import { X_MAX_WEIGHTED } from "../domain/formatting/weightedLength";`
- Add a trailing ctor field `private readonly xMaxWeighted: number = X_MAX_WEIGHTED,` (after the existing params).
- Pass it: `const worksheet = assembleRefinementWorksheet(drafts, glossary, this.xMaxWeighted);`

- [ ] **Step 5: Wire `format.ts`**

In `src/cli/format.ts`:
- Add `import { loadXMaxWeighted } from "../config";`
- `const xMaxWeighted = loadXMaxWeighted();`
- `new PrepareRefinements(...)` — append `xMaxWeighted` as the last constructor arg (after its existing args).
- `new FormatVariants(conversionStore, new JsonFormattingStore(paths.formattedDir), undefined, xMaxWeighted)`.

- [ ] **Step 6: Wire the dashboard (`apiHandlers.ts` + `serve.ts`)**

In `src/adapters/web/apiHandlers.ts`:
- Add `xMaxWeighted: number;` to the `ApiDeps` interface.
- Change the emissions route: `return { status: 200, json: emitAll(existing.text, channel, deps.xMaxWeighted) };`

In `src/cli/serve.ts`:
- Add `import { loadXMaxWeighted } from "../config";` (or extend the existing config import).
- Add `xMaxWeighted: loadXMaxWeighted(),` to the `deps: ApiDeps` object literal.

- [ ] **Step 7: Run the full suite + typecheck**

Run: `pnpm exec vitest run && pnpm exec tsc --noEmit`
Expected: PASS — the new FormatVariants case plus every existing test; types clean (all new params default to 280).

- [ ] **Step 8: Commit**

```bash
git add -A
git commit -m "feat(x-limit): thread xMaxWeighted to format warnings, refinement worksheet, and dashboard emissions"
```

---

## Self-Review

- **Spec coverage:** constant + `loadXMaxWeighted` + `.env.example` → Task 1; `emit`/`emitAll`/`emitX` threading → Task 2; `SendChannels` send fix + CLI → Task 3; `FormatVariants` + `refinementWorksheet`/`PrepareRefinements` + `apiHandlers`/`serve` display → Task 4. All spec "Files touched" mapped.
- **Type consistency:** `xMaxWeighted: number` and its `X_MAX_WEIGHTED` default are identical across Tasks 2/3/4; `X_PREMIUM_MAX_WEIGHTED` (Task 1) is the only 25000 literal outside tests; `emit`/`emitAll` third-arg shape matches every call site.
- **Ordering:** 1 (constant/config) → 2 (emit accepts the arg) → 3 (send injects it) → 4 (display injects it). Each task leaves `pnpm test` green and the branch compiling because every new parameter defaults to `X_MAX_WEIGHTED`.
- **Placeholder scan:** all steps carry real code or exact commands, except Task 4 Step 1's fixture names, which are explicitly flagged to match `formatVariants.test.ts`'s own helpers (the implementer reads that file first).

## Execution note (model tiers)

- Task 1: cheap (constant + one config fn + test).
- Task 2: cheap/standard (mechanical signature threading with complete code).
- Task 3: standard (the load-bearing send behavior + CLI).
- Task 4: standard (multi-file display threading; refinementWorksheet's `CONSTRAINT`→`constraintLine` refactor needs care).
