// tests/cli/xReconcileReport.test.ts
//
// `src/cli/x-reconcile.ts` is a top-level script with no coverage of its own, so its load-bearing
// wording lives in `src/cli/xReconcileReport.ts` and is asserted here — the same split
// `watchStartup.ts` / `tests/cli/watchStartup.test.ts` already uses.
import { describe, it, expect } from "vitest";
import {
  candidateReasonText,
  externalSummaryLine,
  NOTIFY_RETIRE_THRESHOLD,
  retireNotification,
  translationNearMisses,
  xReconcileStartupLine,
  xTypesFor,
} from "../../src/cli/xReconcileReport";
import type { ChannelRendering } from "../../src/domain/formatting/models";
import type { AssembledThread, SourceTweet } from "../../src/domain/models";
import type { Translation } from "../../src/domain/translation/models";

const prod = { url: "postgres://u:p@ep-x-y-123.ap-southeast-1.aws.neon.tech/neondb?sslmode=require", env: "production" as const };
const dev = { url: "postgres://u:p@127.0.0.1:5432/herald", env: "development" as const };

function rendering(itemId: string, over: Partial<ChannelRendering> = {}): ChannelRendering {
  return { itemId, type: "x", channel: "x", text: "복사된 원고입니다.", status: "approved", ...over } as ChannelRendering;
}

function thread(rootId: string, texts: string[]): AssembledThread {
  const tweets = texts.map(
    (text, i) =>
      ({
        id: i === 0 ? rootId : `${rootId}${i}`,
        conversationId: rootId,
        text,
        createdAt: "2026-08-01T00:00:00.000Z",
        authorUserName: "0xMantleKR",
      }) as SourceTweet,
  );
  return { rootId, tweets };
}

function translation(itemId: string, koreanText: string, over: Partial<Translation> = {}): Translation {
  return {
    itemId,
    source: "x",
    sourceText: "en",
    koreanText,
    status: "translated",
    translatedAt: "2026-08-01T00:00:00.000Z",
    ...over,
  };
}

describe("xReconcileStartupLine", () => {
  it("names the database on the line an operator reads before arming the timer", () => {
    // The unit's ExecStart= carries --yes, so there is no "start it by hand and read the first line"
    // step to copy from herald-watch: the runbook's install has the operator run a PREVIEW with the
    // production environment sourced and stop if this line says `development`. Without the database
    // on the line there is nothing for that step to read.
    const line = xReconcileStartupLine({ handle: "0xMantleKR", since: "2026-07-07T00:00:00.000Z", write: false, db: prod });
    expect(line).toContain("@0xMantleKR");
    expect(line).toContain("since 2026-07-07T00:00:00.000Z");
    expect(line).toContain("database production");
    expect(line).toContain("neon.tech/neondb");
  });

  it("never prints the password from DATABASE_URL", () => {
    // This line goes to the journal, and the OnFailure= hook mails a journal excerpt to Telegram.
    expect(xReconcileStartupLine({ handle: "h", since: "30d", write: true, db: prod })).not.toContain("p@");
    expect(xReconcileStartupLine({ handle: "h", since: "30d", write: true, db: dev })).not.toContain("u:p");
  });

  it("says development when it is pointed at the local database", () => {
    // The exact word the runbook tells the operator to stop on.
    expect(xReconcileStartupLine({ handle: "h", since: "30d", write: false, db: dev })).toContain("database development");
  });

  it("marks a preview run as one, and an armed run not at all", () => {
    expect(xReconcileStartupLine({ handle: "h", since: "30d", write: false, db: prod })).toContain("(preview — no --yes)");
    expect(xReconcileStartupLine({ handle: "h", since: "30d", write: true, db: prod })).not.toContain("preview");
  });

  it("reports a malformed DSN as fixed text rather than echoing it", () => {
    const line = xReconcileStartupLine({ handle: "h", since: "30d", write: true, db: { url: "not a url", env: "production" } });
    expect(line).toContain("DATABASE_URL is not a valid URL");
    expect(line).not.toContain("not a url");
  });
});

describe("externalSummaryLine", () => {
  it("does not claim a zero score means no approved copy existed", () => {
    // Two strings of 3+ normalized characters that share no 3-gram score exactly 0.0 —
    // `intersectionSize / unionSize` with an empty intersection (attribution.ts's `similarity`). So
    // "no approved copy existed to compare against, or the text was too short to score at all" is
    // wrong in the ordinary case: approved copy existed and simply did not overlap. This is the
    // headline an operator reads.
    const line = externalSummaryLine([{ score: 0 }, { score: 0.21 }]);
    expect(line).toContain("external (2)");
    expect(line).toContain("1 scored 0");
    expect(line).not.toMatch(/too short to score at all/);
    expect(line).toMatch(/nothing in common with any approved copy/);
  });

  it("leaves the zero note out entirely when nothing scored zero", () => {
    const line = externalSummaryLine([{ score: 0.31 }]);
    expect(line).toBe("external (1) — live, but not our approved copy.");
  });

  it("counts an empty list without inventing a note", () => {
    expect(externalSummaryLine([])).toBe("external (0) — live, but not our approved copy.");
  });
});

describe("xTypesFor", () => {
  it("shows only the eligible renderings a confirmation was ambiguous between", () => {
    // The word "ambiguous" has to name what it is ambiguous between, and only eligible renderings
    // (approved, channel x, non-empty) are candidates for a confirmation's `type` at all.
    const types = xTypesFor("x:1", [
      rendering("x:1", { type: "kol" }),
      rendering("x:1", { type: "announcement" }),
      rendering("x:1", { type: "casual", channel: "telegram" }),
      rendering("x:1", { type: "explainer", status: "rendered" }),
      rendering("x:2", { type: "x" }),
    ]);
    expect(types).toEqual(["kol", "announcement"]);
  });
});

describe("candidateReasonText", () => {
  it("tells a person what to do next, not which branch fired", () => {
    expect(candidateReasonText("possible-match", "x:1", [])).toMatch(/confirm it by hand/);
    expect(candidateReasonText("duplicate-live-thread", "x:1", [])).toMatch(/which post is the real one/);
  });

  it("names the types an ambiguous itemId is ambiguous between", () => {
    const text = candidateReasonText("ambiguous-rendering-type", "x:1", [
      rendering("x:1", { type: "kol" }),
      rendering("x:1", { type: "announcement" }),
    ]);
    expect(text).toContain("kol, announcement");
    expect(text).toContain("2 eligible x renderings");
  });
});

describe("translationNearMisses", () => {
  // Every koreanText/thread pair below is real production Korean copy (not synthetic filler), so
  // similarity()'s score is measured against actual text rather than a hand-tuned toy string.
  const COPY = "맨틀에서 토큰화 주식이 실시간 시세로 24시간 거래되는 완전한 시장이 열렸습니다. 자본시장 자산이 온체인에 올라온 순간부터 진짜 과제가 시작됩니다.";
  // Shares just enough vocabulary with COPY (온체인/자산/시작) to score above 0 without
  // approaching TRANSLATION_MATCH_AT (0.25) — a real near-miss, not a match.
  const NEAR_MISS_LIVE_TEXT = "온체인 자산이 시장에 올라오면 그 다음이 진짜 시작입니다 여러 팀들이 함께 준비하고 있으니 기대해주세요";
  // Shares no 3-gram with COPY at all.
  const UNRELATED_LIVE_TEXT = "이번 주말 커뮤니티 밋업에서 만나요 다들 즐거운 하루 보내시고 편안한 저녁 시간 보내시길 바랍니다 감사합니다 여러분";

  it("reports a translation whose best live thread scored above 0 but below TRANSLATION_MATCH_AT", () => {
    const misses = translationNearMisses([translation("x:1", COPY)], [thread("100", [NEAR_MISS_LIVE_TEXT])], [], [], []);
    expect(misses).toHaveLength(1);
    expect(misses[0].itemId).toBe("x:1");
    expect(misses[0].rootId).toBe("100");
    expect(misses[0].score).toBeGreaterThan(0);
    expect(misses[0].score).toBeLessThan(0.25);
  });

  it("omits a translation whose best thread shares nothing at all (score 0)", () => {
    const misses = translationNearMisses([translation("x:1", COPY)], [thread("100", [UNRELATED_LIVE_TEXT])], [], [], []);
    expect(misses).toEqual([]);
  });

  it("omits a translation already carrying postedUrl — it already has an owner", () => {
    const misses = translationNearMisses(
      [translation("x:1", COPY, { postedUrl: "https://x.com/0xMantleKR/status/999" })],
      [thread("100", [NEAR_MISS_LIVE_TEXT])],
      [],
      [],
      [],
    );
    expect(misses).toEqual([]);
  });

  it("omits a translation this same run already retired (in `posted`)", () => {
    const misses = translationNearMisses(
      [translation("x:1", COPY)],
      [thread("100", [NEAR_MISS_LIVE_TEXT])],
      [{ itemId: "x:1", rootId: "100" }],
      [],
      [],
    );
    expect(misses).toEqual([]);
  });

  it("omits a translation with empty koreanText — similarity can never score it above 0", () => {
    const misses = translationNearMisses([translation("x:1", "")], [thread("100", [NEAR_MISS_LIVE_TEXT])], [], [], []);
    expect(misses).toEqual([]);
  });

  it("sorts multiple near-misses highest score first", () => {
    // Shares more vocabulary with NEAR_MISS_LIVE_TEXT than COPY does (score ~0.232 vs ~0.030),
    // while itself staying far from COPY (~0.019) so it is unambiguously the "closer" one here.
    const closer = "온체인 자산이 시장에 나오면 진짜 시작은 그 다음부터입니다 팀들이 함께 준비 중이니 많은 기대 부탁드립니다";
    const misses = translationNearMisses(
      [translation("x:1", COPY), translation("x:2", closer)],
      [thread("100", [NEAR_MISS_LIVE_TEXT]), thread("200", [NEAR_MISS_LIVE_TEXT])],
      [],
      [],
      [],
    );
    expect(misses.map((m) => m.itemId)).toEqual(["x:2", "x:1"]);
    expect(misses[0].score).toBeGreaterThanOrEqual(misses[1].score);
  });

  describe("Finding 5 — scores against the same pool reconcileXPublished's own pass excluded", () => {
    it("excludes a thread another translation already claimed this run (plan.posted's own rootIds)", () => {
      // Without this exclusion, x:1 would show thread 100 as "almost" even though it already
      // belongs to a different translation's real retire (x:9) this same run.
      const misses = translationNearMisses(
        [translation("x:1", COPY)],
        [thread("100", [NEAR_MISS_LIVE_TEXT])],
        [{ itemId: "x:9", rootId: "100" }],
        [],
        [],
      );
      expect(misses).toEqual([]);
    });

    it("excludes a thread already turned into a plan.confirmed delivery row", () => {
      const misses = translationNearMisses(
        [translation("x:1", COPY)],
        [thread("100", [NEAR_MISS_LIVE_TEXT])],
        [],
        ["100"],
        [],
      );
      expect(misses).toEqual([]);
    });

    it("excludes a thread already sitting in plan.candidates", () => {
      const misses = translationNearMisses(
        [translation("x:1", COPY)],
        [thread("100", [NEAR_MISS_LIVE_TEXT])],
        [],
        [],
        ["100"],
      );
      expect(misses).toEqual([]);
    });
  });
});

describe("retireNotification", () => {
  // Task 4 review's Finding 6: the ">= 3" threshold used to be an inline literal in x-reconcile.ts
  // with no test that could fail. The spec's own number, pinned directly: if this ever changes, it
  // should be a deliberate edit to this assertion, not a silent drift.
  it("the threshold is 3", () => {
    expect(NOTIFY_RETIRE_THRESHOLD).toBe(3);
  });

  // The rest of this block asserts against the exported constant rather than a hardcoded "3", so a
  // future deliberate change to NOTIFY_RETIRE_THRESHOLD updates these expectations along with it.
  it("fires at the threshold", () => {
    const message = retireNotification(NOTIFY_RETIRE_THRESHOLD, ["x:1", "x:2", "x:3"], "0xMantleKR");
    expect(message).toBeDefined();
    expect(message).toContain(String(NOTIFY_RETIRE_THRESHOLD));
    expect(message).toContain("@0xMantleKR");
    expect(message).toContain("x:1, x:2, x:3");
  });

  it("does not fire one below the threshold", () => {
    const message = retireNotification(NOTIFY_RETIRE_THRESHOLD - 1, ["x:1", "x:2"], "0xMantleKR");
    expect(message).toBeUndefined();
  });

  it("fires above the threshold too, naming the real count", () => {
    const message = retireNotification(NOTIFY_RETIRE_THRESHOLD + 2, ["x:1", "x:2", "x:3", "x:4", "x:5"], "0xMantleKR");
    expect(message).toContain(String(NOTIFY_RETIRE_THRESHOLD + 2));
  });
});
