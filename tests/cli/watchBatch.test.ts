// tests/cli/watchBatch.test.ts
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { parseWatchBatch, DEFAULT_WATCH_BATCH } from "../../src/cli/watchBatch";

describe("parseWatchBatch", () => {
  it("defaults to 3 when the variable is unset", () => {
    expect(DEFAULT_WATCH_BATCH).toBe(3);
    expect(parseWatchBatch(undefined)).toBe(3);
  });

  it("treats an empty or whitespace-only value as unset", () => {
    // `HERALD_WATCH_BATCH=` with nothing after it reaches Node as "", not undefined — the same
    // trap `parseTranslateSince` documents. `Number("")` is 0, which would hand `--limit 0` to
    // every tick: a scheduler that prepares nothing, forever, while looking configured.
    expect(parseWatchBatch("")).toBe(3);
    expect(parseWatchBatch("   ")).toBe(3);
  });

  it("accepts a positive integer, trimmed", () => {
    expect(parseWatchBatch("5")).toBe(5);
    expect(parseWatchBatch(" 10 ")).toBe(10);
  });

  it("refuses zero", () => {
    expect(() => parseWatchBatch("0")).toThrow(/HERALD_WATCH_BATCH/);
  });

  it("refuses a negative", () => {
    expect(() => parseWatchBatch("-3")).toThrow(/HERALD_WATCH_BATCH/);
  });

  it("refuses a fraction instead of silently flooring it", () => {
    // `--limit 2.5` arriving at translate:prepare is a much worse thing to debug than a refusal
    // at the entry point, where the journal line names the variable.
    expect(() => parseWatchBatch("2.5")).toThrow(/HERALD_WATCH_BATCH/);
  });

  it("refuses values `Number()` would happily coerce", () => {
    // `Number("0x10")` is 16 and `Number("1e2")` is 100. A unit-file typo must not quietly become
    // a batch size nobody chose, so the check is a digit pattern and not `Number.isFinite`.
    for (const raw of ["three", "3 items", "0x10", "1e2", "Infinity", "+3"]) {
      expect(() => parseWatchBatch(raw), raw).toThrow(/HERALD_WATCH_BATCH/);
    }
  });

  it("refuses a digit string too long to survive Number()", () => {
    // The digit pattern alone accepts this: 26 digits, no sign, no fraction. `Number()` then rounds
    // it to 1e26, and `String(batch)` — what `WatchTick` hands `--limit` — emits "1e+26", the exact
    // exponent notation this very function refuses on input. So without a safe-integer check the
    // rule contradicts itself, and a paste accident reaches translate:prepare as garbage anyway.
    expect(() => parseWatchBatch("1".repeat(26))).toThrow(/HERALD_WATCH_BATCH/);
    expect(() => parseWatchBatch(String(Number.MAX_SAFE_INTEGER + 2))).toThrow(/HERALD_WATCH_BATCH/);
    // The boundary itself is still a positive integer, absurd though it is — the check is
    // representability, not a policy about size.
    expect(parseWatchBatch(String(Number.MAX_SAFE_INTEGER))).toBe(Number.MAX_SAFE_INTEGER);
  });

  it("names the offending value, so the journal line is actionable on its own", () => {
    // This message reaches Telegram through herald-notify-failure.sh's journal excerpt. "invalid
    // batch size" without the value sends someone to ssh into the box to find out what it was.
    expect(() => parseWatchBatch("zero")).toThrow(/"zero"/);
  });
});

describe("HERALD_WATCH_BATCH on the systemd unit", () => {
  const unit = readFileSync(resolve(__dirname, "../../deploy/herald-watch.service"), "utf8");

  it("ships a value the parser accepts, or a commented placeholder that says where it goes", () => {
    // The equivalent of `tests/deploy/watchCutoff.test.ts`'s "uses a cutoff the CLI will actually
    // accept at startup", for the unit's other tunable. `pnpm watch` refuses to run on an
    // unparseable value, so a unit file shipping one turns every scheduled tick into a failure —
    // caught here rather than at 00:17 on install night.
    //
    // The absent branch is not a free pass: the dial only exists to be tuned without a deploy, and
    // an operator finds it by reading the unit beside the two Environment= lines that *are* set. A
    // commented placeholder is what makes it findable, so its removal fails this test too.
    const set = /^Environment=HERALD_WATCH_BATCH=(.*)$/m.exec(unit);
    if (set === null) {
      expect(unit).toMatch(/^#\s*Environment=HERALD_WATCH_BATCH=/m);
      return;
    }
    expect(() => parseWatchBatch(set[1].trim())).not.toThrow();
  });
});

describe("HERALD_WATCH_BATCH documentation", () => {
  it("is named in the Korean operator runbook, not only in .env.example", () => {
    // .env.example, the CHANGELOG and the design docs are all developer-facing English. The person
    // who tunes throughput reads docs/ko/team-runbook.md §6, which documents the unit's other two
    // Environment= lines for exactly that reason — a dial nobody is told about is not configuration.
    const runbook = readFileSync(resolve(__dirname, "../../docs/ko/team-runbook.md"), "utf8");
    expect(runbook).toContain("HERALD_WATCH_BATCH");
  });

  it("is listed in .env.example, where every read variable is listed", () => {
    // Same guard `tests/deploy/watchCutoff.test.ts` makes for HERALD_TRANSLATE_SINCE: a variable
    // documented nowhere is a variable the next operator does not know exists, and a doc table
    // with no test rots at the first rename.
    const example = readFileSync(resolve(__dirname, "../../.env.example"), "utf8");
    expect(example).toMatch(/^HERALD_WATCH_BATCH=/m);
  });
});
