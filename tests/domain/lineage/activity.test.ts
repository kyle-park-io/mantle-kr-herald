import { describe, it, expect } from "vitest";
import {
  ACTIVITY_KINDS,
  classifyEvent,
  formatActivity,
  lineageActivity,
  parseActivitySince,
  seoulDate,
} from "../../../src/domain/lineage/activity";
import type { LineageEvent } from "../../../src/domain/lineage/models";

const ev = (over: Partial<LineageEvent> = {}): LineageEvent => ({
  itemId: "x:1", stage: "translated", status: "translated", at: "2026-08-07T01:00:00.000Z", ...over,
});

describe("seoulDate", () => {
  it("buckets a Korean working morning onto its own day, not the UTC day before it", () => {
    // 08:00 KST on 2026-08-07 is 23:00Z on 2026-08-06. A UTC rollup files the start of a Korean
    // working day under the previous date — the exact split this command exists to avoid.
    expect(seoulDate("2026-08-06T23:00:00.000Z")).toBe("2026-08-07");
  });

  it("keeps a Korean late evening and the small hours after it on different days", () => {
    // 22:00 KST 8/7 and 01:00 KST 8/8 are both 2026-08-07 in UTC — a UTC rollup *merges* them.
    expect(seoulDate("2026-08-07T13:00:00.000Z")).toBe("2026-08-07");
    expect(seoulDate("2026-08-07T16:00:00.000Z")).toBe("2026-08-08");
  });

  it("reads a timestamp carrying its own offset", () => {
    expect(seoulDate("2026-08-07T09:00:00+09:00")).toBe("2026-08-07");
  });

  it("returns undefined rather than throwing on a timestamp it cannot read", () => {
    expect(seoulDate("not a date")).toBeUndefined();
  });
});

describe("classifyEvent", () => {
  it("calls a bare `converted` machine-driven — `convert:save` is its only producer", () => {
    expect(classifyEvent({ stage: "converted", status: "converted" })).toEqual({
      kind: "converted", driver: "machine",
    });
  });

  it("calls both `approved` shapes human-driven", () => {
    expect(classifyEvent({ stage: "translated", status: "approved" })).toEqual({
      kind: "approved-1차", driver: "human",
    });
    expect(classifyEvent({ stage: "rendered", status: "approved" })).toEqual({
      kind: "approved-2차", driver: "human",
    });
  });

  it("calls every `forked` shape human-driven, and names a revert separately", () => {
    expect(classifyEvent({ stage: "forked", status: "rendered" })).toEqual({ kind: "forked", driver: "human" });
    expect(classifyEvent({ stage: "forked", status: "approved" })).toEqual({ kind: "forked", driver: "human" });
    expect(classifyEvent({ stage: "forked", status: "reverted" })).toEqual({ kind: "reverted", driver: "human" });
  });

  it("refuses to call an unapproved `translated`/`rendered` either way — both sides write it", () => {
    // `translate:save` (the scheduler's agent) and a 1차 text edit from the dashboard produce a
    // byte-identical row; so do `format:save` and a 2차 승인 취소.
    expect(classifyEvent({ stage: "translated", status: "translated" })).toEqual({
      kind: "translated", driver: "either",
    });
    expect(classifyEvent({ stage: "rendered", status: "rendered" })).toEqual({
      kind: "rendered", driver: "either",
    });
  });

  it("falls back to `either` for a shape no producer writes today", () => {
    // A future producer must not be silently credited to a machine or to a person.
    expect(classifyEvent({ stage: "translated" as never, status: "retired" })).toEqual({
      kind: "translated:retired", driver: "either",
    });
    expect(classifyEvent({ stage: "posted" as never })).toEqual({ kind: "posted", driver: "either" });
  });

  it("classifies every declared kind consistently with ACTIVITY_KINDS", () => {
    // The legend is built from ACTIVITY_KINDS; a kind classify can produce but the legend never
    // names would be invisible to the reader.
    const declared = new Set(ACTIVITY_KINDS.map((k) => k.key));
    for (const shape of [
      { stage: "translated", status: "translated" }, { stage: "translated", status: "approved" },
      { stage: "converted", status: "converted" }, { stage: "rendered", status: "rendered" },
      { stage: "rendered", status: "approved" }, { stage: "forked", status: "rendered" },
      { stage: "forked", status: "reverted" },
    ] as const) {
      const { kind, driver } = classifyEvent(shape);
      expect(declared).toContain(kind);
      expect(ACTIVITY_KINDS.find((k) => k.key === kind)?.driver).toBe(driver);
    }
  });
});

describe("lineageActivity", () => {
  it("rolls up one day per Seoul date, ascending, with per-kind counts", () => {
    const rollup = lineageActivity([
      ev({ at: "2026-08-06T23:00:00.000Z" }), // 08-07 08:00 KST
      ev({ at: "2026-08-07T01:00:00.000Z", stage: "converted", status: "converted" }),
      ev({ at: "2026-08-05T04:00:00.000Z" }),
    ]);
    expect(rollup.days.map((d) => d.date)).toEqual(["2026-08-05", "2026-08-07"]);
    expect(rollup.days[1]).toMatchObject({
      date: "2026-08-07",
      total: 2,
      byKind: { translated: 1, converted: 1 },
    });
  });

  it("counts every driver on every day, zeros included", () => {
    // A day with no human events must say `human 0`, not omit the key: "not shown" and "none
    // happened" reading the same is the whole failure this command was built to end.
    const rollup = lineageActivity([ev()]);
    expect(rollup.days[0].byDriver).toEqual({ machine: 0, either: 1, human: 0 });
    expect(rollup.totals.byDriver).toEqual({ machine: 0, either: 1, human: 0 });
  });

  it("totals across the whole window", () => {
    const rollup = lineageActivity([
      ev({ at: "2026-08-05T04:00:00.000Z" }),
      ev({ at: "2026-08-06T04:00:00.000Z", status: "approved" }),
      ev({ at: "2026-08-07T04:00:00.000Z", stage: "forked", status: "reverted" }),
    ]);
    expect(rollup.totals.total).toBe(3);
    expect(rollup.totals.byKind).toEqual({ translated: 1, "approved-1차": 1, reverted: 1 });
    expect(rollup.totals.byDriver).toEqual({ machine: 0, either: 1, human: 2 });
  });

  it("counts an unreadable timestamp instead of dropping or throwing on it", () => {
    const rollup = lineageActivity([ev(), ev({ at: "" })]);
    expect(rollup.undated).toBe(1);
    expect(rollup.totals.total).toBe(1);
  });

  it("is empty, not undefined, for no events at all", () => {
    const rollup = lineageActivity([]);
    expect(rollup.days).toEqual([]);
    expect(rollup.totals).toEqual({ total: 0, byKind: {}, byDriver: { machine: 0, either: 0, human: 0 } });
  });

  describe("since", () => {
    it("filters on the Seoul date, so a date-only floor keeps that day's Korean small hours", () => {
      // 2026-08-07T00:00:00Z is 09:00 KST — filtering on the *instant* would throw away everything
      // a Korean reviewer did that morning while claiming to cover 2026-08-07.
      const rollup = lineageActivity(
        [
          ev({ at: "2026-08-06T17:00:00.000Z" }), // 02:00 KST on 08-07 — inside the floor
          ev({ at: "2026-08-06T14:00:00.000Z" }), // 23:00 KST on 08-06 — outside it
        ],
        { since: "2026-08-07" },
      );
      expect(rollup.days.map((d) => d.date)).toEqual(["2026-08-07"]);
      expect(rollup.totals.total).toBe(1);
    });

    it("includes the floor day itself", () => {
      const rollup = lineageActivity([ev({ at: "2026-08-07T04:00:00.000Z" })], { since: "2026-08-07" });
      expect(rollup.totals.total).toBe(1);
      expect(rollup.since).toBe("2026-08-07");
    });

    it("omitted means everything", () => {
      const rollup = lineageActivity([ev({ at: "2020-01-01T00:00:00.000Z" })]);
      expect(rollup.totals.total).toBe(1);
      expect(rollup.since).toBeUndefined();
    });

    it("still reports an unreadable timestamp it could not place against the floor", () => {
      const rollup = lineageActivity([ev({ at: "nope" })], { since: "2026-08-07" });
      expect(rollup.undated).toBe(1);
    });
  });
});

describe("parseActivitySince", () => {
  it("normalises to the Seoul date, not to a UTC instant", () => {
    expect(parseActivitySince("2026-08-07")).toBe("2026-08-07");
    expect(parseActivitySince("2026-08-07T23:35:24+09:00")).toBe("2026-08-07");
    // 16:00Z is already the next Korean day, and the floor has to say so.
    expect(parseActivitySince("2026-08-07T16:00:00.000Z")).toBe("2026-08-08");
  });

  it("treats an empty or absent value as unset", () => {
    expect(parseActivitySince(undefined)).toBeUndefined();
    expect(parseActivitySince("")).toBeUndefined();
    expect(parseActivitySince("   ")).toBeUndefined();
  });

  it("refuses a value it cannot parse, naming the flag and a usable form", () => {
    expect(() => parseActivitySince("last tuesday")).toThrow(/--since/);
    expect(() => parseActivitySince("last tuesday")).toThrow(/2026-08-07/);
  });
});

describe("formatActivity", () => {
  const rollup = () =>
    lineageActivity([
      ev({ at: "2026-08-06T04:00:00.000Z" }),
      ev({ at: "2026-08-07T04:00:00.000Z" }),
      ev({ at: "2026-08-07T04:00:00.000Z", stage: "converted", status: "converted" }),
      ev({ at: "2026-08-07T04:00:00.000Z", status: "approved" }),
    ]);

  it("names the timezone in the header, because the dates are the whole point", () => {
    expect(formatActivity(rollup())).toContain("Lineage activity (Asia/Seoul)");
  });

  it("prints one row per day with its kind breakdown, and a total row", () => {
    const lines = formatActivity(rollup()).split("\n");
    expect(lines).toContain("  2026-08-06  1   translated 1");
    expect(lines).toContain("  2026-08-07  3   translated 1 · approved-1차 1 · converted 1");
    expect(lines).toContain("  total       4   translated 2 · approved-1차 1 · converted 1");
  });

  it("names every driver with its count and the kinds it covers", () => {
    const out = formatActivity(rollup());
    expect(out).toContain("machine  1   converted");
    expect(out).toContain("either   2   translated · rendered");
    expect(out).toContain("human    1   approved-1차 · approved-2차 · forked · reverted");
  });

  it("prints all three drivers even when one has no events, so zero cannot read as untracked", () => {
    // The bug this command answers: `approved = 0` was read as "1차 검수 has stalled" when the
    // number simply was not measuring what it was asked. A missing `human` line would do it again.
    const out = formatActivity(lineageActivity([ev({ stage: "converted", status: "converted" })]));
    expect(out).toContain("human    0");
    expect(out).toContain("either   0");
  });

  it("says the window is empty rather than printing a bare header", () => {
    const out = formatActivity(lineageActivity([], { since: "2026-08-09" }));
    expect(out).toContain("since 2026-08-09");
    expect(out).toContain("no lineage events");
    // Still labelled: an empty window must not look like a command that tracks nothing.
    expect(out).toContain("human    0");
  });

  it("reports entries it could not date instead of quietly losing them from the totals", () => {
    const out = formatActivity(lineageActivity([ev(), ev({ at: "nope" })]));
    expect(out).toMatch(/1 entr\(y\/ies\).*unreadable/);
  });
});
