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

  it("names the offending value, so the journal line is actionable on its own", () => {
    // This message reaches Telegram through herald-notify-failure.sh's journal excerpt. "invalid
    // batch size" without the value sends someone to ssh into the box to find out what it was.
    expect(() => parseWatchBatch("zero")).toThrow(/"zero"/);
  });
});

describe("HERALD_WATCH_BATCH documentation", () => {
  it("is listed in .env.example, where every read variable is listed", () => {
    // Same guard `tests/deploy/watchCutoff.test.ts` makes for HERALD_TRANSLATE_SINCE: a variable
    // documented nowhere is a variable the next operator does not know exists, and a doc table
    // with no test rots at the first rename.
    const example = readFileSync(resolve(__dirname, "../../.env.example"), "utf8");
    expect(example).toMatch(/^HERALD_WATCH_BATCH=/m);
  });
});
