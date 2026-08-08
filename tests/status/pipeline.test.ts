import { describe, it, expect } from "vitest";
import { pipelineStages, formatStatus, funnelCounts } from "../../src/status/pipeline";
import type { CollectedScope, TranslateFloorStatus } from "../../src/status/translateFloor";

/** What a machine with no scheduler installed reports — used wherever a test is about a stage other
 *  than Collected, so the floor is present (it has to be) without being the subject. */
const NO_SCHEDULER: TranslateFloorStatus = { kind: "not-installed" };
const unscoped = (total: number): CollectedScope => ({ floor: NO_SCHEDULER, total });
/** A unit carrying a floor, with `inScope` of the `total` collected items at or after it. */
const scoped = (total: number, inScope: number): CollectedScope => ({
  floor: { kind: "configured", floor: "2026-07-27T14:35:25.000Z" },
  total,
  inScope,
});

describe("pipelineStages", () => {
  it("builds the five stages with totals and approved sub-counts", () => {
    const stages = pipelineStages(
      {
        collected: 42,
        translations: [{ status: "translated" }, { status: "approved" }, { status: "approved" }],
        variants: [
          { itemId: "x:1", status: "converted" },
          { itemId: "x:2", status: "approved" },
        ],
        renderings: [
          { itemId: "x:1", status: "rendered" },
          { itemId: "x:1", status: "rendered" },
          { itemId: "x:2", status: "approved" },
        ],
        published: Array.from({ length: 5 }, (_, i) => ({ itemId: `x:${i}` })),
      },
      scoped(42, 12),
    );
    expect(stages.map((s) => [s.label, s.total, s.note])).toEqual([
      ["Collected (X + Lark)", 42, "in scope 12 · below floor 30"],
      ["Translated", 3, "pending 1 · approved 2 · posted 0"],
      ["Converted (variants)", 2, "2 items · approved 1"],
      ["Rendered (channels)", 3, "2 items · approved 1"],
      ["Published (drive)", 5, "5 items"],
    ]);
  });

  it("never leaves the collected total bare, whatever the floor turned out to be", () => {
    // The misreading this qualification exists for: 108 collected was reported to a human as a
    // backlog, when the floor put 84 of them permanently out of the scheduler's reach. A total with
    // no note is the shape that invited it, so no floor state may produce one.
    const input = { collected: 108, translations: [], variants: [], renderings: [], published: [] };
    const floors: TranslateFloorStatus[] = [
      { kind: "configured", floor: "2026-07-27T14:35:25.000Z" },
      { kind: "none" },
      { kind: "not-installed" },
      { kind: "unreadable", detail: "systemctl: not found" },
      { kind: "invalid", detail: "HERALD_TRANSLATE_SINCE is not a date this can parse: \"soon\"" },
    ];
    for (const floor of floors) {
      const scope: CollectedScope = { floor, total: 108, inScope: floor.kind === "configured" ? 24 : undefined };
      const collected = pipelineStages(input, scope).find((s) => s.label === "Collected (X + Lark)");
      expect(collected?.note).toBeTruthy();
    }
  });

  it("carries the whole intake funnel on the Collected line, no second line to go looking at", () => {
    // Production on 2026-08-08. "is 134 even right?" came back the day the scope note landed, and
    // answering it took a database query — 223 threads collected, 92 of them reply-rooted and
    // dropped by `isCommenterReply` before becoming items, plus 3 Lark items. All of it left to
    // right on the stage line, arithmetic that ends at the total printed beside it.
    const stages = pipelineStages(
      { collected: 134, translations: [], variants: [], renderings: [], published: [] },
      {
        floor: { kind: "configured", floor: "2026-07-27T14:35:25.000Z" },
        total: 134,
        inScope: 20,
        intake: { threads: 223, repliesDropped: 92 },
      },
    );
    const collected = stages.find((s) => s.label === "Collected (X + Lark)");
    expect(collected?.total).toBe(134);
    expect(collected?.note).toBe("223 X threads - 92 replies dropped + 3 Lark · in scope 20 · below floor 114");
  });

  it("splits the translated note three ways, so a terminal `posted` is not read as a review queue", () => {
    const stages = pipelineStages(
      {
        collected: 0,
        translations: [
          { status: "translated" },
          { status: "translated" },
          ...Array.from({ length: 21 }, () => ({ status: "posted" })),
        ],
        variants: [],
        renderings: [],
        published: [],
      },
      unscoped(0),
    );
    const translated = stages.find((s) => s.label === "Translated");
    expect(translated?.total).toBe(23);
    expect(translated?.note).toBe("pending 2 · approved 0 · posted 21");
  });

  it("names the item count of every stage that fans out, because rows there are not comparable", () => {
    // Three items, each converted to several types and rendered to several channels. Read as bare
    // totals these stages appear to *gain* work between them (10 → 13); what actually happened is
    // three items fanning out twice.
    const stages = pipelineStages(
      {
        collected: 0,
        translations: [],
        variants: [
          { itemId: "x:1", status: "approved" },
          { itemId: "x:1", status: "converted" },
          { itemId: "x:2", status: "approved" },
        ],
        renderings: [
          { itemId: "x:1", status: "approved" },
          { itemId: "x:1", status: "approved" },
          { itemId: "x:1", status: "rendered" },
          { itemId: "x:2", status: "rendered" },
        ],
        published: [{ itemId: "x:1" }, { itemId: "x:1" }, { itemId: "x:9" }],
      },
      unscoped(0),
    );
    const note = (label: string) => stages.find((s) => s.label === label)?.note;
    expect(note("Converted (variants)")).toBe("2 items · approved 2");
    expect(note("Rendered (channels)")).toBe("2 items · approved 2");
    expect(note("Published (drive)")).toBe("2 items");
  });

  it("is all-zero on an empty pipeline", () => {
    const stages = pipelineStages(
      { collected: 0, translations: [], variants: [], renderings: [], published: [] },
      unscoped(0),
    );
    expect(stages.every((s) => s.total === 0)).toBe(true);
  });
});

describe("funnelCounts", () => {
  it("gives every stage both counts, so the dashboard cannot drift from `pnpm status`", () => {
    // The same input the CLI renders. Both readers derive from this one function precisely because
    // the previous split let the CLI learn about `posted` while the dashboard header did not.
    const counts = funnelCounts({
      collected: 134,
      translations: [{ status: "translated" }, { status: "posted" }],
      variants: [
        { itemId: "x:1", status: "approved" },
        { itemId: "x:1", status: "converted" },
        { itemId: "x:2", status: "approved" },
      ],
      renderings: [
        { itemId: "x:1", status: "approved" },
        { itemId: "x:1", status: "rendered" },
      ],
      published: [{ itemId: "x:1" }, { itemId: "x:1" }, { itemId: "x:9" }],
    });
    expect(counts).toEqual({
      // One row per item at these two stages — the stores key on itemId alone.
      collected: { items: 134, rows: 134 },
      translated: { items: 2, rows: 2 },
      // Past here a row is a (type) or (type, channel) or (status, target) fan-out of an item.
      converted: { items: 2, rows: 3 },
      rendered: { items: 1, rows: 2 },
      published: { items: 2, rows: 3 },
    });
  });
});

describe("formatStatus", () => {
  it("renders a header, each stage label + count, and the approved notes", () => {
    const out = formatStatus(
      pipelineStages(
        {
          collected: 7,
          translations: [{ status: "approved" }],
          variants: [],
          renderings: [],
          published: [{ itemId: "x:1" }],
        },
        unscoped(7),
      ),
      NO_SCHEDULER,
    );
    expect(out).toContain("Pipeline status");
    expect(out).toContain("Collected (X + Lark)");
    expect(out).toContain("7");
    expect(out).toContain("Translated");
    expect(out).toContain("(pending 0 · approved 1 · posted 0)");
    expect(out).toContain("Published (drive)");
  });

  it("prints the translation floor with the table, not somewhere a reader has to go looking", () => {
    // Invisible configuration is what made the misreading possible: the floor's only real home is a
    // systemd unit, so the number was unavailable everywhere anyone actually looks.
    const out = formatStatus(
      pipelineStages(
        { collected: 108, translations: [], variants: [], renderings: [], published: [] },
        { floor: { kind: "configured", floor: "2026-07-27T14:35:25.000Z" }, total: 108, inScope: 24 },
      ),
      { kind: "configured", floor: "2026-07-27T14:35:25.000Z" },
    );
    expect(out).toContain("translate floor");
    expect(out).toContain("2026-07-27T14:35:25.000Z");
    // Above the pointer block, so the two lines that close the table stay the last thing printed.
    expect(out.indexOf("translate floor")).toBeLessThan(out.indexOf("pnpm lineage --activity"));
  });

  it("points at `pnpm lineage --activity`, so a count is not read as a history", () => {
    const out = formatStatus(
      pipelineStages(
        { collected: 0, translations: [], variants: [], renderings: [], published: [] },
        unscoped(0),
      ),
      NO_SCHEDULER,
    );
    expect(out).toContain("pnpm lineage --activity");
    // The pointer has to say *why*, not just name a command: "approved 0" was misread precisely
    // because nothing said the number stops counting an item once it is posted.
    expect(out).toContain("current states, not a history");
  });

  it("adds no line that `WatchTick`'s TRANSLATED_LINE could match ahead of the real stage line", () => {
    // Copied from `src/app/WatchTick.ts` deliberately — this asserts the *parser's* view of this
    // formatter's output, and importing the private constant would widen that module's surface for
    // a test. `tests/app/watchTick.test.ts` runs the real parser over this same output; this one
    // pins the property that makes it safe, which is that exactly one line can ever match.
    const TRANSLATED_LINE = /^\s*Translated\s+(\d+)/;
    const input = {
      collected: 128,
      translations: Array.from({ length: 41 }, () => ({ status: "posted" })),
      variants: [],
      renderings: [],
      published: [],
    };
    // Every floor state, because each one prints different lines under the table.
    const floors: TranslateFloorStatus[] = [
      { kind: "configured", floor: "2026-07-27T14:35:25.000Z", shellFloor: "2026-01-01T00:00:00.000Z" },
      { kind: "none" },
      { kind: "not-installed" },
      { kind: "unreadable", detail: "systemctl: not found" },
      { kind: "invalid", detail: 'HERALD_TRANSLATE_SINCE is not a date this can parse: "soon"' },
    ];
    for (const floor of floors) {
      // With the intake funnel too: it lengthens the Collected line rather than adding one, and
      // this suite is what proves no added text can be found ahead of the real stage line.
      const scope = { floor, total: 128, inScope: 12, intake: { threads: 220, repliesDropped: 95 } };
      const out = formatStatus(pipelineStages(input, scope), floor);
      const matches = out.split("\n").filter((l) => TRANSLATED_LINE.test(l));
      expect(matches).toHaveLength(1);
      expect(matches[0]).toMatch(/^\s*Translated\s+41/);
    }
  });

  it("keeps the funnel on the Collected line itself, adding no output line to the table", () => {
    // The presentation that was chosen: left to right on the stage line. A second line would be one
    // more thing for `WatchTick`/`ConvertTick` to parse past, and one more place a reader can miss.
    const scope: CollectedScope = {
      floor: NO_SCHEDULER,
      total: 134,
      intake: { threads: 223, repliesDropped: 92 },
    };
    const out = formatStatus(
      pipelineStages({ collected: 134, translations: [], variants: [], renderings: [], published: [] }, scope),
      NO_SCHEDULER,
    );
    const funnelLines = out.split("\n").filter((l) => l.includes("X threads"));
    expect(funnelLines).toHaveLength(1);
    expect(funnelLines[0]).toContain("Collected (X + Lark)");
    expect(funnelLines[0]).toContain("134");
    expect(funnelLines[0]).toContain("223 X threads - 92 replies dropped + 3 Lark");
  });
});
