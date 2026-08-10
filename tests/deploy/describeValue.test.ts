// tests/deploy/describeValue.test.ts
//
// `describeValue` replaced `JSON.stringify` inside every judging function that describes an
// unvalidated HTTP body, so it has two jobs and this file checks both.
//
// The first is compatibility: those functions' details are read by operators and asserted by other
// tests, so for any value small enough to belong in a report line the output must be exactly what
// `JSON.stringify` produced before. That is asserted against `JSON.stringify` itself rather than
// against hand-written expected strings — a hardcoded list would drift from the thing it claims to
// match.
//
// The second is the reason it exists: `JSON.stringify` throws on inputs a deployment can actually
// send, and prints unbounded ones in full. See the module header for the measurements.
import { describe, it, expect } from "vitest";
import { describeValue, MAX_DESCRIBED_LENGTH, sanitizeWireText } from "../../src/deploy/describeValue";

/** `[[[[…]]]]` nested `depth` deep, built as text and parsed — the exact route a body takes. */
function deeplyNested(depth: number): unknown {
  let text = "[]";
  for (let i = 0; i < depth; i++) text = `[${text}]`;
  return JSON.parse(text);
}

describe("describeValue", () => {
  describe("is a drop-in for JSON.stringify on anything report-sized", () => {
    const cases: unknown[] = [
      undefined,
      null,
      true,
      false,
      0,
      -1.5,
      "",
      "cloud",
      "a string with \"quotes\" and \\ backslashes",
      [],
      [1, 2, 3],
      {},
      { sendsEnabled: false },
      { key: "google_auth", status: "dead", detail: "HTTP 401" },
      [{ nested: { a: [1, { b: 2 }] } }],
    ];
    it.each(cases.map((v, i) => [i, v] as const))("case %i renders exactly as JSON.stringify", (_i, value) => {
      // `${JSON.stringify(undefined)}` is the string "undefined" at the call sites this replaced, so
      // that is the output being matched — including for the values JSON has no representation for.
      expect(describeValue(value)).toBe(`${JSON.stringify(value)}`);
    });
  });

  describe("does not throw on values JSON.stringify throws on", () => {
    it("describes a deeply nested value instead of dying inside it", () => {
      const deep = deeplyNested(5000);
      // The premise, asserted rather than assumed: this really is a value JSON.stringify rejects,
      // so the test cannot quietly stop testing anything if a future runtime raises the limit.
      expect(() => JSON.stringify(deep)).toThrow(RangeError);

      const described = describeValue(deep);
      expect(described).toContain("an array of 1 entries");
      // The whole point. An operator's alert must not be about this process's call stack.
      expect(described).not.toContain("Maximum call stack");
      expect(described.length).toBeLessThanOrEqual(MAX_DESCRIBED_LENGTH + 64);
    });

    it("describes a deeply nested object by its top-level keys", () => {
      const deep = JSON.parse(`{"sendsEnabled": ${"[".repeat(5000)}${"]".repeat(5000)}, "other": 1}`) as unknown;
      expect(() => JSON.stringify(deep)).toThrow(RangeError);
      const described = describeValue(deep);
      expect(described).toContain("an object with 2 keys");
      expect(described).toContain("sendsEnabled");
      expect(described).not.toContain("Maximum call stack");
    });

    it("describes a circular structure", () => {
      const circular: Record<string, unknown> = { a: 1 };
      circular.self = circular;
      expect(() => JSON.stringify(circular)).toThrow(TypeError);
      expect(describeValue(circular)).toContain("an object with 2 keys");
    });

    it("describes a BigInt", () => {
      expect(() => JSON.stringify(1n)).toThrow(TypeError);
      expect(describeValue(1n)).toBe("1n");
    });

    it("describes a value whose own toJSON throws", () => {
      const hostile = {
        toJSON() {
          throw new Error("no");
        },
      };
      expect(describeValue(hostile)).toContain("an object with 1 keys (toJSON)");
    });

    it("survives an object that refuses to be inspected at all", () => {
      const proxy = new Proxy(
        {},
        {
          ownKeys() {
            throw new Error("refused");
          },
          get() {
            throw new Error("refused");
          },
        },
      );
      expect(describeValue(proxy)).toBe("(a value that could not be described)");
    });
  });

  describe("is bounded", () => {
    it("truncates a long value and says by how much", () => {
      const long = describeValue({ body: "x".repeat(20_000) });
      expect(long.length).toBeLessThan(300);
      expect(long).toContain("truncated from");
      // The prefix must still be the real value — a bound that discarded the evidence would make the
      // detail line useless for diagnosing what the deployment actually sent.
      expect(long.startsWith('{"body":"xxx')).toBe(true);
    });

    it("leaves a value at the limit untouched", () => {
      const exact = describeValue("y".repeat(MAX_DESCRIBED_LENGTH - 2));
      expect(exact).toHaveLength(MAX_DESCRIBED_LENGTH);
      expect(exact).not.toContain("truncated");
    });

    it("honours a caller-supplied limit", () => {
      expect(describeValue("z".repeat(100), 10)).toBe(`${'"'}${"z".repeat(9)}… (truncated from 102 characters)`);
    });
  });
});

describe("sanitizeWireText", () => {
  // The strings this exists for are the two `checkLiveness` interpolates straight into a report
  // line: a probe's `key` and its `detail`. Everything else in smokeChecks.ts goes through
  // describeValue, whose JSON.stringify escapes these as a side effect.
  it("escapes a newline, so one report line cannot become two", () => {
    expect(sanitizeWireText("google_auth\nSOMETHING")).toBe("google_auth\\x0aSOMETHING");
    expect(sanitizeWireText("google_auth\nSOMETHING")).not.toContain("\n");
  });

  it("escapes a carriage return, which would otherwise overwrite the line in a terminal", () => {
    expect(sanitizeWireText("a\rb")).toBe("a\\x0db");
  });

  it("escapes an ANSI escape, so a probe key cannot clear the reader's screen", () => {
    const clearScreen = String.fromCharCode(0x1b) + "[2J";
    expect(sanitizeWireText(`google_auth${clearScreen}`)).toBe("google_auth\\x1b[2J");
  });

  it("escapes the C1 introducer too, not only C0", () => {
    // A lone 0x9b is an alternative CSI on some terminals, so escaping only C0 would leave a
    // working escape sequence behind.
    expect(sanitizeWireText(String.fromCharCode(0x9b) + "2J")).toBe("\\x9b2J");
    expect(sanitizeWireText(String.fromCharCode(0x7f))).toBe("\\x7f");
  });

  it("leaves ordinary text — including the report's own glyphs and Korean — untouched", () => {
    for (const text of ["google_auth", "live: telegram", "HTTP 401 — invalid_grant", "✗ ⚠ ✓ · 발행", ""]) {
      expect(sanitizeWireText(text)).toBe(text);
    }
  });

  it("grows by exactly four characters per control character, so callers stay bounded", () => {
    expect(sanitizeWireText("\n\n\n")).toHaveLength(12);
  });

  it("cannot introduce the alert marker into a line of its own", () => {
    // The marker deploy/herald-notify-failure.sh selects on is anchored at the start of a line. A
    // wire string carrying a newline was the one way to manufacture such a line from a payload.
    const injected = sanitizeWireText("ok\nHERALD_ALERT: everything is fine");
    expect(injected.split("\n")).toHaveLength(1);
  });
});
