// tests/status/translateFloor.test.ts
//
// The floor `pnpm status` reports has to be the one the *scheduler* will run with, and every way of
// failing to know it has to be distinguishable from knowing it. This suite is the whole reason the
// systemd call sits behind a seam: none of the cases below — a unit that is not installed, a unit
// with no floor, a systemctl that cannot be run at all — is reachable on the machine running the
// tests, and all of them are reachable in production.
import { describe, it, expect } from "vitest";
import {
  translateFloorStatus,
  collectedScope,
  collectedScopeNote,
  formatTranslateFloor,
  WATCH_UNIT,
  type CollectedScope,
  type TranslateFloorStatus,
} from "../../src/status/translateFloor";

/** Verbatim shape of `systemctl --user show herald-watch.service --property=Environment --property=LoadState`
 *  on the machine the scheduler is armed on, with PATH shortened. Environment comes back *first*:
 *  systemd prints properties in its own order, not the order they were asked for. */
const ARMED = [
  "Environment=PATH=/usr/bin HERALD_OUTPUT_DIR=/home/kyle/.herald/output HERALD_TRANSLATE_SINCE=2026-07-27T14:35:25.000Z",
  "LoadState=loaded",
].join("\n");

/** Same command against a unit systemd has never heard of. Note `Environment=` is empty and the
 *  exit status is still 0 — LoadState is the only thing that tells the two apart. */
const NOT_INSTALLED = ["Environment=", "LoadState=not-found"].join("\n");

/** A loaded unit that sets other variables but no floor at all. */
const NO_FLOOR = ["Environment=PATH=/usr/bin HERALD_OUTPUT_DIR=/home/kyle/.herald/output", "LoadState=loaded"].join(
  "\n",
);

describe("translateFloorStatus", () => {
  it("reports the floor the loaded unit will actually run with", () => {
    const status = translateFloorStatus({ unitShow: ARMED, shellValue: undefined });
    expect(status).toEqual({ kind: "configured", floor: "2026-07-27T14:35:25.000Z" });
  });

  it("reads the properties by name, whatever order systemd printed them in", () => {
    const reversed = ARMED.split("\n").reverse().join("\n");
    expect(translateFloorStatus({ unitShow: reversed, shellValue: undefined }).floor).toBe("2026-07-27T14:35:25.000Z");
  });

  it("normalises through parseTranslateSince, so the floor shown is the string prepare compares", () => {
    // Not a second parser: `translate:prepare` filters `item.createdAt >= since` as strings, so a
    // date-only or offset form printed verbatim would not be the value the comparison uses.
    const dateOnly = ["Environment=HERALD_TRANSLATE_SINCE=2026-07-27", "LoadState=loaded"].join("\n");
    expect(translateFloorStatus({ unitShow: dateOnly, shellValue: undefined }).floor).toBe("2026-07-27T00:00:00.000Z");

    const offset = ["Environment=HERALD_TRANSLATE_SINCE=2026-07-27T23:35:24+09:00", "LoadState=loaded"].join("\n");
    expect(translateFloorStatus({ unitShow: offset, shellValue: undefined }).floor).toBe("2026-07-27T14:35:24.000Z");
  });

  it("unquotes a value systemd quoted, rather than reporting a floor with quotes in it", () => {
    const quoted = ['Environment="HERALD_TRANSLATE_SINCE=2026-07-27T14:35:25.000Z"', "LoadState=loaded"].join("\n");
    expect(translateFloorStatus({ unitShow: quoted, shellValue: undefined }).floor).toBe("2026-07-27T14:35:25.000Z");
  });

  it("calls a not-found unit not-installed, which an empty Environment alone cannot distinguish", () => {
    const status = translateFloorStatus({ unitShow: NOT_INSTALLED, shellValue: undefined });
    expect(status.kind).toBe("not-installed");
    expect(status.floor).toBeUndefined();
  });

  it("calls a loaded unit with no floor `none`, not `not-installed` — they mean opposite things", () => {
    // "no scheduler here" is a dev machine. "a scheduler with no floor" is the whole backlog being
    // drained oldest-first, which is the condition HERALD_TRANSLATE_SINCE exists to prevent.
    expect(translateFloorStatus({ unitShow: NO_FLOOR, shellValue: undefined }).kind).toBe("none");
  });

  it("treats an empty `HERALD_TRANSLATE_SINCE=` on the unit as no floor, matching parseTranslateSince", () => {
    const blank = ["Environment=HERALD_TRANSLATE_SINCE= HERALD_WATCH_BATCH=3", "LoadState=loaded"].join("\n");
    expect(translateFloorStatus({ unitShow: blank, shellValue: undefined }).kind).toBe("none");
  });

  it("cannot determine anything when the systemctl call did not produce output", () => {
    const status = translateFloorStatus({ unitShow: undefined, shellValue: undefined });
    expect(status.kind).toBe("unreadable");
    expect(status.floor).toBeUndefined();
  });

  it("cannot determine anything from output with no LoadState in it", () => {
    // A `systemctl` that answered something else entirely, or a future version that renamed the
    // property. Guessing "loaded" from a bare `Environment=` line would report `none` — the most
    // alarming state there is — for a machine we simply failed to ask.
    expect(translateFloorStatus({ unitShow: "Environment=PATH=/usr/bin", shellValue: undefined }).kind).toBe(
      "unreadable",
    );
    expect(translateFloorStatus({ unitShow: "", shellValue: undefined }).kind).toBe("unreadable");
    expect(translateFloorStatus({ unitShow: "totally unexpected", shellValue: undefined }).kind).toBe("unreadable");
  });

  it("names a LoadState that is neither loaded nor not-found, rather than reading its Environment", () => {
    const masked = ["Environment=HERALD_TRANSLATE_SINCE=2026-07-27T14:35:25.000Z", "LoadState=masked"].join("\n");
    const status = translateFloorStatus({ unitShow: masked, shellValue: undefined });
    expect(status.kind).toBe("unreadable");
    expect(status.detail).toContain("masked");
    // A masked unit's Environment= still parses. Reporting it as the floor would state a cutoff for
    // a unit systemd will never start.
    expect(status.floor).toBeUndefined();
  });

  it("reports an unusable unit value instead of throwing out of a read-only diagnostic", () => {
    const typo = ["Environment=HERALD_TRANSLATE_SINCE=last-tuesday", "LoadState=loaded"].join("\n");
    const status = translateFloorStatus({ unitShow: typo, shellValue: undefined });
    expect(status.kind).toBe("invalid");
    // The parser's own message, not a second wording of it — it already names the offending value.
    expect(status.detail).toContain("last-tuesday");
    expect(status.floor).toBeUndefined();
  });

  it("never adopts the invoking shell's value as the floor", () => {
    // This is the bug being fixed. `process.env.HERALD_TRANSLATE_SINCE` is empty in a hand-run and
    // set to something arbitrary in a shell where someone exported it; neither is the scheduler's.
    const status = translateFloorStatus({ unitShow: NOT_INSTALLED, shellValue: "2026-01-01T00:00:00.000Z" });
    expect(status.kind).toBe("not-installed");
    expect(status.floor).toBeUndefined();
  });

  it("shows a shell value that disagrees with the unit's, rather than resolving it silently", () => {
    const status = translateFloorStatus({ unitShow: ARMED, shellValue: "2026-01-01" });
    expect(status.floor).toBe("2026-07-27T14:35:25.000Z");
    expect(status.shellFloor).toBe("2026-01-01T00:00:00.000Z");
  });

  it("says nothing about a shell value that agrees with the unit, compared as instants", () => {
    // "2026-07-27T14:35:25Z" and "…25.000Z" are the same moment; flagging that as a disagreement
    // would train the reader to ignore the line that matters.
    const status = translateFloorStatus({ unitShow: ARMED, shellValue: "2026-07-27T14:35:25Z" });
    expect(status.shellFloor).toBeUndefined();
  });

  it("shows a shell value even when the unit has no floor or cannot be read", () => {
    // The reader's own export is exactly what they are most likely to mistake for production.
    expect(translateFloorStatus({ unitShow: NO_FLOOR, shellValue: "2026-01-01" }).shellFloor).toBe(
      "2026-01-01T00:00:00.000Z",
    );
    expect(translateFloorStatus({ unitShow: undefined, shellValue: "2026-01-01" }).shellFloor).toBe(
      "2026-01-01T00:00:00.000Z",
    );
  });

  it("shows an unparseable shell value verbatim instead of throwing", () => {
    const status = translateFloorStatus({ unitShow: ARMED, shellValue: "last tuesday" });
    expect(status.kind).toBe("configured");
    expect(status.shellFloor).toBe("last tuesday");
  });

  it("ignores an empty or whitespace-only shell value, which is what a hand-run actually has", () => {
    expect(translateFloorStatus({ unitShow: ARMED, shellValue: "" }).shellFloor).toBeUndefined();
    expect(translateFloorStatus({ unitShow: ARMED, shellValue: "   " }).shellFloor).toBeUndefined();
  });
});

describe("collectedScope", () => {
  const items = [
    { createdAt: "2026-06-01T00:00:00.000Z" },
    { createdAt: "2026-07-27T14:35:24.000Z" }, // one millisecond under the floor
    { createdAt: "2026-07-27T14:35:25.000Z" }, // exactly the floor — `>=`, so in scope
    { createdAt: "2026-08-08T09:00:00.000Z" },
  ];

  it("counts the items at or after the floor, the same comparison applySelector makes", () => {
    // `PrepareTranslations.applySelector` filters `i.createdAt >= since` as strings. Anything else
    // here would report a scope the scheduler does not actually have.
    const scope = collectedScope(items, translateFloorStatus({ unitShow: ARMED, shellValue: undefined }));
    expect(scope.inScope).toBe(2);
    expect(scope.total).toBe(4);
  });

  it("counts an item with no createdAt as below the floor, because that is how it is selected", () => {
    // `flattenXThreads` writes `createdAt: ""` for a thread with no tweets. "" >= any floor is false.
    const scope = collectedScope(
      [{ createdAt: "" }],
      translateFloorStatus({ unitShow: ARMED, shellValue: undefined }),
    );
    expect(scope.inScope).toBe(0);
  });

  it("carries the intake through untouched, beside the total it has to reconcile with", () => {
    const scope = collectedScope(items, translateFloorStatus({ unitShow: ARMED, shellValue: undefined }), {
      threads: 223,
      repliesDropped: 92,
    });
    expect(scope.intake).toEqual({ threads: 223, repliesDropped: 92 });
  });

  it("has no intake when the caller has no thread rows to count", () => {
    // The dashboard and every fake build a scope without ever reading `x_threads`; the note has to
    // keep working for them, which is why the intake is optional at the type level.
    expect(collectedScope(items, translateFloorStatus({ unitShow: ARMED, shellValue: undefined })).intake)
      .toBeUndefined();
  });

  it("has no in-scope count when there is no floor to measure against", () => {
    for (const show of [NO_FLOOR, NOT_INSTALLED, undefined]) {
      expect(collectedScope(items, translateFloorStatus({ unitShow: show, shellValue: undefined })).inScope).toBeUndefined();
    }
  });
});

describe("collectedScopeNote", () => {
  const items = [
    { createdAt: "2026-06-01T00:00:00.000Z" },
    { createdAt: "2026-06-02T00:00:00.000Z" },
    { createdAt: "2026-08-08T09:00:00.000Z" },
  ];
  const note = (show: string | undefined) =>
    collectedScopeNote(collectedScope(items, translateFloorStatus({ unitShow: show, shellValue: undefined })));

  it("splits the collected total into what the scheduler can select and what it never will", () => {
    // The incident this whole change exists for: a bare total was read as a backlog, and the two
    // thirds of it that sit below the floor were reported to a human as work waiting to be done.
    expect(note(ARMED)).toBe("in scope 1 · below floor 2");
  });

  it("says the whole total is in scope when the unit sets no floor", () => {
    expect(note(NO_FLOOR)).toContain("in scope 3");
    expect(note(NO_FLOOR)).toContain("no floor");
  });

  it("says the scope is unknown rather than implying the total is the backlog", () => {
    // Never a blank note: a bare total is exactly what invited the misreading.
    for (const show of [NOT_INSTALLED, undefined]) {
      expect(note(show)).toContain("scope unknown");
    }
  });

  it("is never empty, for any floor state", () => {
    const invalid = ["Environment=HERALD_TRANSLATE_SINCE=last-tuesday", "LoadState=loaded"].join("\n");
    for (const show of [ARMED, NO_FLOOR, NOT_INSTALLED, undefined, invalid, "garbage"]) {
      expect(note(show).length).toBeGreaterThan(0);
    }
  });
});

describe("collectedScopeNote — the intake funnel", () => {
  const CONFIGURED: TranslateFloorStatus = { kind: "configured", floor: "2026-07-27T14:35:25.000Z" };
  /** Production on 2026-08-08: 223 collected threads, 92 of them reply-rooted, 3 Lark items, 20 of
   *  the resulting 134 at or after the floor. Every number below is that measurement. */
  const PRODUCTION: CollectedScope = {
    floor: CONFIGURED,
    total: 134,
    inScope: 20,
    intake: { threads: 223, repliesDropped: 92 },
  };

  /**
   * Adds up the arithmetic the funnel actually printed. The test asserts the *line*, not a
   * re-derivation of what the line should have said — a reader adds up what is on screen, so that
   * is what has to reach the total beside it.
   */
  const funnelSum = (note: string): number =>
    [...note.matchAll(/([-+]?)\s*(\d+)\s+(?:X threads|replies dropped|Lark)/g)].reduce(
      (n, [, sign, value]) => n + (sign === "-" ? -Number(value) : Number(value)),
      0,
    );

  it("states the whole funnel left to right, in front of the scope it already reported", () => {
    expect(collectedScopeNote(PRODUCTION)).toBe(
      "223 X threads - 92 replies dropped + 3 Lark · in scope 20 · below floor 114",
    );
  });

  it("names the Lark contribution, so a reader who subtracts lands on the total and not 3 short", () => {
    // The trap this line has to survive: 223 - 92 = 131, but the headline beside it says 134,
    // because the 3 Lark items are in the total and are not threads. Somebody coming up 3 short
    // concludes the pipeline lost items — the same shape of mistake as reading the bare total as a
    // backlog, which is what put the funnel on this line in the first place.
    expect(funnelSum(collectedScopeNote(PRODUCTION))).toBe(PRODUCTION.total);
  });

  it("omits a zero drop term rather than printing a filter that did nothing", () => {
    // `- 0 replies dropped` sends a reader looking for something that did not happen, and dropping
    // the term changes no arithmetic: the line still reaches the total.
    const note = collectedScopeNote({
      ...PRODUCTION,
      total: 226,
      intake: { threads: 223, repliesDropped: 0 },
    });
    expect(note).toBe("223 X threads + 3 Lark · in scope 20 · below floor 206");
    expect(funnelSum(note)).toBe(226);
  });

  it("omits the Lark term when the total is all X, for the same reason", () => {
    const note = collectedScopeNote({ ...PRODUCTION, total: 131, inScope: 20 });
    expect(note).toBe("223 X threads - 92 replies dropped · in scope 20 · below floor 111");
    expect(funnelSum(note)).toBe(131);
  });

  it("prints no funnel when nothing came from X, and still reports the scope", () => {
    // A deployment with no X threads at all: `0 X threads + 3 Lark` is not a funnel, it is noise in
    // front of the number that matters.
    const note = collectedScopeNote({
      floor: CONFIGURED,
      total: 3,
      inScope: 1,
      intake: { threads: 0, repliesDropped: 0 },
    });
    expect(note).toBe("in scope 1 · below floor 2");
  });

  it("prints no funnel when the two reads disagree, rather than one that does not add up", () => {
    // The threads and the items are two reads of the same database, so a collect landing between
    // them can leave more X items implied by the funnel than there are collected items at all. A
    // funnel that visibly fails to reach its own total is worse than no funnel: it reports a defect
    // that does not exist.
    const note = collectedScopeNote({ ...PRODUCTION, total: 100 });
    expect(note).toBe("in scope 20 · below floor 80");
  });

  it("keeps every floor state's wording exactly as it was, funnel or no funnel", () => {
    // Invariant from the previous change: no floor state may produce a bare total. The funnel is
    // added in front of these, never in place of them.
    const scopes: [CollectedScope, string][] = [
      [{ floor: CONFIGURED, total: 134, inScope: 20 }, "in scope 20 · below floor 114"],
      [{ floor: { kind: "none" }, total: 134 }, "in scope 134 · no floor set"],
      [{ floor: { kind: "not-installed" }, total: 134 }, "scope unknown · no floor could be read"],
    ];
    for (const [scope, expected] of scopes) {
      expect(collectedScopeNote(scope)).toBe(expected);
      expect(collectedScopeNote({ ...scope, intake: { threads: 223, repliesDropped: 92 } })).toBe(
        `223 X threads - 92 replies dropped + 3 Lark · ${expected}`,
      );
    }
  });

  it("is never empty, for any floor state and any intake", () => {
    const intakes = [undefined, { threads: 0, repliesDropped: 0 }, { threads: 223, repliesDropped: 92 }];
    const floors: TranslateFloorStatus[] = [
      CONFIGURED,
      { kind: "none" },
      { kind: "not-installed" },
      { kind: "unreadable", detail: "systemctl: not found" },
      { kind: "invalid", detail: 'HERALD_TRANSLATE_SINCE is not a date this can parse: "soon"' },
    ];
    for (const floor of floors) {
      for (const intake of intakes) {
        const inScope = floor.kind === "configured" ? 20 : undefined;
        expect(collectedScopeNote({ floor, total: 134, inScope, intake }).length).toBeGreaterThan(0);
      }
    }
  });
});

describe("formatTranslateFloor", () => {
  const lines = (show: string | undefined, shellValue?: string) =>
    formatTranslateFloor(translateFloorStatus({ unitShow: show, shellValue })).join("\n");

  it("names the floor and where it came from, so the number can be checked", () => {
    const out = lines(ARMED);
    expect(out).toContain("2026-07-27T14:35:25.000Z");
    expect(out).toContain(WATCH_UNIT);
  });

  it("makes a missing floor look alarming, because it is", () => {
    const out = lines(NO_FLOOR);
    expect(out).toContain("⚠");
    // The condition, stated: this is not "no configuration", it is "the whole backlog, oldest first".
    expect(out).toContain("oldest first");
  });

  it("says the scheduler is not installed here, and claims nothing about production", () => {
    const out = lines(NOT_INSTALLED);
    expect(out).toContain(WATCH_UNIT);
    expect(out).toMatch(/not installed/);
    expect(out).not.toContain("⚠"); // a dev machine with no scheduler is not an alarm
  });

  it("says it could not ask, and names why, when systemctl produced nothing usable", () => {
    expect(lines(undefined)).toMatch(/unknown/);
    expect(lines("garbage")).toMatch(/unknown/);
  });

  it("flags a unit value the scheduler will refuse to start on", () => {
    const out = lines(["Environment=HERALD_TRANSLATE_SINCE=last-tuesday", "LoadState=loaded"].join("\n"));
    expect(out).toContain("⚠");
    expect(out).toContain("last-tuesday");
  });

  it("shows a disagreeing shell value on its own line, and says it is not what runs", () => {
    const out = lines(ARMED, "2026-01-01");
    expect(out).toContain("2026-07-27T14:35:25.000Z");
    expect(out).toContain("2026-01-01T00:00:00.000Z");
    expect(out).toContain("⚠");
    expect(out).toMatch(/shell/);
  });

  it("adds no line `WatchTick`'s TRANSLATED_LINE could match ahead of the real stage line", () => {
    // `pnpm status` is a stage inside every watch tick (`src/app/WatchTick.ts`), and its stdout is
    // parsed with `/^\s*Translated\s+(\d+)/m`. A line here that matched would fail every tick.
    const TRANSLATED_LINE = /^\s*Translated\s+(\d+)/;
    const CONVERTED_LINE = /^\s*Converted \(variants\)\s+(\d+)/;
    const invalid = ["Environment=HERALD_TRANSLATE_SINCE=last-tuesday", "LoadState=loaded"].join("\n");
    for (const show of [ARMED, NO_FLOOR, NOT_INSTALLED, undefined, invalid, "garbage"]) {
      for (const line of lines(show, "2026-01-01").split("\n")) {
        expect(TRANSLATED_LINE.test(line)).toBe(false);
        expect(CONVERTED_LINE.test(line)).toBe(false);
      }
    }
  });
});
