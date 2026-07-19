import { describe, it, expect } from "vitest";
import { expiredArchiveDays, isStrandedTempFile } from "../../src/storage/retention";

const now = new Date("2026-07-20T12:00:00.000Z");

describe("expiredArchiveDays", () => {
  it("keeps folders inside the retention window", () => {
    expect(expiredArchiveDays(["2026-07-19", "2026-06-25"], 30, now)).toEqual([]);
  });

  it("expires folders older than the window", () => {
    expect(expiredArchiveDays(["2026-06-19", "2026-07-19"], 30, now)).toEqual(["2026-06-19"]);
  });

  it("treats the boundary day as still within the window", () => {
    expect(expiredArchiveDays(["2026-06-20"], 30, now)).toEqual([]);
  });

  it("is independent of the time of day the command runs", () => {
    const early = new Date("2026-07-20T00:30:00.000Z");
    const late = new Date("2026-07-20T23:30:00.000Z");
    expect(expiredArchiveDays(["2026-06-20"], 30, early)).toEqual([]);
    expect(expiredArchiveDays(["2026-06-20"], 30, late)).toEqual([]);
  });

  it("keeps today's folder even at --older-than 0, and expires yesterday's", () => {
    expect(expiredArchiveDays(["2026-07-20"], 0, now)).toEqual([]);
    expect(expiredArchiveDays(["2026-07-19"], 0, now)).toEqual(["2026-07-19"]);
  });

  it("ignores anything that is not a date folder", () => {
    expect(expiredArchiveDays(["notes", "2026-13-45", ".DS_Store"], 30, now)).toEqual([]);
  });
});

describe("isStrandedTempFile", () => {
  it("matches the atomic-write temp pattern", () => {
    expect(isStrandedTempFile("items.json.tmp-4821-1750000000000-3f2b1c9d-aaaa-bbbb-cccc-ddddeeeeffff")).toBe(true);
  });

  it("never matches a live store", () => {
    expect(isStrandedTempFile("items.json")).toBe(false);
    expect(isStrandedTempFile("state.json")).toBe(false);
    expect(isStrandedTempFile("pending.json")).toBe(false);
  });

  // SAFETY: this is the assertion standing between `pnpm clean` and the user's real,
  // irreplaceable pipeline data. Every live store filename must be rejected.
  it("rejects every live store filename, not just the ones in the brief", () => {
    expect(isStrandedTempFile("items.json")).toBe(false);
    expect(isStrandedTempFile("state.json")).toBe(false);
    expect(isStrandedTempFile("pending.json")).toBe(false);
    expect(isStrandedTempFile("translations.json")).toBe(false);
    expect(isStrandedTempFile("variants.json")).toBe(false);
    expect(isStrandedTempFile("renderings.json")).toBe(false);
  });

  // SAFETY: the cases above all lack "tmp" entirely, so they stay green even if the pattern is
  // loosened to something as dangerous as /\.tmp/. These near-misses pin down its specificity:
  // each contains "tmp" but is NOT the `.tmp-<pid>-<ms>-<uuid>` suffix writeJsonFileAtomic appends.
  it("rejects near-misses that a loosened pattern would wrongly delete", () => {
    expect(isStrandedTempFile("notes.tmp")).toBe(false);
    expect(isStrandedTempFile("items.json.tmpbackup")).toBe(false);
    expect(isStrandedTempFile("tmp-notes.md")).toBe(false);
    expect(isStrandedTempFile("items.json.tmp-4821")).toBe(false);
    expect(isStrandedTempFile("items.json.tmp-4821-1750000000000")).toBe(false);
    // Trailing content after the uuid means it is not the suffix we wrote.
    expect(isStrandedTempFile("items.json.tmp-1-2-abc.bak")).toBe(false);
  });
});
