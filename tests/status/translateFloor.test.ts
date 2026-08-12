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
  collectedBreakdown,
  collectedScopeNote,
  formatTranslateFloor,
  WATCH_UNIT,
  type CollectedScope,
  type TranslateFloorStatus,
} from "../../src/status/translateFloor";
import { SWEPT_ACCOUNT } from "../../src/domain/sweptAccount";

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

  it("counts the items the floor leaves selectable, by the rule applySelector selects with", () => {
    // Through `meetsTranslateFloor`, the function `PrepareTranslations.applySelector` calls — not a
    // second expression here that resembles it. These items carry no author, so the date decides all
    // four of them; the author half of the rule has its own suite below.
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

  it("measures the scheduler's reported floor with the same rule, over the same items", () => {
    // The hosted dashboard's numbers come from here. A looser rule (parsing to Date, tolerating a
    // blank createdAt, or skipping the author question) would report a scope the scheduler does not
    // have — the same failure the systemd-side count is written to avoid, one source of truth over.
    const scope = collectedScope(items, translateFloorStatus({ unitShow: NOT_INSTALLED }), undefined, {
      floor: "2026-07-27T14:35:25.000Z",
      at: "2026-08-08T04:17:09.000Z",
    });
    expect(scope.reported).toEqual({ floor: "2026-07-27T14:35:25.000Z", at: "2026-08-08T04:17:09.000Z", inScope: 2 });
    // The systemd-side count stays absent: nothing on this machine read a floor, and the report is
    // not a substitute for having done so.
    expect(scope.inScope).toBeUndefined();
  });

  it("counts a reported no-floor tick as having the whole total in scope", () => {
    // Because that is what it means — the tick ran `translate:prepare` with no `--since` at all, so
    // every collected item was selectable, oldest first.
    const scope = collectedScope(items, translateFloorStatus({ unitShow: NOT_INSTALLED }), undefined, {
      at: "2026-08-08T04:17:09.000Z",
    });
    expect(scope.reported).toEqual({ at: "2026-08-08T04:17:09.000Z", inScope: 4 });
  });

  it("keeps the report beside a floor systemd DID answer, so the two can be compared", () => {
    // Not dropped just because a better source answered: `collectedReach` needs both in hand to say
    // "the unit now says X and the last tick ran with Y". The two counts genuinely differ here —
    // 2 of 4 at or after the unit's floor, all 4 at or after the older one the last tick used.
    const scope = collectedScope(items, translateFloorStatus({ unitShow: ARMED }), undefined, {
      floor: "2026-06-01T00:00:00.000Z",
      at: "2026-08-08T04:17:09.000Z",
    });
    expect(scope.inScope).toBe(2);
    expect(scope.reported?.inScope).toBe(4);
  });

  it("has no report when nothing has ever reported one", () => {
    expect(collectedScope(items, translateFloorStatus({ unitShow: ARMED })).reported).toBeUndefined();
  });
});

/**
 * The half of the rule the date comparison alone never had.
 *
 * `applySelector` does not drop everything below the floor — the floor gates the *swept* account and
 * nobody else (`meetsTranslateFloor`), because a post somebody hand-picked in 링크 수집 is not the
 * backlog the floor exists to hold back. A scope counted with a bare `createdAt >= floor` therefore
 * reported a hand-picked pre-floor link as permanently out of the scheduler's reach while the very
 * next tick translated it — on `pnpm status`'s Collected line and on the dashboard's 수집 hover card,
 * both of which are formatted from these two numbers.
 *
 * The handle is imported rather than spelled here for the reason `sweptAccount.ts` gives: two
 * literals drift, and a drifted one would make this suite pass against a rule nobody runs.
 */
describe("collectedScope — who the floor applies to", () => {
  /** Well below ARMED's 2026-07-27 floor, so nothing below turns on a boundary. */
  const PRE_FLOOR = "2026-06-01T00:00:00.000Z";
  const armed = () => translateFloorStatus({ unitShow: ARMED, shellValue: undefined });
  /** The floor the scheduler last reported, chosen equal to ARMED's so the two counts are comparable. */
  const REPORT = { floor: "2026-07-27T14:35:25.000Z", at: "2026-08-08T04:17:09.000Z" };

  it("counts a pre-floor post from another account as in scope, because a tick will take it", () => {
    // The finding: hand-picked, below the floor, and selected anyway. Counting it as below-floor
    // tells a reader the scheduler can never reach an item a tick is going to take.
    const scope = collectedScope([{ createdAt: PRE_FLOOR, author: "VitalikButerin" }], armed());
    expect(scope.inScope).toBe(1);
  });

  it("counts the swept account's own pre-floor post as out of scope, which it genuinely is", () => {
    const scope = collectedScope([{ createdAt: PRE_FLOOR, author: SWEPT_ACCOUNT }], armed());
    expect(scope.inScope).toBe(0);
  });

  it("matches the swept account case-insensitively, as the selecting rule does", () => {
    // An X handle is not case-sensitive, so `@mantle_official` is the same account. Counting it as
    // hand-picked would put the whole swept backlog on the in-scope side of the line.
    const scope = collectedScope([{ createdAt: PRE_FLOOR, author: SWEPT_ACCOUNT.toLowerCase() }], armed());
    expect(scope.inScope).toBe(0);
  });

  it("counts a pre-floor item with no readable author as out of scope", () => {
    // A Lark item has no handle, and neither does an X thread stored with no tweets. `undefined` and
    // `""` both mean "unknown", and unknown keeps the floor — the same conservative direction the
    // selecting rule takes, so the count follows it rather than guessing the friendlier answer.
    const scope = collectedScope(
      [{ createdAt: PRE_FLOOR }, { createdAt: PRE_FLOOR, author: "" }],
      armed(),
    );
    expect(scope.inScope).toBe(0);
  });

  it("leaves a post-floor item in scope whoever wrote it", () => {
    const scope = collectedScope(
      [
        { createdAt: "2026-08-08T09:00:00.000Z", author: SWEPT_ACCOUNT },
        { createdAt: "2026-08-08T09:00:00.000Z", author: "VitalikButerin" },
        { createdAt: "2026-08-08T09:00:00.000Z" },
      ],
      armed(),
    );
    expect(scope.inScope).toBe(3);
  });

  it("applies the identical rule to the reported count, not a bare date comparison", () => {
    // The hosted dashboard reads this number and not the systemd one, so a rule applied to only the
    // first of the two counts would leave the screen most people look at reporting the old answer.
    const scope = collectedScope(
      [
        { createdAt: PRE_FLOOR, author: "VitalikButerin" },
        { createdAt: PRE_FLOOR, author: SWEPT_ACCOUNT },
        { createdAt: PRE_FLOOR },
      ],
      translateFloorStatus({ unitShow: NOT_INSTALLED }),
      undefined,
      REPORT,
    );
    expect(scope.reported?.inScope).toBe(1);
  });

  it("still counts the whole total in scope when the reporting tick ran with no floor", () => {
    // No floor means the tick selects everything, so the author question never arises — including
    // for the swept account's oldest posts, which is exactly what makes that state alarming.
    const scope = collectedScope(
      [{ createdAt: PRE_FLOOR, author: SWEPT_ACCOUNT }, { createdAt: "" }],
      translateFloorStatus({ unitShow: NOT_INSTALLED }),
      undefined,
      { at: REPORT.at },
    );
    expect(scope.reported?.inScope).toBe(2);
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

  it("names the report and its instant when the scope came from one, not from systemd", () => {
    // The line must not read like the `in scope 1 · below floor 2` above it: that one was checked
    // against the running manager, this one is repeating what a tick wrote down. The instant is part
    // of the claim.
    const reported = collectedScopeNote(
      collectedScope(items, translateFloorStatus({ unitShow: NOT_INSTALLED }), undefined, {
        floor: "2026-07-27T14:35:25.000Z",
        at: "2026-08-08T04:17:09.000Z",
      }),
    );
    expect(reported).toBe("in scope 1 · below floor 2 · as the scheduler reported at 2026-08-08T04:17:09.000Z");
    expect(reported).not.toBe(note(ARMED));
  });

  it("keeps a reported NO floor alarming on the CLI line too", () => {
    const reported = collectedScopeNote(
      collectedScope(items, translateFloorStatus({ unitShow: NOT_INSTALLED }), undefined, {
        at: "2026-08-08T04:17:09.000Z",
      }),
    );
    expect(reported).toContain("⚠");
    expect(reported).toContain("in scope 3");
    expect(reported).toContain("2026-08-08T04:17:09.000Z");
  });

  it("prints the gap when the unit and the last tick name different floors", () => {
    const disagreeing = collectedScopeNote(
      collectedScope(items, translateFloorStatus({ unitShow: ARMED }), undefined, {
        floor: "2026-06-01T00:00:00.000Z",
        at: "2026-08-08T04:17:09.000Z",
      }),
    );
    // The systemd numbers still lead the line — precedence — and the gap rides behind them.
    expect(disagreeing).toContain("in scope 1 · below floor 2");
    expect(disagreeing).toContain("⚠ last tick ran with 2026-06-01T00:00:00.000Z");

    // An agreeing report changes the line not at all, so the ordinary case stays exactly as short
    // as it was.
    expect(
      collectedScopeNote(
        collectedScope(items, translateFloorStatus({ unitShow: ARMED }), undefined, {
          floor: "2026-07-27T14:35:25.000Z",
          at: "2026-08-08T04:17:09.000Z",
        }),
      ),
    ).toBe(note(ARMED));
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

/**
 * The value both readers start from. `pnpm status` renders it as one line of text; the dashboard's
 * hover card renders it as a card, in Korean. The point of the split is that the *arithmetic* — the
 * terms, their signs, which of them are omitted, and the three-way reduction of the floor — happens
 * exactly once, here, because the last time a Collected-line change landed it reached the CLI only
 * and the header went on showing a bare 134.
 */
describe("collectedBreakdown", () => {
  const CONFIGURED: TranslateFloorStatus = { kind: "configured", floor: "2026-07-27T14:35:25.000Z" };
  /** Production on 2026-08-08, the same measurement the note's own suite above is written from. */
  const PRODUCTION: CollectedScope = {
    floor: CONFIGURED,
    total: 134,
    inScope: 20,
    intake: { threads: 223, repliesDropped: 92 },
  };

  it("states the funnel as terms with their own signs, not as one reader's sentence", () => {
    expect(collectedBreakdown(PRODUCTION).intake).toEqual([
      { kind: "threads", count: 223 },
      { kind: "replies-dropped", op: "-", count: 92 },
      { kind: "lark", op: "+", count: 3 },
    ]);
  });

  it("derives the Lark term, so whatever renders it lands on the total", () => {
    // Derived (`total - (threads - repliesDropped)`), never counted: derived, the terms reconcile by
    // construction and no reader can draw a funnel that fails to reach its own total. This is the
    // property that has to survive being sent over a wire and drawn by different code.
    const { intake, total } = collectedBreakdown(PRODUCTION);
    const sum = intake!.reduce((n, t) => n + (t.op === "-" ? -t.count : t.count), 0);
    expect(sum).toBe(total);
  });

  it("omits a zero term rather than sending one nobody should draw", () => {
    // The omission rule lives here for the same reason the derivation does — a card that dropped a
    // different set of terms than the CLI line would be a second funnel.
    expect(collectedBreakdown({ ...PRODUCTION, total: 226, intake: { threads: 223, repliesDropped: 0 } }).intake)
      .toEqual([
        { kind: "threads", count: 223 },
        { kind: "lark", op: "+", count: 3 },
      ]);
    expect(collectedBreakdown({ ...PRODUCTION, total: 131 }).intake).toEqual([
      { kind: "threads", count: 223 },
      { kind: "replies-dropped", op: "-", count: 92 },
    ]);
  });

  it("has no funnel when there is none to draw honestly, and still reports the scope", () => {
    // Nothing from X, and two reads of the database that disagree — the two cases the CLI prints no
    // funnel for. A reader that received terms here would draw a funnel the CLI refuses to.
    const noX = collectedBreakdown({ ...PRODUCTION, total: 3, inScope: 1, intake: { threads: 0, repliesDropped: 0 } });
    expect(noX.intake).toBeUndefined();
    expect(noX.reach).toEqual({ kind: "measured", inScope: 1, belowFloor: 2, floor: CONFIGURED.floor });

    expect(collectedBreakdown({ ...PRODUCTION, total: 100 }).intake).toBeUndefined();
  });

  it("measures the reach when a floor was read, naming the floor it measured against", () => {
    expect(collectedBreakdown(PRODUCTION).reach).toEqual({
      kind: "measured",
      inScope: 20,
      belowFloor: 114,
      floor: "2026-07-27T14:35:25.000Z",
    });
  });

  it("keeps `no floor set` and `could not be read` apart, because they are opposite facts", () => {
    // The distinction the whole module exists for. `no-floor` means the scheduler is draining the
    // entire backlog oldest first — something to act on. `unknown` means nothing was learned either
    // way, which is what the hosted dashboard will show forever. A UI that renders them alike is
    // reporting a number as though it had been checked.
    expect(collectedBreakdown({ floor: { kind: "none" }, total: 134 }).reach).toEqual({
      kind: "no-floor",
      inScope: 134,
    });
    expect(collectedBreakdown({ floor: { kind: "not-installed" }, total: 134 }).reach).toEqual({ kind: "unknown" });
  });

  it("folds every unaskable state into `unknown`, carrying the refusal's own words", () => {
    // `not-installed`, `unreadable` and `invalid` all mean the same thing to someone reading a
    // total: nothing here could read the floor. `detail` is what keeps the parse error from being
    // lost in that fold — it is the only thing that says which of the three this was.
    const floors: TranslateFloorStatus[] = [
      { kind: "not-installed" },
      { kind: "unreadable", detail: "systemctl: not found" },
      { kind: "invalid", detail: 'HERALD_TRANSLATE_SINCE is not a date this can parse: "soon"' },
    ];
    const reaches = floors.map((floor) => collectedBreakdown({ floor, total: 134 }).reach);
    expect(reaches.map((r) => r.kind)).toEqual(["unknown", "unknown", "unknown"]);
    expect(reaches.map((r) => r.detail)).toEqual([
      undefined,
      "systemctl: not found",
      'HERALD_TRANSLATE_SINCE is not a date this can parse: "soon"',
    ]);
  });

  /**
   * The fourth state, and the reason this whole change exists. The hosted dashboard is a Vercel
   * function: `readTranslateFloor` there never asks systemd at all, so its floor is permanently
   * `unreadable` and its card said "cannot be read from here" forever. The scheduler's own report is
   * what it falls back to instead — real numbers, measured against the floor a real tick really ran
   * with, and stamped with when.
   */
  it("falls back to the scheduler's own report where nothing could be read here", () => {
    const reach = collectedBreakdown({
      floor: { kind: "unreadable", detail: `could not ask systemd about ${WATCH_UNIT}` },
      total: 134,
      reported: { floor: "2026-07-27T14:35:25.000Z", at: "2026-08-08T04:17:09.000Z", inScope: 20 },
    }).reach;
    expect(reach).toEqual({
      kind: "reported",
      inScope: 20,
      belowFloor: 114,
      reportedFloor: "2026-07-27T14:35:25.000Z",
      reportedAt: "2026-08-08T04:17:09.000Z",
    });
    // `floor` stays empty on purpose: nothing on this machine read a floor, and a reader that cannot
    // tell "systemd told me" from "the scheduler wrote it down" is what `reported` exists to prevent.
    expect(reach.floor).toBeUndefined();
  });

  it("never calls a reported floor `measured` — one was checked and the other is an observation", () => {
    // The single most important property of the new state. `measured` is verified against the
    // running manager a moment ago; `reported` could be three weeks old. Collapsing them turns a
    // dead scheduler into a confident answer, which is the exact mistake the module was written for.
    const reported = collectedBreakdown({
      floor: { kind: "not-installed" },
      total: 134,
      reported: { floor: "2026-07-27T14:35:25.000Z", at: "2026-08-08T04:17:09.000Z", inScope: 20 },
    }).reach;
    expect(reported.kind).toBe("reported");
    expect(reported.kind).not.toBe("measured");
  });

  it("carries a report that says the tick ran with NO floor, distinct from no report at all", () => {
    // Two different facts, and the alarming one has to survive the fallback: a tick that ran with no
    // floor is draining the whole backlog oldest first. A missing report is an absence of
    // information. `reportedAt` set with `reportedFloor` absent is the first; `unknown` is the second.
    const noFloorReported = collectedBreakdown({
      floor: { kind: "not-installed" },
      total: 134,
      reported: { at: "2026-08-08T04:17:09.000Z", inScope: 134 },
    }).reach;
    expect(noFloorReported).toEqual({
      kind: "reported",
      inScope: 134,
      belowFloor: 0,
      reportedFloor: undefined,
      reportedAt: "2026-08-08T04:17:09.000Z",
    });
    expect(collectedBreakdown({ floor: { kind: "not-installed" }, total: 134 }).reach.kind).toBe("unknown");
  });

  /**
   * Precedence, stated as a test. A live `systemctl show` asks the running manager what the NEXT
   * tick will fire with; a report is what the LAST one already did. Where both exist the first wins,
   * because it is current by construction.
   */
  it("prefers what systemd says here over a stored report, whichever direction they differ in", () => {
    const configured: TranslateFloorStatus = { kind: "configured", floor: "2026-07-27T14:35:25.000Z" };
    const reach = collectedBreakdown({
      floor: configured,
      total: 134,
      inScope: 20,
      reported: { floor: "2026-06-01T00:00:00.000Z", at: "2026-08-08T04:17:09.000Z", inScope: 90 },
    }).reach;
    expect(reach.kind).toBe("measured");
    // The numbers are systemd's, not the report's — 20/114, never 90/44.
    expect([reach.inScope, reach.belowFloor]).toEqual([20, 114]);
    expect(reach.floor).toBe("2026-07-27T14:35:25.000Z");
  });

  it("shows a disagreement rather than resolving it away", () => {
    // The gap has exactly two explanations and both need a human: the unit was edited and no tick
    // has run since, or the scheduler has stopped. Preferring the fresher number silently is how the
    // second one goes unnoticed for as long as nobody happens to read a journal.
    const reach = collectedBreakdown({
      floor: { kind: "configured", floor: "2026-07-27T14:35:25.000Z" },
      total: 134,
      inScope: 20,
      reported: { floor: "2026-06-01T00:00:00.000Z", at: "2026-08-08T04:17:09.000Z", inScope: 90 },
    }).reach;
    expect(reach.reportedFloor).toBe("2026-06-01T00:00:00.000Z");
    expect(reach.reportedAt).toBe("2026-08-08T04:17:09.000Z");

    // Agreement is nothing to report: the same floor from both sources leaves the reach exactly as
    // it was before reports existed, so the ordinary case gains no noise.
    const agreeing = collectedBreakdown({
      floor: { kind: "configured", floor: "2026-07-27T14:35:25.000Z" },
      total: 134,
      inScope: 20,
      reported: { floor: "2026-07-27T14:35:25.000Z", at: "2026-08-08T04:17:09.000Z", inScope: 20 },
    }).reach;
    expect(agreeing.reportedAt).toBeUndefined();
    expect(agreeing.reportedFloor).toBeUndefined();
  });

  it("reports a `none` unit as no-floor even with a report in hand, and flags the gap", () => {
    // `none` is systemd answering, not systemd failing — so it keeps its alarm and its precedence.
    // A report naming a floor while the unit sets none is still a disagreement worth showing: it
    // means the floor was removed and the last tick predates the removal.
    const reach = collectedBreakdown({
      floor: { kind: "none" },
      total: 134,
      reported: { floor: "2026-07-27T14:35:25.000Z", at: "2026-08-08T04:17:09.000Z", inScope: 20 },
    }).reach;
    expect(reach.kind).toBe("no-floor");
    expect(reach.inScope).toBe(134);
    expect(reach.reportedFloor).toBe("2026-07-27T14:35:25.000Z");

    // And a unit with no floor whose last tick also ran with none is agreement, not a gap.
    const agreeing = collectedBreakdown({
      floor: { kind: "none" },
      total: 134,
      reported: { at: "2026-08-08T04:17:09.000Z", inScope: 134 },
    }).reach;
    expect(agreeing).toEqual({ kind: "no-floor", inScope: 134 });
  });

  /**
   * `invalid` is systemd answering too — with a value `parseTranslateSince` refuses, which makes
   * `watch.ts` throw before any stage runs, so *every* tick exits at startup. Any report in the
   * database is therefore from before the bad edit, i.e. from a scheduler that is now dead. Falling
   * back to it would paint a confident floor over exactly the failure an operator has to see.
   */
  it("does not fall back to a report when the unit's own value is unusable", () => {
    const reach = collectedBreakdown({
      floor: { kind: "invalid", detail: 'HERALD_TRANSLATE_SINCE is not a date this can parse: "soon"' },
      total: 134,
      reported: { floor: "2026-07-27T14:35:25.000Z", at: "2026-08-08T04:17:09.000Z", inScope: 20 },
    }).reach;
    expect(reach.kind).toBe("unknown");
    expect(reach.detail).toContain("soon");
  });

  it("is what `pnpm status`'s own line is formatted from, term for term", () => {
    // Not a comparison of two computations — a demonstration that there is only one. Anything the
    // card can draw is on the CLI line, with the same operator and the same number, because the
    // line is rendered from this exact value.
    const { intake, reach } = collectedBreakdown(PRODUCTION);
    const note = collectedScopeNote(PRODUCTION);
    for (const term of intake ?? []) expect(note).toContain(`${term.op ? `${term.op} ` : ""}${term.count} `);
    expect(note).toContain(`in scope ${reach.inScope}`);
    expect(note).toContain(`below floor ${reach.belowFloor}`);
  });

  it("reports a total for every floor state and every intake, the way the note does", () => {
    // A card with no numbers is the bare total again, one hover deeper.
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
        const breakdown = collectedBreakdown({ floor, total: 134, inScope, intake });
        expect(breakdown.total).toBe(134);
        expect(breakdown.reach.kind).toBeTruthy();
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
