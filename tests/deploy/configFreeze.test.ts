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
});
