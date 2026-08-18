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
  const batches: { range: string; rows: string[][] }[][] = [];
  const sheet: SheetClient = {
    getValues: async () => existing,
    appendValues: async () => {},
    updateValues: async (range, rows) => {
      updated.push({ range, rows });
    },
    batchUpdateValues: async (updates) => {
      batches.push(updates);
      for (const u of updates) updated.push(u);
    },
    createSpreadsheet: async () => ({ spreadsheetId: "x" }),
    ensureTab: async () => {},
  };
  return { sheet, updated, batches };
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
      fetchUserProfile: async () => ({ userName: "stub" }),
    },
  };
}

describe("RecordImpressions", () => {
  /**
   * The Sheets API allows 60 write requests per minute per user. One `updateValues` per row does not
   * fit inside that: measured against production on 2026-08-19, a 74-row sweep took an HTTP 429 on
   * the last row after three attempts and reported it as a failure. `batchUpdateValues` exists for
   * exactly this — see its doc comment on `SheetClient` — and it keeps the write as narrow as the
   * per-row call was, touching only H and I.
   */
  it("writes every row in one request, not one request per row", async () => {
    const rows = Array.from({ length: 74 }, (_, i) => [
      `x:${i}`, "x", "x", `tw${i}`, "u", "posted", "2026-08-10T00:00:00.000Z", "", "",
    ]);
    const h = sheetHarness(rows);
    const s = source(rows.map((_, i) => tweet(`tw${i}`, 100 + i)));

    const res = await new RecordImpressions(h.sheet, s.gw, NOW).run();

    expect(res.updated).toBe(74);
    expect(h.batches).toHaveLength(1);
    expect(h.batches[0]).toHaveLength(74);
    // Still only H and I — the batch must not widen what a row write touches.
    for (const u of h.batches[0]) expect(u.range).toMatch(/^history!H\d+:I\d+$/);
  });

  it("writes nothing at all when no eligible row has a view count", async () => {
    const h = sheetHarness([["x:1", "x", "x", "tw1", "u", "posted", "2026-07-20T00:00:00.000Z", "", ""]]);
    const s = source([]); // the tweet came back deleted — nothing to record

    const res = await new RecordImpressions(h.sheet, s.gw, NOW).run();

    expect(res.skipped).toBe(1);
    expect(h.batches).toEqual([]);
  });

  it("writes viewCount + timestamp to H/I of the matching X row, and nowhere else", async () => {
    const h = sheetHarness([["x:1", "x", "x", "tw1", "u", "posted", "2026-07-20T00:00:00.000Z", "", ""]]);
    const s = source([tweet("tw1", 1234)]);

    const res = await new RecordImpressions(h.sheet, s.gw, NOW).run();

    expect(s.seen).toEqual([["tw1"]]);
    expect(h.updated).toEqual([{ range: "history!H2:I2", rows: [["1234", STAMP]] }]);
    expect(res).toEqual({ updated: 1, skipped: 0, failed: 0, failures: [] });
  });

  it("writes a viewCount of 0 as \"0\" rather than skipping it", async () => {
    const h = sheetHarness([["x:1", "x", "x", "tw1", "u", "posted", "2026-07-20T00:00:00.000Z", "", ""]]);
    const s = source([tweet("tw1", 0)]);

    const res = await new RecordImpressions(h.sheet, s.gw, NOW).run();

    expect(h.updated).toEqual([{ range: "history!H2:I2", rows: [["0", STAMP]] }]);
    expect(res).toEqual({ updated: 1, skipped: 0, failed: 0, failures: [] });
  });

  it("ignores non-X rows entirely (never fetches or writes them)", async () => {
    const h = sheetHarness([
      ["x:1", "announcement", "telegram", "tg1", "u", "posted", "2026-07-20T00:00:00.000Z", "", ""],
      // Left as `(announcement, kakao)` on purpose: the history sheet is a record of what went out,
      // and rows in that shape are what it holds from before the 공지 split. This path has to go on
      // ignoring them — it filters on the channel column, so the type beside it is incidental.
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

  /**
   * Deliberately replaces an earlier test that pinned per-row failure isolation — one row throwing
   * while the others still wrote. That property was traded away on 2026-08-19 for the batched write,
   * and the trade is one-directional: the isolation guarded a failure mode the Sheets API does not
   * really have (one range refused while its neighbours succeed), while the 429 it cost us was
   * measured in production on a 74-row sweep. One request means one outcome, so every post the
   * batch carried is reported — an operator asking "which posts have no impressions" gets the same
   * answer shape as before.
   */
  it("reports every post in the batch when the single write fails", async () => {
    const existing = [
      ["x:1", "x", "x", "twA", "u", "posted", "2026-07-20T00:00:00.000Z", "", ""],
      ["x:2", "x", "x", "twB", "u", "posted", "2026-07-20T00:00:00.000Z", "", ""],
    ];
    const sheet: SheetClient = {
      getValues: async () => existing,
      appendValues: async () => {},
      updateValues: async () => { throw new Error("must not be called — the write is batched"); },
      batchUpdateValues: async () => { throw new Error("HTTP 429 (after 3 attempts)"); },
      createSpreadsheet: async () => ({ spreadsheetId: "x" }),
      ensureTab: async () => {},
    };
    const s = source([tweet("twA", 1), tweet("twB", 2)]);

    const res = await new RecordImpressions(sheet, s.gw, NOW).run();

    expect(res.updated).toBe(0);
    expect(res.failed).toBe(2);
    expect(res.failures.map((f) => f.postId)).toEqual(["twA", "twB"]);
    expect(res.failures[0].error).toContain("429");
  });
});
