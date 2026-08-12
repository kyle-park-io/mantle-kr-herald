// tests/cli/convertBatch.test.ts
//
// The sibling of tests/cli/watchBatch.test.ts. The parser is shared (`parsePositiveIntEnv`), so this
// file asserts only what is specific to this dial: the default, the variable name in the message,
// and the three places the value has to be discoverable from — the unit, .env.example, and the
// Korean runbook the person who actually tunes it reads.
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { parseConvertBatch, DEFAULT_CONVERT_BATCH } from "../../src/cli/convertBatch";

describe("parseConvertBatch", () => {
  it("defaults to one item per tick when the variable is unset", () => {
    // Items, not variants: one item fans out to up to seven types (ALL_TYPES), and all of them are
    // written by the same single `claude -p` call under a 10-minute cap. This default is therefore a
    // sevenfold multiplier away from that cap, which is why it is 1 where HERALD_WATCH_BATCH is 3.
    expect(DEFAULT_CONVERT_BATCH).toBe(1);
    expect(parseConvertBatch(undefined)).toBe(1);
  });

  it("treats an empty or whitespace-only value as unset", () => {
    // `HERALD_CONVERT_BATCH=` with nothing after it reaches Node as "", not undefined. `Number("")`
    // is 0, which would hand `--limit 0` to every tick: a scheduler that prepares nothing, forever,
    // while looking configured.
    expect(parseConvertBatch("")).toBe(1);
    expect(parseConvertBatch("   ")).toBe(1);
  });

  it("accepts a positive integer, trimmed", () => {
    expect(parseConvertBatch("4")).toBe(4);
    expect(parseConvertBatch(" 10 ")).toBe(10);
  });

  it("refuses anything that is not a positive whole number, naming the variable and the value", () => {
    // The message reaches Telegram through herald-notify-failure.sh's journal excerpt, so it has to
    // be actionable on its own: which variable, and what was in it.
    for (const raw of ["0", "-3", "2.5", "three", "0x10", "1e2", "+3"]) {
      expect(() => parseConvertBatch(raw), raw).toThrow(/HERALD_CONVERT_BATCH/);
    }
    expect(() => parseConvertBatch("zero")).toThrow(/"zero"/);
  });
});

describe("HERALD_CONVERT_BATCH on the systemd unit", () => {
  const unit = readFileSync(resolve(__dirname, "../../deploy/herald-convert.service"), "utf8");

  it("ships a value the parser accepts, or a commented placeholder that says where it goes", () => {
    // `pnpm convert:tick` refuses to run on an unparseable value, so a unit file shipping one turns
    // every scheduled tick into a failure — caught here rather than at 00:07 on install night.
    //
    // The absent branch is not a free pass: the dial only exists to be tuned without a deploy, and an
    // operator finds it by reading the unit beside the Environment= line that *is* set. A commented
    // placeholder is what makes it findable, so its removal fails this test too.
    //
    // Every line mentioning the variable has to land in one of the two legitimate shapes — the same
    // "refuses shapes it cannot read" discipline watchBatch.test.ts settled on after a live but
    // unparseable `Environment="HERALD_WATCH_BATCH=5"` fell through its placeholder branch.
    const candidates = unit.split("\n").filter((line) => line.includes("HERALD_CONVERT_BATCH") && line.includes("Environment="));
    expect(candidates.length).toBeGreaterThan(0); // the dial must be findable at all

    for (const line of candidates) {
      const set = /^Environment=HERALD_CONVERT_BATCH=(.*)$/.exec(line);
      if (set !== null) {
        expect(() => parseConvertBatch(set[1].trim())).not.toThrow();
        continue;
      }
      expect(line, line).toMatch(/^#\s*Environment=HERALD_CONVERT_BATCH=/);
    }
  });
});

describe("HERALD_CONVERT_BATCH documentation", () => {
  it("is named in the Korean operator runbook, not only in .env.example", () => {
    // .env.example, the CHANGELOG and the design docs are all developer-facing English. The person
    // who tunes throughput reads docs/ko/team-runbook.md — a dial nobody is told about is not
    // configuration.
    const runbook = readFileSync(resolve(__dirname, "../../docs/ko/team-runbook.md"), "utf8");
    expect(runbook).toContain("HERALD_CONVERT_BATCH");
  });

  it("is listed in .env.example, where every read variable is listed", () => {
    const example = readFileSync(resolve(__dirname, "../../.env.example"), "utf8");
    expect(example).toMatch(/^HERALD_CONVERT_BATCH=/m);
  });
});
