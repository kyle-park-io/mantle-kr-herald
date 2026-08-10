// tests/doctor/liveSeverity.test.ts
//
// The one severity policy, now that two callers read it: `deploy:smoke`/`creds:check` render it as
// terminal lines, and `/api/status` renders it as a chip on the board. A second copy would put the
// drifted one in whichever surface nobody was looking at.
import { describe, it, expect } from "vitest";
import { PROBE_TIER, EXPECTED_PROBE_KEYS, liveSeverity } from "../../src/doctor/liveSeverity";

describe("liveSeverity", () => {
  it("fails on a dead publishing credential regardless of whether sends are open", () => {
    for (const key of ["google_auth", "google_drive_review", "google_drive_approved", "lark"] as const) {
      expect(liveSeverity(key, true)).toBe("fail");
      expect(liveSeverity(key, false)).toBe("fail");
    }
  });

  it("follows sendsEnabled for a dead send credential", () => {
    expect(liveSeverity("telegram", true)).toBe("fail");
    expect(liveSeverity("telegram", false)).toBe("warn");
    expect(liveSeverity("typefully", true)).toBe("fail");
    expect(liveSeverity("typefully", false)).toBe("warn");
  });

  it("only ever warns about the Sheet — it is header links, not a publishing path", () => {
    expect(liveSeverity("google_sheets", true)).toBe("warn");
    expect(liveSeverity("google_sheets", false)).toBe("warn");
  });

  it("grades an unknown key as fail, because not knowing which tier a credential is in is not a pass", () => {
    expect(liveSeverity("something_new" as never, true)).toBe("fail");
  });

  it("derives the expected key list from the tier table rather than restating it", () => {
    expect(EXPECTED_PROBE_KEYS).toEqual(Object.keys(PROBE_TIER));
    expect(EXPECTED_PROBE_KEYS).toHaveLength(7);
  });
});
