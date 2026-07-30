import { describe, expect, it } from "vitest";
import { publishEvidence, type Headroom } from "../../../src/domain/send/headroom";

/**
 * A reading of a 15/month account. `remaining` is derived from `used` because that is the
 * relationship the live API reports — `used + remaining` is the plan's ceiling — and the whole point
 * of `publishEvidence` reading both is to refuse when a pair does NOT hold it. The tests that stage
 * a broken pair pass `remaining` explicitly.
 */
const at = (used: number, remaining = 15 - used): Headroom => ({
  used,
  remaining,
  inFlight: 1,
  available: remaining - 1,
  resetsAt: "2026-08-01T00:00:00+09:00",
});

describe("publishEvidence", () => {
  it("reads a still counter as nothing published — the cancel really was a cancel", () => {
    expect(publishEvidence(at(9), at(9))).toBe("still");
  });

  it("reads a risen `used` as a publish charged inside the window", () => {
    expect(publishEvidence(at(9), at(10))).toBe("published");
  });

  /** The branch fires on any increase — two siblings can publish inside one 1.5s settle. */
  it("reads a jump of more than one as a publish too", () => {
    expect(publishEvidence(at(9), at(11))).toBe("published");
  });

  /**
   * THE residual. `used` is not monotonic: the quota resets on the 1st (KST) and the counter drops.
   * `14 → 1` is a rollover with this very draft publishing straight after it, and the old
   * `after.used > before.used` read that as "used went down, so nothing published" — then let the
   * resend go out on top of a live post.
   */
  it("refuses to call a backwards counter a clean cancel — a reset can hide a publish inside its own drop", () => {
    expect(publishEvidence(at(14), at(1))).toBe("reset");
  });

  /**
   * And it cannot be rescued by looking harder at the numbers: a plain rollover with nothing
   * published is `14 → 0`, and it has to be refused as well. `used + remaining` is the plan ceiling
   * and holds across a reset exactly as it holds across a publish, so the pair genuinely cannot tell
   * these two apart — the refusal is the honest answer, not a conservative one.
   */
  it("refuses a rollover that published nothing too, because it is indistinguishable from one that did", () => {
    expect(publishEvidence(at(14), at(0))).toBe("reset");
  });

  /**
   * Nor does landing on zero prove innocence: a publish charged in the OLD month is wiped by the
   * rollover, so a live post can sit behind a counter reading `used 0`.
   */
  it("still refuses when the counter came back at zero — the old month's charge is gone with it", () => {
    expect(publishEvidence(at(15, 0), at(0, 15))).toBe("reset");
  });

  describe("readings that cannot both be true", () => {
    /**
     * `remaining` is load-bearing, not decorative. A `used` that rose while `remaining` sat still
     * describes an account this arithmetic does not understand, and guessing at it is the one thing
     * this guard never does.
     */
    it("refuses when `used` rose but `remaining` did not fall with it", () => {
      expect(publishEvidence(at(9), at(10, 6))).toBe("incoherent");
    });

    it("refuses when `remaining` moved on its own and `used` did not", () => {
      expect(publishEvidence(at(9), at(9, 5))).toBe("incoherent");
    });

    it("refuses when both moved the same way", () => {
      expect(publishEvidence(at(9), at(10, 7))).toBe("incoherent");
    });
  });

  describe("a reading that is missing", () => {
    it("is unreadable on either side", () => {
      expect(publishEvidence(undefined, at(9))).toBe("unreadable");
      expect(publishEvidence(at(9), undefined)).toBe("unreadable");
      expect(publishEvidence(undefined, undefined)).toBe("unreadable");
    });

    /** Never "still": an unread quota is the absence of evidence, not evidence of a clean cancel. */
    it("does not fall through to the safe answer", () => {
      expect(publishEvidence(undefined, at(9))).not.toBe("still");
    });
  });
});
