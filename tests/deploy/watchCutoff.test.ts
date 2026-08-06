// tests/deploy/watchCutoff.test.ts
//
// The watch scheduler has two floors that mean different things — how far back `collect` reaches
// (the file-backed watermark seeded into %h/.herald/output/x/state.json) and how far back
// `translate:prepare` reaches (HERALD_TRANSLATE_SINCE on herald-watch.service). Neither is derived
// from the other: one lives in a file the runbook tells a human to write, the other in a unit
// file. If they drift apart, the gap between them becomes content that is collected and then never
// translated — silently, with no failing unit and nothing in a journal to read.
//
// The runbook says in prose that they must match. That sentence is what this file turns into a
// check, because prose about two values in two files is exactly the kind of documentation that
// rots the first time someone updates one of them.
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { parseTranslateSince } from "../../src/cli/translateSince";

const repoRoot = resolve(__dirname, "../..");
const unit = readFileSync(resolve(repoRoot, "deploy/herald-watch.service"), "utf8");
const runbook = readFileSync(resolve(repoRoot, "docs/ko/team-runbook.md"), "utf8");

/** The `Environment=HERALD_TRANSLATE_SINCE=...` value, ignoring the comment block above it. */
function unitCutoff(): string | undefined {
  return /^Environment=HERALD_TRANSLATE_SINCE=(.+)$/m.exec(unit)?.[1]?.trim();
}

/** The watermark the runbook's install step tells the operator to seed state.json with. */
function runbookWatermark(): string | undefined {
  return /"Mantle_Official":\s*"([^"]+)"/.exec(runbook)?.[1];
}

describe("watch scheduler cutoffs", () => {
  it("sets a translation cutoff on the unit at all", () => {
    // Without it the tick drains the whole untranslated backlog oldest-first, which is what this
    // whole configuration exists to prevent.
    expect(unitCutoff()).toBeDefined();
  });

  it("uses a cutoff the CLI will actually accept at startup", () => {
    // `pnpm watch` refuses to run on an unparseable value. A unit file that ships one turns every
    // scheduled tick into a failure — caught here rather than at 00:17 on install night.
    expect(() => parseTranslateSince(unitCutoff())).not.toThrow();
  });

  it("seeds the runbook's collect watermark with the same instant as the unit's cutoff", () => {
    const seeded = runbookWatermark();
    expect(seeded).toBeDefined();
    // Compared as instants, not as strings: "2026-07-27T14:35:24Z" and "2026-07-27T14:35:24.000Z"
    // are the same moment, and failing over the milliseconds would be noise.
    expect(parseTranslateSince(seeded)).toBe(parseTranslateSince(unitCutoff()));
  });

  it("documents the cutoff variable in .env.example, where every other read variable is listed", () => {
    const example = readFileSync(resolve(repoRoot, ".env.example"), "utf8");
    expect(example).toMatch(/^HERALD_TRANSLATE_SINCE=/m);
  });
});
