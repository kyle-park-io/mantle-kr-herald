import { describe, it, expect } from "vitest";
import { RecordImpressions } from "../../src/app/RecordImpressions";
import type { SheetClient } from "../../src/ports/SheetClient";
import type { SourceTweet } from "../../src/domain/models";

const NOW = () => new Date("2026-07-21T00:00:00.000Z");
const STAMP = "2026-07-21T00:00:00.000Z";

function tweet(id: string, viewCount?: number): SourceTweet {
  return {
    id,
    conversationId: id,
    text: "t",
    createdAt: "2026-01-01T00:00:00.000Z",
    url: `https://x.com/i/${id}`,
    authorUserName: "a",
    isReply: false,
    isQuote: false,
    metrics: viewCount === undefined ? undefined : { viewCount },
  };
}

/** A history data row: [itemId, type, channel, postId, url, status, publishedAt, impressions, impressionsAt]. */
function sheetHarness(existing: string[][]) {
  const updated: { range: string; rows: string[][] }[] = [];
  const sheet: SheetClient = {
    getValues: async () => existing,
    appendValues: async () => {},
    updateValues: async (range, rows) => {
      updated.push({ range, rows });
    },
    createSpreadsheet: async () => ({ spreadsheetId: "x" }),
  };
  return { sheet, updated };
}

function source(tweets: SourceTweet[]) {
  const seen: string[][] = [];
  return {
    seen,
    gw: {
      fetchByIds: async (ids: string[]) => {
        seen.push(ids);
        return tweets;
      },
    },
  };
}

describe("RecordImpressions", () => {
  it("writes viewCount + timestamp to H/I of the matching X row, and nowhere else", async () => {
    const h = sheetHarness([["x:1", "x", "x", "tw1", "u", "posted", "2026-07-20T00:00:00.000Z", "", ""]]);
    const s = source([tweet("tw1", 1234)]);

    const res = await new RecordImpressions(h.sheet, s.gw, NOW).run();

    expect(s.seen).toEqual([["tw1"]]);
    expect(h.updated).toEqual([{ range: "history!H2:I2", rows: [["1234", STAMP]] }]);
    expect(res).toEqual({ updated: 1, skipped: 0, failed: 0, failures: [] });
  });

  it("ignores non-X rows entirely (never fetches or writes them)", async () => {
    const h = sheetHarness([
      ["x:1", "announcement", "telegram", "tg1", "u", "posted", "2026-07-20T00:00:00.000Z", "", ""],
      ["x:2", "announcement", "kakao", "kk1", "u", "posted", "2026-07-20T00:00:00.000Z", "", ""],
    ]);
    const s = source([]);

    const res = await new RecordImpressions(h.sheet, s.gw, NOW).run();

    expect(s.seen).toEqual([]); // fetchByIds not called when nothing is eligible
    expect(h.updated).toEqual([]);
    expect(res).toEqual({ updated: 0, skipped: 0, failed: 0, failures: [] });
  });

  it("skips an X row whose postId is empty", async () => {
    const h = sheetHarness([["x:1", "x", "x", "", "u", "posted", "2026-07-20T00:00:00.000Z", "", ""]]);
    const s = source([]);

    const res = await new RecordImpressions(h.sheet, s.gw, NOW).run();

    expect(s.seen).toEqual([]);
    expect(res.updated).toBe(0);
  });

  it("with --since, processes only rows published on or after the cutoff", async () => {
    const h = sheetHarness([
      ["x:old", "x", "x", "twOld", "u", "posted", "2026-07-10T00:00:00.000Z", "", ""],
      ["x:new", "x", "x", "twNew", "u", "posted", "2026-07-20T00:00:00.000Z", "", ""],
    ]);
    const s = source([tweet("twNew", 50)]);

    const res = await new RecordImpressions(h.sheet, s.gw, NOW).run({ since: "2026-07-15" });

    expect(s.seen).toEqual([["twNew"]]); // twOld filtered out before fetch
    expect(h.updated).toEqual([{ range: "history!H3:I3", rows: [["50", STAMP]] }]);
    expect(res).toEqual({ updated: 1, skipped: 0, failed: 0, failures: [] });
  });

  it("skips a row whose tweet the gateway does not return, preserving its existing H/I", async () => {
    const h = sheetHarness([
      ["x:1", "x", "x", "twAlive", "u", "posted", "2026-07-20T00:00:00.000Z", "", ""],
      ["x:2", "x", "x", "twGone", "u", "posted", "2026-07-20T00:00:00.000Z", "old", "oldAt"],
    ]);
    const s = source([tweet("twAlive", 9)]); // twGone omitted (deleted/protected)

    const res = await new RecordImpressions(h.sheet, s.gw, NOW).run();

    expect(h.updated).toEqual([{ range: "history!H2:I2", rows: [["9", STAMP]] }]);
    expect(res).toEqual({ updated: 1, skipped: 1, failed: 0, failures: [] });
  });

  it("skips a tweet with no viewCount rather than writing 0", async () => {
    const h = sheetHarness([["x:1", "x", "x", "tw1", "u", "posted", "2026-07-20T00:00:00.000Z", "", ""]]);
    const s = source([tweet("tw1", undefined)]);

    const res = await new RecordImpressions(h.sheet, s.gw, NOW).run();

    expect(h.updated).toEqual([]);
    expect(res).toEqual({ updated: 0, skipped: 1, failed: 0, failures: [] });
  });

  it("isolates a per-row update failure and still writes the others", async () => {
    const existing = [
      ["x:1", "x", "x", "twA", "u", "posted", "2026-07-20T00:00:00.000Z", "", ""],
      ["x:2", "x", "x", "twB", "u", "posted", "2026-07-20T00:00:00.000Z", "", ""],
    ];
    const updated: { range: string; rows: string[][] }[] = [];
    const sheet: SheetClient = {
      getValues: async () => existing,
      appendValues: async () => {},
      updateValues: async (range, rows) => {
        if (range === "history!H2:I2") throw new Error("boom");
        updated.push({ range, rows });
      },
      createSpreadsheet: async () => ({ spreadsheetId: "x" }),
    };
    const s = source([tweet("twA", 1), tweet("twB", 2)]);

    const res = await new RecordImpressions(sheet, s.gw, NOW).run();

    expect(updated).toEqual([{ range: "history!H3:I3", rows: [["2", STAMP]] }]);
    expect(res.updated).toBe(1);
    expect(res.failed).toBe(1);
    expect(res.failures).toEqual([{ postId: "twA", error: "boom" }]);
  });
});
