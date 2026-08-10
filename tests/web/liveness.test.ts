// tests/web/liveness.test.ts
//
// What the chip says and what colour it is. Pure copy-builder, tested without a DOM — the same
// treatment `collectedBreakdown.ts` gets, and for the same reason: these rules are the feature.
import { describe, it, expect } from "vitest";
import { livenessChip, livenessHeadline, probeLabel, LIVENESS_STALE_AFTER_MS } from "../../web/src/liveness";
import type { LivenessSummary } from "../../web/src/types";

const NOW = new Date("2026-08-11T09:00:00.000Z");
const fresh = "2026-08-11T06:23:00.000Z"; // 2h37m old
const stale = "2026-08-10T05:00:00.000Z"; // 28h old
const summary = (over: Partial<LivenessSummary> = {}): LivenessSummary => ({
  observedAt: fresh,
  worst: "ok",
  dead: [],
  total: 7,
  ...over,
});

describe("livenessChip", () => {
  it("shows nothing when nothing has ever been observed", () => {
    expect(livenessChip(undefined, NOW)).toBeUndefined();
  });

  it("shows nothing when a fresh observation found everything alive", () => {
    // The header must be byte-identical to today's when there is nothing to say.
    expect(livenessChip(summary(), NOW)).toBeUndefined();
  });

  it("goes red and counts the publishing keys that did not answer", () => {
    const chip = livenessChip(
      summary({ worst: "fail", dead: [{ key: "google_auth", tier: "publish", severity: "fail", detail: "401" }] }),
      NOW,
    );
    expect(chip).toEqual({ text: "발행 키 1개 응답 없음", tone: "red" });
  });

  it("names the send tier when only send credentials died", () => {
    const chip = livenessChip(
      summary({
        worst: "fail",
        dead: [
          { key: "telegram", tier: "send", severity: "fail", detail: "401" },
          { key: "typefully", tier: "send", severity: "fail", detail: "401" },
        ],
      }),
      NOW,
    );
    expect(chip).toEqual({ text: "발송 키 2개 응답 없음", tone: "red" });
  });

  it("goes amber, not red, when the only dead credential is graded warn", () => {
    const chip = livenessChip(
      summary({ worst: "warn", dead: [{ key: "google_sheets", tier: "data", severity: "warn", detail: "404" }] }),
      NOW,
    );
    expect(chip).toEqual({ text: "시트 응답 없음", tone: "amber" });
  });

  it("names the publishing tier first when several tiers died together", () => {
    const chip = livenessChip(
      summary({
        worst: "fail",
        dead: [
          { key: "google_sheets", tier: "data", severity: "warn", detail: "404" },
          { key: "lark", tier: "publish", severity: "fail", detail: "401" },
        ],
      }),
      NOW,
    );
    expect(chip?.text).toBe("발행 키 1개 응답 없음");
  });

  it("warns in amber when nothing has looked in over a day", () => {
    // The daily unit did not run. When this machine is simply off nothing fails, no Telegram
    // arrives, and the board is the only place the silence shows.
    //
    // The chip borrows `reportAge`'s own wording rather than spelling out "28시간" itself — 28 hours
    // rounds down to a whole day there (`hours < 24` is the cutoff for the hour-vs-day phrasing), so
    // this is "확인 1일 전", not "확인 28시간 전". Asserting the literal `reportAge` output here, rather
    // than a hand-picked string, is what catches this function calling a second age formatter instead
    // of reusing that one.
    expect(livenessChip(summary({ observedAt: stale }), NOW)).toEqual({ text: "확인 1일 전", tone: "amber" });
  });

  it("prefers a dead credential over a stale observation when both are true", () => {
    const chip = livenessChip(
      summary({
        observedAt: stale,
        worst: "fail",
        dead: [{ key: "google_auth", tier: "publish", severity: "fail", detail: "401" }],
      }),
      NOW,
    );
    expect(chip?.text).toBe("발행 키 1개 응답 없음");
  });

  it("does not call a future observation stale", () => {
    // This machine steps its clock, and the observation is stamped by a different one.
    expect(livenessChip(summary({ observedAt: "2026-08-11T09:00:30.000Z" }), NOW)).toBeUndefined();
  });

  it("words a tier this build does not know generically, rather than a false publish count", () => {
    // A deployment one probe (and one tier) ahead of this bundle. The old bug: `TIER_ORDER.find`
    // matches nothing, defaults to "publish", then filters `dead` for "publish" — zero results, so
    // the chip claimed a dead publish key while showing a count of zero. This must never happen: the
    // count has to be real, and a tier this bundle cannot name must not be misnamed as one it can.
    const chip = livenessChip(
      summary({ worst: "fail", dead: [{ key: "new_thing", tier: "config", severity: "fail", detail: "500" }] }),
      NOW,
    );
    expect(chip).toEqual({ text: "키 1개 응답 없음", tone: "red" });
  });

  it("counts every entry when several unknown-tier credentials die together", () => {
    const chip = livenessChip(
      summary({
        worst: "fail",
        dead: [
          { key: "new_thing", tier: "config", severity: "fail", detail: "500" },
          { key: "other_thing", tier: "config", severity: "fail", detail: "500" },
        ],
      }),
      NOW,
    );
    expect(chip).toEqual({ text: "키 2개 응답 없음", tone: "red" });
  });

  it("is one missed daily fire plus margin", () => {
    expect(LIVENESS_STALE_AFTER_MS).toBe(26 * 60 * 60 * 1000);
  });
});

describe("livenessHeadline", () => {
  it("says everything answered, and how long ago", () => {
    expect(livenessHeadline(summary(), NOW)).toBe("7개 모두 응답 · 2시간 전 확인");
  });

  it("says how many did not", () => {
    expect(
      livenessHeadline(
        summary({ worst: "fail", dead: [{ key: "telegram", tier: "send", severity: "fail", detail: "401" }] }),
        NOW,
      ),
    ).toBe("7개 중 1개 응답 없음 · 2시간 전 확인");
  });
});

describe("probeLabel", () => {
  it("names every probe in Korean", () => {
    expect(probeLabel("google_drive_review")).toBe("Drive 검수 폴더");
    expect(probeLabel("telegram")).toBe("Telegram");
  });

  it("falls back to the raw key for a probe this build predates", () => {
    expect(probeLabel("something_new")).toBe("something_new");
  });
});
