// tests/cli/translateSince.test.ts
import { describe, it, expect } from "vitest";
import { parseTranslateSince } from "../../src/cli/translateSince";

describe("parseTranslateSince", () => {
  it("returns undefined when unset, so the tick keeps its whole-backlog behaviour", () => {
    expect(parseTranslateSince(undefined)).toBeUndefined();
  });

  it("treats an empty or whitespace-only value as unset rather than as a cutoff", () => {
    // An EnvironmentFile= line left as `HERALD_TRANSLATE_SINCE=` reaches Node as "", not as
    // undefined. Passing "" through to `--since` would hand `translate:prepare` a filter that
    // every ISO timestamp compares greater-than-or-equal to — a no-op that looks configured.
    expect(parseTranslateSince("")).toBeUndefined();
    expect(parseTranslateSince("   ")).toBeUndefined();
  });

  it("normalises a full ISO timestamp to the exact form translate:prepare compares against", () => {
    expect(parseTranslateSince("2026-07-27T14:35:24.000Z")).toBe("2026-07-27T14:35:24.000Z");
  });

  it("normalises a date-only value to the start of that UTC day", () => {
    // `PrepareTranslations.applySelector` compares `i.createdAt >= since` as *strings*. A bare
    // "2026-07-27" happens to sort correctly against ISO timestamps, but only by accident of the
    // shared prefix; normalising removes the accident.
    expect(parseTranslateSince("2026-07-27")).toBe("2026-07-27T00:00:00.000Z");
  });

  it("normalises a non-UTC offset to UTC, so the string comparison stays sound", () => {
    // "2026-07-27T23:35:24+09:00" is 14:35:24Z. Lexicographically the raw form sorts *after*
    // every 2026-07-27 UTC timestamp — the opposite of what it means.
    expect(parseTranslateSince("2026-07-27T23:35:24+09:00")).toBe("2026-07-27T14:35:24.000Z");
  });

  it("throws on a value Date cannot parse, rather than silently filtering everything out", () => {
    // Enforce, don't document: a typo'd cutoff that reaches `--since` as garbage makes the
    // scheduler quietly translate nothing (or everything) for as long as nobody reads a journal.
    expect(() => parseTranslateSince("last tuesday")).toThrow(/HERALD_TRANSLATE_SINCE/);
    expect(() => parseTranslateSince("2026-13-45")).toThrow(/HERALD_TRANSLATE_SINCE/);
  });

  it("names the offending value in the error, so the journal line is actionable", () => {
    expect(() => parseTranslateSince("2026-07-32")).toThrow(/2026-07-32/);
  });
});
