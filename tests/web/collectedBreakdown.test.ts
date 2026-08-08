// tests/web/collectedBreakdown.test.ts
//
// The Korean half of the 수집 hover card. Everything numeric arrives already computed
// (`collectedBreakdown` in `src/status/translateFloor.ts`, pinned by `tests/status/translateFloor.test.ts`),
// so what is left to get wrong here is the *wording* — and one of the three floor states is a
// sentence that means the opposite of what a careless reading of it would suggest.
import { describe, expect, it } from "vitest";
import { INTAKE_TERM_LABEL, intakeTermAmount, reachCopy } from "../../web/src/collectedBreakdown";
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

  it("gives the three states three different things to read", () => {
    // `no-floor` and `unknown` rendering alike is the failure that matters: one is an alarm and the
    // other is an absence of information. `measured` differing from both is what makes the card
    // worth opening at all.
    const copies = [MEASURED, { kind: "no-floor" as const, inScope: 134 }, { kind: "unknown" as const }].map(
      reachCopy,
    );
    expect(new Set(copies.map((c) => c.headline)).size).toBe(3);
    expect(new Set(copies.map((c) => c.detail)).size).toBe(3);
    expect(copies.map((c) => c.alarming)).toEqual([false, true, false]);
  });
});
