import { describe, expect, it } from "vitest";
import { sendBlock, type ReviewedCopy, type SourceApproval } from "../../../src/domain/send/sendBlock";

const copy = (over: Partial<ReviewedCopy> = {}): ReviewedCopy => ({
  status: "approved", approvedAt: "2026-03-02T00:00:00.000Z", ...over,
});
const source = (over: Partial<SourceApproval> = {}): SourceApproval => ({
  status: "approved", approvedAt: "2026-03-01T00:00:00.000Z", ...over,
});

describe("sendBlock", () => {
  it("clears copy approved after its source was last approved", () => {
    expect(sendBlock(copy(), source())).toBeNull();
  });

  it("blocks when the copy itself has not been approved in 2차", () => {
    expect(sendBlock(copy({ status: "rendered", approvedAt: undefined }), source())).toBe("unapproved");
  });

  it("blocks when the source translation is not approved", () => {
    expect(sendBlock(copy(), source({ status: "translated", approvedAt: undefined }))).toBe("source-unapproved");
  });

  /**
   * The reviewer can only fix this upstream, so naming the copy's own approval here would send them
   * to the wrong screen.
   */
  it("names the source, not the copy, when both are unapproved", () => {
    expect(sendBlock(copy({ status: "rendered" }), source({ status: "translated" }))).toBe("source-unapproved");
  });

  /**
   * The whole reason this predicate exists. 승인 취소 → 원문 수정 → 재승인 bumps the translation's
   * `approvedAt` past the copy's, so re-approving upstream must NOT release copy that was derived
   * from the text as it read before the edit.
   */
  it("blocks copy approved BEFORE its source was re-approved", () => {
    const reapproved = source({ approvedAt: "2026-03-03T00:00:00.000Z" });
    expect(sendBlock(copy({ approvedAt: "2026-03-02T00:00:00.000Z" }), reapproved)).toBe("source-changed");
  });

  /** Re-approving the copy is one of the two ways out (the other is regenerating it). */
  it("clears again once the copy is re-approved after the source", () => {
    const reapproved = source({ approvedAt: "2026-03-03T00:00:00.000Z" });
    expect(sendBlock(copy({ approvedAt: "2026-03-03T00:00:00.001Z" }), reapproved)).toBeNull();
  });

  it("treats the same instant as in order — approving both in one action must not lock", () => {
    expect(sendBlock(copy({ approvedAt: "2026-03-01T00:00:00.000Z" }), source())).toBeNull();
  });

  /**
   * A rendering with no translation behind it cannot be checked at all. Blocking is the loud
   * failure; clearing would mean a wiring mistake silently unlocks every room.
   */
  it("blocks when the source translation is missing entirely", () => {
    expect(sendBlock(copy(), undefined)).toBe("source-missing");
  });

  /** Defensive: `status: "approved"` without a timestamp cannot prove it came after the source. */
  it("blocks approved copy that carries no approval timestamp", () => {
    expect(sendBlock(copy({ approvedAt: undefined }), source())).toBe("source-changed");
  });

  /**
   * `SaveTranslation` always writes `status` and `approvedAt` together, so this cannot occur; if it
   * ever did there would be no timestamp to compare, and inventing a block would strand the item.
   */
  it("skips the recency check when the source carries no approval timestamp", () => {
    expect(sendBlock(copy(), source({ approvedAt: undefined }))).toBeNull();
  });
});
