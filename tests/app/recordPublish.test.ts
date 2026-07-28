import { describe, it, expect } from "vitest";
import { RecordPublish } from "../../src/app/RecordPublish";
import type { SheetClient } from "../../src/ports/SheetClient";
import type { PublishRecord } from "../../src/domain/sheet/models";
import { HISTORY_HEADER } from "../../src/domain/sheet/models";

function rec(over: Partial<PublishRecord> = {}): PublishRecord {
  return { itemId: "x:1", type: "x", channel: "telegram", outletId: "tg-community", status: "posted", publishedAt: "2026-01-01T00:00:00.000Z", ...over };
}
/** A stored row: publish columns A–G, the impression columns H/I, then the room in J. */
const row = (cells: string[], impressions: [string, string] = ["", ""], outletId = "tg-community"): string[] =>
  [...cells, ...impressions, outletId];

function harness(existingData: string[][] = [], existingHeader: string[][] = []) {
  const calls: {
    appended: string[][][];
    updated: { range: string; rows: string[][] }[];
    ensured: string[];
  } = { appended: [], updated: [], ensured: [] };
  const sheet: SheetClient = {
    // Range-aware: the header check reads A1:J1, the data scan reads A2:J.
    getValues: async (range) => (range.startsWith("history!A1:") ? existingHeader : existingData),
    appendValues: async (_range, rows) => { calls.appended.push(rows); },
    updateValues: async (range, rows) => { calls.updated.push({ range, rows }); },
    createSpreadsheet: async () => ({ spreadsheetId: "x" }),
    ensureTab: async (title) => { calls.ensured.push(title); },
  };
  return { sheet, calls };
}

describe("RecordPublish", () => {
  it("ensures the history tab + header, then appends a new row when no match exists", async () => {
    const h = harness([], []); // fresh workbook: no history tab yet, no header row
    await new RecordPublish(h.sheet).record(rec({ postId: "om_9", url: "https://t.me/x/9" }));
    expect(h.calls.ensured).toEqual(["history"]);
    // header is written because the tab came back empty
    expect(h.calls.updated).toEqual([{ range: "history!A1:J1", rows: [HISTORY_HEADER] }]);
    expect(h.calls.appended).toEqual([[
      ["x:1", "x", "telegram", "om_9", "https://t.me/x/9", "posted", "2026-01-01T00:00:00.000Z", "", "", "tg-community"],
    ]]);
  });

  it("does not rewrite the header when it already exists", async () => {
    const h = harness([], [HISTORY_HEADER]);
    await new RecordPublish(h.sheet).record(rec());
    expect(h.calls.ensured).toEqual(["history"]);
    expect(h.calls.updated).toHaveLength(0); // header present → no header write, append-only
    expect(h.calls.appended).toHaveLength(1);
  });

  it("updates only columns A–G of the matching row (preserving impressions H,I and the room in J)", async () => {
    // header present; data has the match at index 1 → sheet row 3
    const h = harness(
      [
        row(["x:0", "x", "telegram", "", "", "posted", "t0"]),
        row(["x:1", "x", "telegram", "", "", "posted", "old"], ["1234", "t-imp"]),
      ],
      [HISTORY_HEADER],
    );
    await new RecordPublish(h.sheet).record(rec({ status: "failed", publishedAt: "t-new" }));
    expect(h.calls.appended).toHaveLength(0);
    expect(h.calls.updated).toEqual([
      { range: "history!A3:G3", rows: [["x:1", "x", "telegram", "", "", "failed", "t-new"]] },
    ]);
  });

  it("gives two rooms on one channel two rows, instead of the second overwriting the first", async () => {
    // The live bug this key change exists for: 맨틀 한국 커뮤니티 and 맨틀 한국 데브방 are both
    // telegram, so a channel-keyed upsert matched 커뮤니티's row when 데브방 was recorded and
    // replaced its postId and t.me url — one row for two real posts, first room's link lost.
    const h = harness([row(["x:1", "announcement", "telegram", "m1", "https://t.me/c/111/1", "posted", "t1"])], [HISTORY_HEADER]);
    await new RecordPublish(h.sheet).record(rec({
      type: "announcement", outletId: "tg-dev", postId: "m2", url: "https://t.me/c/222/2", publishedAt: "t2",
    }));
    expect(h.calls.updated).toHaveLength(0); // 커뮤니티's row is untouched
    expect(h.calls.appended).toEqual([[
      ["x:1", "announcement", "telegram", "m2", "https://t.me/c/222/2", "posted", "t2", "", "", "tg-dev"],
    ]]);
  });

  it("re-records the same room in place — the room is what makes the row, not the run", async () => {
    const h = harness([row(["x:1", "announcement", "telegram", "m1", "u1", "posted", "t1"], ["", ""], "tg-dev")], [HISTORY_HEADER]);
    await new RecordPublish(h.sheet).record(rec({ type: "announcement", outletId: "tg-dev", postId: "m9", url: "u9", publishedAt: "t9" }));
    expect(h.calls.appended).toHaveLength(0);
    expect(h.calls.updated).toEqual([
      { range: "history!A2:G2", rows: [["x:1", "announcement", "telegram", "m9", "u9", "posted", "t9"]] },
    ]);
  });

  it("matches a pre-outlet row (blank J) only for a record that names no room", async () => {
    // Legacy rows written before the room column existed. `history:record` without `--outlet`
    // still updates them; a real send, which always names its room, appends instead.
    const h = harness([[...["x:1", "x", "telegram", "m1", "u1", "posted", "t1"], "", ""]], [HISTORY_HEADER]);
    await new RecordPublish(h.sheet).record(rec({ outletId: undefined, publishedAt: "t2" }));
    expect(h.calls.appended).toHaveLength(0);
    expect(h.calls.updated).toEqual([
      { range: "history!A2:G2", rows: [["x:1", "x", "telegram", "", "", "posted", "t2"]] },
    ]);
  });

  it("matches a pre-outlet row by channel too, so an item on two channels isn't ambiguous", async () => {
    // Reproduces the reviewer's simulated pre-upgrade sheet: both a telegram row and an x row for
    // the same (itemId, type), both with blank outletId (legacy). Recording for channel "x" with no
    // --outlet must land on the x row, not fall through to whichever blank-J row comes first.
    const telegramRow = ["x:1", "announcement", "telegram", "m1", "https://t.me/c/111/1", "posted", "t1", "", "", ""];
    const xRow = ["x:1", "announcement", "x", "999", "https://x.com/…/999", "posted", "t1", "5000", "ti", ""];
    const h = harness([telegramRow, xRow], [HISTORY_HEADER]);
    await new RecordPublish(h.sheet).record(
      rec({ type: "announcement", channel: "x", outletId: undefined, postId: "1000", publishedAt: "t2" }),
    );
    expect(h.calls.appended).toHaveLength(0);
    expect(h.calls.updated).toEqual([
      { range: "history!A3:G3", rows: [["x:1", "announcement", "x", "1000", "", "posted", "t2"]] },
    ]);
    // The telegram row (row 2) must be left byte-identical — never targeted for update.
    expect(h.calls.updated.some((u) => u.range.startsWith("history!A2:"))).toBe(false);
  });

  it("ensures the tab only once across many records on the same instance", async () => {
    const h = harness([], [HISTORY_HEADER]);
    const rp = new RecordPublish(h.sheet);
    await rp.record(rec({ itemId: "x:1" }));
    await rp.record(rec({ itemId: "x:2" }));
    await rp.record(rec({ itemId: "x:3" }));
    expect(h.calls.ensured).toEqual(["history"]); // one ensureTab, not three
    expect(h.calls.appended).toHaveLength(3);
  });
});
