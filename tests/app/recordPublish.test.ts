import { describe, it, expect } from "vitest";
import { RecordPublish } from "../../src/app/RecordPublish";
import type { SheetClient } from "../../src/ports/SheetClient";
import type { PublishRecord } from "../../src/domain/sheet/models";

function rec(over: Partial<PublishRecord> = {}): PublishRecord {
  return { itemId: "x:1", type: "x", channel: "telegram", status: "posted", publishedAt: "2026-01-01T00:00:00.000Z", ...over };
}

function harness(existing: string[][] = []) {
  const calls: { appended: string[][][]; updated: { range: string; rows: string[][] }[] } = { appended: [], updated: [] };
  const sheet: SheetClient = {
    getValues: async () => existing,
    appendValues: async (_range, rows) => { calls.appended.push(rows); },
    updateValues: async (range, rows) => { calls.updated.push({ range, rows }); },
    createSpreadsheet: async () => ({ spreadsheetId: "x" }),
  };
  return { sheet, calls };
}

describe("RecordPublish", () => {
  it("appends a new A–G row when no (itemId,type,channel) match exists", async () => {
    const h = harness([]);
    await new RecordPublish(h.sheet).record(rec({ postId: "om_9", url: "https://t.me/x/9" }));
    expect(h.calls.appended).toEqual([[["x:1", "x", "telegram", "om_9", "https://t.me/x/9", "posted", "2026-01-01T00:00:00.000Z"]]]);
    expect(h.calls.updated).toHaveLength(0);
  });

  it("updates only columns A–G of the matching row (preserving impressions H,I)", async () => {
    // row 1 = header (not read here: getValues returns data rows A2:G); existing data has the match at index 1 → sheet row 3
    const h = harness([
      ["x:0", "x", "telegram", "", "", "posted", "t0"],
      ["x:1", "x", "telegram", "", "", "posted", "old"],
    ]);
    await new RecordPublish(h.sheet).record(rec({ status: "failed", publishedAt: "t-new" }));
    expect(h.calls.appended).toHaveLength(0);
    expect(h.calls.updated).toEqual([
      { range: "history!A3:G3", rows: [["x:1", "x", "telegram", "", "", "failed", "t-new"]] },
    ]);
  });
});
