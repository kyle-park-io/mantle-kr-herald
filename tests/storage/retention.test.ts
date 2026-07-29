import { describe, it, expect } from "vitest";
import { expiredArchiveDays, isLockFile, isStrandedTempFile } from "../../src/storage/retention";

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

  it("matches a lock file abandoned by a process that died mid-write", () => {
    expect(isStrandedTempFile("deliveries.json.lock")).toBe(true);
    expect(isStrandedTempFile("x-article.json.lock")).toBe(true);
  });

  // SAFETY: the lock pattern must not reach past the suffix `lockPathFor` appends.
  it("rejects near-misses of the lock suffix", () => {
    expect(isStrandedTempFile("deliveries.json")).toBe(false);
    expect(isStrandedTempFile("lock.json")).toBe(false);
    expect(isStrandedTempFile("pnpm-lock.yaml")).toBe(false);
    expect(isStrandedTempFile("deliveries.json.lock.bak")).toBe(false);
  });

  // A stale-lock reclaim renames the dead lock aside before deleting it. If a process dies in that
  // one-syscall gap the scratch file survives, so it is named with writeJsonFileAtomic's temp
  // suffix specifically to land here — otherwise it would be debris nothing ever sweeps.
  it("matches the scratch file a stale-lock reclaim can leave behind", () => {
    const scratch = "deliveries.json.lock.tmp-243374-1785337244178-028b43c9-d64b-4969-932e-86c3767575e1";
    expect(isStrandedTempFile(scratch)).toBe(true);
    // And it is a temp file, not a lock, so `pnpm clean`'s age gate does not hold it back.
    expect(isLockFile(scratch)).toBe(false);
  });
});

describe("isLockFile", () => {
  // `pnpm clean` needs this to tell a lock apart from a temp file: a lock young enough to still be
  // held by a running send must survive the sweep, or removing it re-opens the race that drops a
  // send row — and a dropped send row is a duplicate live post.
  it("distinguishes a lock from an atomic-write temp file", () => {
    expect(isLockFile("deliveries.json.lock")).toBe(true);
    expect(isLockFile("items.json.tmp-4821-1750000000000-3f2b1c9d-aaaa-bbbb-cccc-ddddeeeeffff")).toBe(false);
    expect(isLockFile("deliveries.json")).toBe(false);
  });
});
