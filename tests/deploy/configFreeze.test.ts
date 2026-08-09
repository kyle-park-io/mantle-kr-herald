// tests/deploy/configFreeze.test.ts
//
// The parser exists to make the diff agree with what the scheduler actually sees, so its rules are
// Node's rules, measured on Node v24.19.0 rather than assumed:
//
//   PLAIN=hello            => "hello"
//   DQ="double quoted"     => "double quoted"     (quotes stripped)
//   SQ='single quoted'     => "single quoted"
//   export EXPORTED=yes    => "yes"               (export prefix accepted)
//   SPACED = spaced        => "spaced"            (whitespace around = trimmed)
//   EMPTY=                 => ""
//   HASH=val#notcomment    => "val"               (unquoted value truncated at #)
//   DUP=first / DUP=second => "second"            (last duplicate wins)
//
// Additional escaping and quote handling rules (measured; do not infer beyond these):
//   E1="a\nb"              => "a", LF, "b"        (\n IS interpreted inside double quotes)
//   E2="a\tb"              => "a\tb" (literal)    (\t is NOT interpreted)
//   E3="a\\b"              => "a\\b" (literal)    (\\ is NOT collapsed)
//   E4="a\"b"              => "a\"                (\" does NOT escape; quote closes, trailing discarded)
//   E5="a\zb"              => "a\zb" (literal)    (\z is not an escape)
//   E6='a\nb'              => "a\nb" (literal)    (single quotes interpret nothing)
//   E9=`tick\nhere`        => "tick\nhere"        (backticks strip but interpret nothing)
//   E7="bar"baz            => "bar"               (closing quote ends value, trailing discarded)
//   E8="unterminated       => "\"unterminated"    (no closing quote: NOT quoted, opening quote stays)
//
// A parser that disagrees with any of these reports a variable as changed when the scheduler would
// read the same value, or — worse — as unchanged when it would not.
import { describe, it, expect } from "vitest";
import { parseEnv } from "../../src/deploy/configFreeze";

describe("parseEnv", () => {
  it("reads a plain assignment", () => {
    expect(parseEnv("PLAIN=hello").get("PLAIN")).toBe("hello");
  });

  it("strips double and single quotes", () => {
    const env = parseEnv(`DQ="double quoted"\nSQ='single quoted'`);
    expect(env.get("DQ")).toBe("double quoted");
    expect(env.get("SQ")).toBe("single quoted");
  });

  it("accepts an export prefix", () => {
    expect(parseEnv("export EXPORTED=yes").get("EXPORTED")).toBe("yes");
  });

  it("trims whitespace around the equals sign", () => {
    expect(parseEnv("SPACED = spaced").get("SPACED")).toBe("spaced");
  });

  it("keeps an empty value as an empty string, not absent", () => {
    const env = parseEnv("EMPTY=");
    expect(env.has("EMPTY")).toBe(true);
    expect(env.get("EMPTY")).toBe("");
  });

  it("truncates an unquoted value at an inline #", () => {
    expect(parseEnv("HASH=val#notcomment").get("HASH")).toBe("val");
  });

  it("keeps a # inside a quoted value", () => {
    expect(parseEnv(`HASH="val#kept"`).get("HASH")).toBe("val#kept");
  });

  it("lets the last duplicate win, as Node does", () => {
    expect(parseEnv("DUP=first\nDUP=second").get("DUP")).toBe("second");
  });

  it("skips comments and blank lines", () => {
    expect([...parseEnv("# comment\n\n  \nA=1").keys()]).toEqual(["A"]);
  });

  it("ignores a line that is not an assignment", () => {
    expect([...parseEnv("garbage line\nA=1").keys()]).toEqual(["A"]);
  });

  it("handles CRLF line endings", () => {
    expect([...parseEnv("A=1\r\nB=2").keys()]).toEqual(["A", "B"]);
  });

  it("interprets \\n to a real newline inside double quotes (E1)", () => {
    const env = parseEnv('E1="a\\nb"');
    expect(env.get("E1")).toBe("a\nb");
  });

  it("does not interpret \\t inside double quotes (E2)", () => {
    expect(parseEnv('E2="a\\tb"').get("E2")).toBe("a\\tb");
  });

  it("does not collapse \\\\ inside double quotes (E3)", () => {
    expect(parseEnv('E3="a\\\\b"').get("E3")).toBe("a\\\\b");
  });

  it('does not interpret \\" as escape; quote closes and trailing is discarded (E4)', () => {
    expect(parseEnv('E4="a\\"b"').get("E4")).toBe('a\\');
  });

  it("does not interpret \\z as escape (E5)", () => {
    expect(parseEnv('E5="a\\zb"').get("E5")).toBe("a\\zb");
  });

  it("does not interpret anything inside single quotes (E6)", () => {
    const env = parseEnv("E6='a\\nb'");
    expect(env.get("E6")).toBe("a\\nb");
  });

  it("strips backticks but interprets nothing inside them (E9)", () => {
    const env = parseEnv("E9=`tick\\nhere`");
    expect(env.get("E9")).toBe("tick\\nhere");
  });

  it("discards content after closing double quote (E7)", () => {
    expect(parseEnv('E7="bar"baz').get("E7")).toBe("bar");
  });

  it("treats unclosed double quote as part of unquoted value (E8)", () => {
    expect(parseEnv('E8="unterminated').get("E8")).toBe('"unterminated');
  });
});

import { diffEnv, diffFiles, isEmptyDiff, formatFreezeDiff } from "../../src/deploy/configFreeze";

describe("diffEnv", () => {
  it("classifies added, changed and removed by name", () => {
    const diff = diffEnv("KEPT=same\nMOVED=before\nGONE=x", "KEPT=same\nMOVED=after\nFRESH=y");
    expect(diff).toEqual({ added: ["FRESH"], changed: ["MOVED"], removed: ["GONE"] });
  });

  it("treats an absent previous snapshot as everything added", () => {
    expect(diffEnv(undefined, "A=1\nB=2")).toEqual({ added: ["A", "B"], changed: [], removed: [] });
  });

  it("sorts each list so deploy output is stable", () => {
    expect(diffEnv("", "Z=1\nA=1\nM=1").added).toEqual(["A", "M", "Z"]);
  });

  it("sees no change when only formatting differs", () => {
    // Same value to Node, so the scheduler reads the same thing — reporting it would train the
    // operator to skim the diff.
    expect(isEmptyDiff(diffEnv(`A=hello`, `export A = "hello"`))).toBe(true);
  });
});

describe("diffFiles", () => {
  it("classifies steering files by content hash", () => {
    const before = new Map([["glossary.json", "h1"], ["dropped.md", "h2"]]);
    const after = new Map([["glossary.json", "h9"], ["added.md", "h3"]]);
    expect(diffFiles(before, after)).toEqual({
      added: ["added.md"], changed: ["glossary.json"], removed: ["dropped.md"],
    });
  });
});

describe("formatFreezeDiff", () => {
  // The load-bearing test of this file. A diff printed at deploy time is the one place where both
  // the old and the new value of every credential are in memory at once.
  it("never puts a value in its output", () => {
    const secret = "sk-live-51H8ZqABCDEFGHIJKLMNOP";
    const other = "postgres://user:hunter2@db.example.com:5432/herald";
    const out = formatFreezeDiff(
      "env",
      diffEnv(`TYPEFULLY_API_KEY=${secret}\nDATABASE_URL=old`, `TYPEFULLY_API_KEY=rotated\nDATABASE_URL=${other}`),
    );
    expect(out).not.toContain(secret);
    expect(out).not.toContain(other);
    expect(out).not.toContain("hunter2");
    expect(out).toContain("TYPEFULLY_API_KEY");
    expect(out).toContain("DATABASE_URL");
  });

  it("marks each class with its own sigil", () => {
    const out = formatFreezeDiff("env", { added: ["NEW"], changed: ["MOVED"], removed: ["OLD"] });
    expect(out).toContain("+ NEW");
    expect(out).toContain("~ MOVED");
    expect(out).toContain("- OLD");
  });

  it("says so plainly when nothing moved", () => {
    expect(formatFreezeDiff("env", { added: [], changed: [], removed: [] })).toBe("  env: unchanged");
  });
});
