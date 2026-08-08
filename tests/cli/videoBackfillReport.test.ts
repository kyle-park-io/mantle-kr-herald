import { describe, it, expect } from "vitest";
import { videoBackfillPlanLines } from "../../src/cli/videoBackfillReport";
import type { VideoBackfillPlan } from "../../src/app/BackfillVideoUrls";

function plan(overrides: Partial<VideoBackfillPlan> = {}): VideoBackfillPlan {
  return {
    candidates: 0,
    candidateThreads: 0,
    candidateTweetIds: [],
    filled: 0,
    patched: [],
    unfilledTweetIds: [],
    ...overrides,
  };
}

describe("videoBackfillPlanLines", () => {
  it("cannot see whether the run will write", () => {
    // The invariant this file exists for: a preview and a `--yes` run print the SAME plan, so an
    // operator sees the outcome before authorising it. Enforced structurally rather than by
    // eyeballing two runs — the printer takes the plan and nothing else, so there is no mode for
    // it to branch on. A second parameter appearing here is the regression.
    expect(videoBackfillPlanLines).toHaveLength(1);
  });

  it("states how many candidates, in how many threads, and how many the API could fill", () => {
    const lines = videoBackfillPlanLines(
      plan({
        candidates: 3,
        candidateThreads: 2,
        candidateTweetIds: ["1", "2", "3"],
        filled: 2,
        patched: [{ rootId: "1", tweets: [], status: "active", firstSeenAt: "2026-06-01T00:00:00.000Z" }],
      }),
    ).join("\n");

    expect(lines).toContain("3 video media");
    expect(lines).toContain("2 thread(s)");
    expect(lines).toContain("fill 2");
    expect(lines).toContain("1 thread(s) would change");
  });

  it("names every id it could not fill, one per line", () => {
    const lines = videoBackfillPlanLines(
      plan({ candidates: 2, candidateThreads: 2, candidateTweetIds: ["7", "9"], filled: 1, unfilledTweetIds: ["9"] }),
    );

    expect(lines.some((l) => l.includes("could not fill (1)"))).toBe(true);
    expect(lines.filter((l) => l.trim() === "9")).toHaveLength(1);
  });

  it("says so plainly when there is nothing to do", () => {
    expect(videoBackfillPlanLines(plan()).join("\n")).toContain("no video media are missing");
  });
});
