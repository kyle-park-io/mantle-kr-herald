import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { kstStamp, kstStampShort, kstStampFull } from "../src/types";

/**
 * Forced to UTC for the duration of this file, and this is the point of the file.
 *
 * Without it these assertions pass on a machine already set to Asia/Seoul even if
 * `timeZone: "Asia/Seoul"` is deleted from `kstStamp` — measured: removing the pin left all of
 * them green on the author's own laptop, and only a UTC CI runner would have caught the
 * regression. A test that cannot fail where it is written is barely a test.
 */
const ORIGINAL_TZ = process.env.TZ;
beforeAll(() => {
  process.env.TZ = "UTC";
});
afterAll(() => {
  if (ORIGINAL_TZ === undefined) delete process.env.TZ;
  else process.env.TZ = ORIGINAL_TZ;
});

describe("kstStamp", () => {
  it("does not merely echo the ambient zone", () => {
    // The guard for the guard: if this ever reads Asia/Seoul, the two assertions below stop
    // proving anything and this test says so instead of passing quietly.
    expect(Intl.DateTimeFormat().resolvedOptions().timeZone).not.toBe("Asia/Seoul");
  });

  it("renders a UTC instant in Korea time, not the viewer's zone", () => {
    // The real one: x:2082108368806941060's live post. 05:39 UTC is 14:39 the same day in Seoul.
    // Pinned to Asia/Seoul rather than the viewer's locale because the label says KST — a board
    // shared with a team, and read from a CI runner in UTC, must not quietly mean two things.
    expect(kstStamp("2026-07-31T05:39:41.000Z")).toBe("2026-07-31 14:39 KST");
  });

  it("crosses the date boundary the way KST actually does", () => {
    // 22:10 UTC is already the NEXT day in Seoul. Slicing the ISO string — the obvious shortcut —
    // gets this wrong by a whole calendar day, on a field whose only job is "when did this go out".
    expect(kstStamp("2026-07-31T22:10:00.000Z")).toBe("2026-08-01 07:10 KST");
  });

  it("returns undefined for a missing or unparseable value, so the caller renders nothing", () => {
    expect(kstStamp(undefined)).toBeUndefined();
    expect(kstStamp("")).toBeUndefined();
    expect(kstStamp("not a date")).toBeUndefined();
  });
});

/**
 * The outlet board's own timestamps, which used to format in the *viewer's* zone. Same instant,
 * two answers depending on who was looking — on a ledger whose entire job is "did this go out, and
 * when". These are the same two helpers `OutletCard` used to define privately, now pinned to Seoul
 * like everything else that answers that question.
 */
describe("kstStampShort / kstStampFull", () => {
  // 22:10 UTC is already the next day in Seoul: the case that separates a pinned formatter from an
  // ambient one, and the one an operator would misread as "yesterday".
  const LATE = "2026-07-31T22:10:00.000Z";

  it("formats the compact chip in Seoul, not the ambient zone", () => {
    expect(kstStampShort(LATE)).toBe("08. 01. 07:10");
  });

  it("formats the spelled-out tooltip in Seoul, and says KST", () => {
    // The chip is narrow and stays unlabelled; the tooltip has room, so this is where the zone is
    // stated outright rather than assumed.
    expect(kstStampFull(LATE)).toBe("2026. 8. 1. AM 7:10:00 KST");
  });

  it("returns empty/undefined for a missing value, matching what the callers already handle", () => {
    // `kstStampShort` returns "" because OutletCard interpolates it directly into a chip label;
    // `kstStampFull` returns undefined because its callers use `?? "이미"` fallbacks.
    expect(kstStampShort(undefined)).toBe("");
    expect(kstStampShort("not a date")).toBe("");
    expect(kstStampFull(undefined)).toBeUndefined();
    expect(kstStampFull("not a date")).toBeUndefined();
  });
});
