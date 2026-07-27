import { describe, it, expect } from "vitest";
import { RecordPublish } from "../../src/app/RecordPublish";
import type { SheetClient } from "../../src/ports/SheetClient";
import type { PublishRecord } from "../../src/domain/sheet/models";
import { HISTORY_HEADER } from "../../src/domain/sheet/models";

function rec(over: Partial<PublishRecord> = {}): PublishRecord {
  return { itemId: "x:1", type: "x", channel: "telegram", status: "posted", publishedAt: "2026-01-01T00:00:00.000Z", ...over };
}

function harness(existingData: string[][] = [], existingHeader: string[][] = []) {
  const calls: {
    appended: string[][][];
    updated: { range: string; rows: string[][] }[];
    ensured: string[];
  } = { appended: [], updated: [], ensured: [] };
  const sheet: SheetClient = {
    // Range-aware: the header check reads A1:I1, the data scan reads A2:G.
    getValues: async (range) => (range.startsWith("history!A1:") ? existingHeader : existingData),
    appendValues: async (_range, rows) => { calls.appended.push(rows); },
    updateValues: async (range, rows) => { calls.updated.push({ range, rows }); },
    createSpreadsheet: async () => ({ spreadsheetId: "x" }),
    ensureTab: async (title) => { calls.ensured.push(title); },
  };
  return { sheet, calls };
}

describe("RecordPublish", () => {
  it("ensures the history tab + header, then appends a new A–G row when no match exists", async () => {
    const h = harness([], []); // fresh workbook: no history tab yet, no header row
    await new RecordPublish(h.sheet).record(rec({ postId: "om_9", url: "https://t.me/x/9" }));
    expect(h.calls.ensured).toEqual(["history"]);
    // header is written because the tab came back empty
    expect(h.calls.updated).toEqual([{ range: "history!A1:I1", rows: [HISTORY_HEADER] }]);
    expect(h.calls.appended).toEqual([[["x:1", "x", "telegram", "om_9", "https://t.me/x/9", "posted", "2026-01-01T00:00:00.000Z"]]]);
  });

  it("does not rewrite the header when it already exists", async () => {
    const h = harness([], [HISTORY_HEADER]);
    await new RecordPublish(h.sheet).record(rec());
    expect(h.calls.ensured).toEqual(["history"]);
    expect(h.calls.updated).toHaveLength(0); // header present → no header write, append-only
    expect(h.calls.appended).toHaveLength(1);
  });

  it("updates only columns A–G of the matching row (preserving impressions H,I)", async () => {
    // header present; data has the match at index 1 → sheet row 3
    const h = harness(
      [
        ["x:0", "x", "telegram", "", "", "posted", "t0"],
        ["x:1", "x", "telegram", "", "", "posted", "old"],
      ],
      [HISTORY_HEADER],
    );
    await new RecordPublish(h.sheet).record(rec({ status: "failed", publishedAt: "t-new" }));
    expect(h.calls.appended).toHaveLength(0);
    expect(h.calls.updated).toEqual([
      { range: "history!A3:G3", rows: [["x:1", "x", "telegram", "", "", "failed", "t-new"]] },
    ]);
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
