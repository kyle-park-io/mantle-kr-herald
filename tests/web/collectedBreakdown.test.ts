// tests/web/collectedBreakdown.test.ts
//
// The Korean half of the 수집 hover card. Everything numeric arrives already computed
// (`collectedBreakdown` in `src/status/translateFloor.ts`, pinned by `tests/status/translateFloor.test.ts`),
// so what is left to get wrong here is the *wording* — and one of the three floor states is a
// sentence that means the opposite of what a careless reading of it would suggest.
import { describe, expect, it } from "vitest";
import {
  INTAKE_TERM_LABEL,
  REPORT_STALE_AFTER_MS,
  intakeTermAmount,
  reachCopy,
  reportAge,
} from "../../web/src/collectedBreakdown";
import { FLOOR_VAR, WATCH_UNIT, type CollectedReach, type IntakeTerm } from "../../web/src/types";

describe("the intake funnel's Korean terms", () => {
  it("labels every term kind the server can send", () => {
    // `Record<IntakeTerm["kind"], string>` makes `tsc` require the keys; this requires them to say
    // something. An empty label renders a row with a number and no name for it.
    const kinds: IntakeTerm["kind"][] = ["threads", "replies-dropped", "lark"];
    for (const kind of kinds) expect(INTAKE_TERM_LABEL[kind].trim().length).toBeGreaterThan(0);
    expect(Object.keys(INTAKE_TERM_LABEL).sort()).toEqual([...kinds].sort());
  });

  it("says the dropped threads were filtered, not deleted", () => {
    // A reply-rooted thread was never removed from anything — it was filtered out before it could
    // become an item. A reviewer reading "삭제" goes looking for something to restore, and there is
    // nothing: reaching one of these takes a code change (`isCommenterReply`'s own doc comment).
    expect(INTAKE_TERM_LABEL["replies-dropped"]).toContain("제외");
    expect(INTAKE_TERM_LABEL["replies-dropped"]).not.toContain("삭제");
  });

  it("prints the operator the server sent, never one re-derived from the kind", () => {
    // The sign belongs to the term. Deriving it here — "replies always subtract" — is a second copy
    // of the arithmetic, and the copy is what eventually disagrees with the CLI line.
    expect(intakeTermAmount({ kind: "threads", count: 223 })).toBe("223");
    expect(intakeTermAmount({ kind: "replies-dropped", op: "-", count: 92 })).toBe("-92");
    expect(intakeTermAmount({ kind: "lark", op: "+", count: 3 })).toBe("+3");
  });
});

describe("reachCopy", () => {
  const MEASURED: CollectedReach = {
    kind: "measured",
    inScope: 20,
    belowFloor: 114,
    floor: "2026-07-27T14:35:25.000Z",
  };

  it("states both sides of a floor that was actually read", () => {
    const copy = reachCopy(MEASURED);
    expect(copy.headline).toContain("20");
    expect(copy.headline).toContain("114");
    expect(copy.alarming).toBe(false);
    // The instant itself, handed over untouched: the component renders it in KST and keeps the raw
    // ISO as the tooltip, so the string `pnpm status` prints is still one hover away.
    expect(copy.floor).toBe("2026-07-27T14:35:25.000Z");
  });

  it("makes a missing floor alarming, and says what it actually means", () => {
    // Same call the CLI's own ⚠ makes. "No floor" is not a missing setting, it is the scheduler
    // spending every tick on the oldest posts in the archive — so the copy has to state the
    // condition, not just the absence.
    const copy = reachCopy({ kind: "no-floor", inScope: 134 });
    expect(copy.alarming).toBe(true);
    expect(copy.detail).toContain("오래된 것부터");
    // Named, so an operator knows what to go and look at.
    expect(copy.detail).toContain(WATCH_UNIT);
    expect(copy.detail).toContain(FLOOR_VAR);
  });

  /**
   * The sentence this whole card had to get right. The hosted dashboard is a Vercel function: there
   * is no systemd there and never will be, so this is the state it shows on every page load. It has
   * to read as "this screen cannot see the scheduler's setting" and never as "there is no floor" —
   * those are opposite facts, and the second one is the alarm.
   */
  it("says the floor cannot be read from here, never that there is none", () => {
    const copy = reachCopy({ kind: "unknown" });
    expect(copy.alarming).toBe(false);
    expect(copy.detail).toContain("읽을 수 없습니다");
    expect(copy.detail).toContain("하한이 없다는 뜻이 아니라");
    // And it says where the real answer lives, rather than leaving a dead end.
    expect(copy.detail).toContain("pnpm status");
  });

  it("carries systemd's own words when there are any, without making them the message", () => {
    const copy = reachCopy({ kind: "unknown", detail: "herald-watch.service is masked, not loaded" });
    expect(copy.refusal).toBe("herald-watch.service is masked, not loaded");
    // The Korean sentence is still there — the refusal is English machine output and cannot be the
    // only thing a reviewer is shown.
    expect(copy.detail).toContain("읽을 수 없습니다");
  });

  /** The instant the scheduler's report was written in every case below, and a `now` a fixed
   *  distance from it — the age wording is the point of this state, so nothing here may depend on
   *  the wall clock. */
  const REPORTED_AT = "2026-08-08T04:17:09.000Z";
  const at = (msAfter: number) => new Date(Date.parse(REPORTED_AT) + msAfter);
  const REPORTED: CollectedReach = {
    kind: "reported",
    inScope: 20,
    belowFloor: 114,
    reportedFloor: "2026-07-27T14:35:25.000Z",
    reportedAt: REPORTED_AT,
  };

  it("says a reported floor came from the scheduler, not from this screen", () => {
    // The state the hosted dashboard normally shows. The numbers are real, but nothing here checked
    // them against a running manager — so the line must not read like `measured` does.
    const copy = reachCopy(REPORTED, at(60 * 60 * 1000));
    expect(copy.headline).toContain("20");
    expect(copy.headline).toContain("114");
    expect(copy.headline).toContain("스케줄러 기록");
    expect(copy.headline).not.toBe(reachCopy(MEASURED, at(0)).headline);
    // And the floor itself is still shown, so a reviewer can compare it against `pnpm status`.
    expect(copy.floor).toBe("2026-07-27T14:35:25.000Z");
  });

  /**
   * The obligation this whole state carries. A report from an hour ago and one from three weeks ago
   * name the same floor and mean completely different things — one describes a running scheduler,
   * the other describes one that stopped. If the card renders them identically it has turned a stale
   * observation into a confident current answer, which is the exact failure the state exists to
   * prevent.
   */
  it("makes an hour-old report and a three-week-old one read differently", () => {
    const fresh = reachCopy(REPORTED, at(60 * 60 * 1000));
    const ancient = reachCopy(REPORTED, at(21 * 24 * 60 * 60 * 1000));
    expect(fresh.report).not.toBe(ancient.report);
    expect(fresh.report).toContain("1시간 전");
    expect(ancient.report).toContain("21일 전");
    // Not just different words — a different verdict. The old one says the scheduler may have
    // stopped and is marked for it; the fresh one is neither.
    expect(fresh.reportAlarming).toBe(false);
    expect(fresh.alarming).toBe(false);
    expect(ancient.reportAlarming).toBe(true);
    expect(ancient.alarming).toBe(true);
    expect(ancient.report).toContain("멈췄");
  });

  it("turns stale exactly at the threshold the timer justifies, not before", () => {
    // `REPORT_STALE_AFTER_MS` is three missed fires of `herald-watch.timer`'s every-two-hours
    // schedule. A tighter window would flag a scheduler that is simply between ticks.
    expect(reachCopy(REPORTED, at(REPORT_STALE_AFTER_MS)).reportAlarming).toBe(false);
    expect(reachCopy(REPORTED, at(REPORT_STALE_AFTER_MS + 1)).reportAlarming).toBe(true);
  });

  it("keeps a reported NO floor as alarming as a read one", () => {
    // Same condition, different provenance: the scheduler wrote down that it ran with no cutoff, so
    // every tick is working the oldest posts in the archive. The report being second-hand does not
    // make the queue any less wrong.
    const copy = reachCopy({ kind: "reported", inScope: 134, belowFloor: 0, reportedAt: REPORTED_AT }, at(0));
    expect(copy.alarming).toBe(true);
    expect(copy.headline).toContain("하한 없음");
    expect(copy.detail).toContain("오래된 것부터");
    expect(copy.detail).toContain(FLOOR_VAR);
    // No floor to print beside it — the card renders one line fewer rather than `하한 undefined`.
    expect(copy.floor).toBeUndefined();
  });

  it("shows a disagreement on a floor it DID read, rather than quietly preferring the fresh one", () => {
    // Both explanations are on the line because the reader has to pick between them: the unit was
    // edited and no tick has run since, or the scheduler stopped.
    const copy = reachCopy({ ...MEASURED, reportedFloor: "2026-06-01T00:00:00.000Z", reportedAt: REPORTED_AT }, at(0));
    expect(copy.reportAlarming).toBe(true);
    expect(copy.report).toContain("다릅니다");
    expect(copy.report).toContain("멈춘");
    // The headline still reports what systemd said — precedence — so the disagreement qualifies the
    // numbers instead of replacing them.
    expect(copy.headline).toBe(reachCopy(MEASURED, at(0)).headline);
  });

  it("says nothing about a report that agrees with what was read here", () => {
    // The ordinary case on the machine that owns the unit. An extra line every time the two agree
    // would be noise, and noise is how the line nobody reads gets ignored when it matters.
    expect(reachCopy(MEASURED, at(0)).report).toBeUndefined();
    expect(reachCopy({ kind: "no-floor", inScope: 134 }, at(0)).report).toBeUndefined();
  });

  it("gives the four states four different things to read", () => {
    // `no-floor` and `unknown` rendering alike is the failure that matters: one is an alarm and the
    // other is an absence of information. `reported` reading like `measured` is the new one: an
    // observation with an age must not look like something that was just checked.
    const copies = [
      MEASURED,
      { kind: "no-floor" as const, inScope: 134 },
      REPORTED,
      { kind: "unknown" as const },
    ].map((reach) => reachCopy(reach, at(60 * 60 * 1000)));
    expect(new Set(copies.map((c) => c.headline)).size).toBe(4);
    expect(new Set(copies.map((c) => c.detail)).size).toBe(4);
    expect(copies.map((c) => c.alarming)).toEqual([false, true, false, false]);
  });
});

describe("reportAge", () => {
  const AT = "2026-08-08T04:17:09.000Z";
  const after = (ms: number) => reportAge(AT, new Date(Date.parse(AT) + ms));

  it("scales from minutes to days, so two ages never read the same", () => {
    expect(after(30 * 1000)).toBe("방금 전");
    expect(after(37 * 60 * 1000)).toBe("37분 전");
    expect(after(5 * 60 * 60 * 1000)).toBe("5시간 전");
    expect(after(22 * 24 * 60 * 60 * 1000)).toBe("22일 전");
  });

  it("rounds down at every boundary, so nothing is reported as older than it is", () => {
    expect(after(59 * 60 * 1000 + 59_000)).toBe("59분 전");
    expect(after(60 * 60 * 1000)).toBe("1시간 전");
    expect(after(24 * 60 * 60 * 1000 - 1)).toBe("23시간 전");
    expect(after(24 * 60 * 60 * 1000)).toBe("1일 전");
  });

  it("clamps a report stamped slightly in the future rather than printing a negative age", () => {
    // Not hypothetical: the report is stamped on the scheduler's machine and rendered on the
    // reader's, and this project's own build machine steps its clock by ±22.7s. `-1분 전` would send
    // someone looking for a clock fault where there is only ordinary skew.
    expect(after(-20_000)).toBe("방금 전");
    expect(after(-5 * 60 * 1000)).toBe("방금 전");
  });

  it("says the instant is unreadable rather than rendering NaN into the card", () => {
    expect(reportAge("not-a-date", new Date(AT))).toBe("시각 불명");
  });
});
