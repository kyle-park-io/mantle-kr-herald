// tests/cli/xReconcileReport.test.ts
//
// `src/cli/x-reconcile.ts` is a top-level script with no coverage of its own, so its load-bearing
// wording lives in `src/cli/xReconcileReport.ts` and is asserted here — the same split
// `watchStartup.ts` / `tests/cli/watchStartup.test.ts` already uses.
import { describe, it, expect } from "vitest";
import {
  candidateReasonText,
  externalSummaryLine,
  xReconcileStartupLine,
  xTypesFor,
} from "../../src/cli/xReconcileReport";
import type { ChannelRendering } from "../../src/domain/formatting/models";

const prod = { url: "postgres://u:p@ep-x-y-123.ap-southeast-1.aws.neon.tech/neondb?sslmode=require", env: "production" as const };
const dev = { url: "postgres://u:p@127.0.0.1:5432/herald", env: "development" as const };

function rendering(itemId: string, over: Partial<ChannelRendering> = {}): ChannelRendering {
  return { itemId, type: "x", channel: "x", text: "복사된 원고입니다.", status: "approved", ...over } as ChannelRendering;
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
