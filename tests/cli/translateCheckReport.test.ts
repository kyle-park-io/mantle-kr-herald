// tests/cli/translateCheckReport.test.ts
//
// `src/cli/translate-check.ts` is a top-level script with no coverage of its own — importing it
// opens a database connection — so its ops-alert wording lives in `src/cli/translateCheckReport.ts`
// and is asserted here, the same split `xReconcileReport.ts` / `tests/cli/xReconcileReport.test.ts`
// already uses. The `--notify` WIRING, which no pure function can hold, is pinned at the source
// level in the second block, the way `tests/cli/translateCheckRefusal.test.ts` pins the empty
// glossary guard.
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, it, expect } from "vitest";
import { overrideNotification } from "../../src/cli/translateCheckReport";
import type { GlossaryOverride } from "../../src/domain/translation/glossaryCompliance";

const override = (itemId: string, term: string, expected: string): GlossaryOverride => ({ itemId, term, expected });

describe("overrideNotification", () => {
  it("sends nothing when no published override was found", () => {
    // The common case by far, and the one that decides whether this alert is worth having: a
    // scheduled run that pages every night with "nothing to report" is a run nobody reads.
    expect(overrideNotification([])).toBeUndefined();
  });

  it("reproduces the alert for the override actually present in production", () => {
    // Pinned as a whole string, not by substrings: this is the entire message a human sees on a
    // phone, and the only way to catch a regression in what surrounds the facts (the grammar's
    // <pre> block, the icon, the separator) is to compare all of it. The finding is real — a
    // 2026-08-11 run of `translate:check` against production.
    const message = overrideNotification([override("x:2080661810034917770", "market prices", "시장 가격")]);
    expect(message).toBe(
      'ℹ translate:check — 발행본이 덮어쓴 용어집 결정 1건 (용어집을 다시 볼 후보)\n<pre>"market prices" → 시장 가격 · 1개 항목</pre>',
    );
  });

  it("counts items, and names none of them", () => {
    // The count is the whole argument the reader is weighing — one item is an anecdote, four is a
    // pattern worth editing the glossary over — and the ids are a `translate:check` away. A
    // comma-run of ids is exactly what made the first x:reconcile alert unreadable on a phone
    // (see retireNotification), so this pins that they stay out.
    const message = overrideNotification([
      override("x:1", "narrative", "내러티브"),
      override("x:2", "narrative", "내러티브"),
      override("x:3", "narrative", "내러티브"),
      override("x:4", "narrative", "내러티브"),
    ]);
    expect(message).toContain('"narrative" → 내러티브 · 4개 항목');
    expect(message).not.toContain("x:1");
    expect(message).not.toContain("x:4");
  });

  it("counts an item once even if it is reported twice for the same term", () => {
    // The line claims "how many ITEMS", so a duplicated row must not inflate it. One row per
    // (item, entry) is what checkPublishedOverrides produces today; this is what keeps the claim
    // true if the ledger ever hands the CLI the same itemId twice.
    const message = overrideNotification([override("x:1", "narrative", "내러티브"), override("x:1", "narrative", "내러티브")]);
    expect(message).toContain("1개 항목");
    expect(message).not.toContain("2개 항목");
  });

  it("puts the loudest term first and breaks ties by name, so the same findings read the same twice", () => {
    // Most-overridden first: that entry is the likeliest to be a wrong decision rather than a
    // one-off exception. The tie-break is not cosmetic — an alert whose lines shuffle between runs
    // reads as new information when nothing changed.
    const message = overrideNotification([
      override("x:1", "beta", "베타"),
      override("x:2", "alpha", "알파"),
      override("x:3", "gamma", "감마"),
      override("x:4", "gamma", "감마"),
    ]);
    const lines = message!.split("\n");
    expect(lines[0]).toContain("3건"); // three distinct terms, not four findings
    expect(lines.slice(1).join("\n")).toBe(
      '<pre>"gamma" → 감마 · 2개 항목\n"alpha" → 알파 · 1개 항목\n"beta" → 베타 · 1개 항목</pre>',
    );
  });

  it("escapes a term Telegram would otherwise read as markup", () => {
    // Sent with parse_mode: "HTML". A bare `&` or `<` in a glossary term — `R&D` is an ordinary
    // one — makes Telegram reject the whole message, which costs the alert, not just its
    // formatting. Goes through opsAlertGrammar's escape, so notifyOps's plain-text retry can undo
    // it in the reverse order.
    const message = overrideNotification([override("x:1", "R&D", "연구개발")]);
    expect(message).toContain('"R&amp;D" → 연구개발');
    expect(message).not.toContain('"R&D"');
  });
});

describe("translate:check --notify wiring", () => {
  const SOURCE = readFileSync(fileURLToPath(new URL("../../src/cli/translate-check.ts", import.meta.url)), "utf8");

  it("sends only under --notify", () => {
    expect(SOURCE).toContain('const notify = process.argv.includes("--notify");');
    // The one and only send, and it is inside the gate — without --notify the command must behave
    // exactly as it did before the flag existed.
    expect(SOURCE.match(/await notifyOps\(/g)).toHaveLength(1);
    expect(SOURCE).toMatch(/if \(notify\) \{[\s\S]{0,300}?await notifyOps\(/);
  });

  it("pages on published overrides, never on glossary drift", () => {
    // The command prints "not every line is a defect" under the drift list; paging on it would
    // train the ops room to ignore this alert, and an ignored alert catches nothing. The builder is
    // handed `overrides` and nothing else.
    expect(SOURCE).toContain("overrideNotification(overrides)");
    expect(SOURCE).not.toContain("overrideNotification(misses)");
  });

  it("still exits 0 whatever it finds", () => {
    // A report, not a gate — the same reason it never threw on a finding before the flag. notifyOps
    // swallows its own failures, so the only way this could regress is a process.exitCode here.
    expect(SOURCE).not.toContain("process.exitCode");
    expect(SOURCE).not.toContain("process.exit(");
  });
});
