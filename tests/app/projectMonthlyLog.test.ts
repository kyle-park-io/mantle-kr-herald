import { describe, it, expect } from "vitest";
import { ProjectMonthlyLog } from "../../src/app/ProjectMonthlyLog";
import type { SheetClient } from "../../src/ports/SheetClient";

const HEADER = ["KOL", "Social media platform", "Posting date", "Deliverable Link", "Topic",
  "Content Views", "Engagements", "Engagement Rate", "Price per posting",
  "Cost per impression", "Organic", "Duplicated?"];

function harness(existing: string[][]) {
  const batches: { range: string; rows: (string | number)[][] }[] = [];
  const sheet = {
    getValues: async () => existing,
    appendValues: async () => { throw new Error("must not append — rows are addressed by row number"); },
    updateValues: async () => { throw new Error("must not use per-cell updateValues"); },
    batchUpdateValues: async (updates: { range: string; rows: (string | number)[][] }[]) => {
      batches.push(...updates);
    },
    createSpreadsheet: async () => ({ spreadsheetId: "x" }),
    ensureTab: async () => {},
  } as unknown as SheetClient;
  return { sheet, batches };
}

const roster = [
  { kolId: "marine", tgHandle: "marshallog", sheetLabel: "Marine", pricePerPost: 100, active: true },
  { kolId: "gmb", tgHandle: "GMBLABS", sheetLabel: "", pricePerPost: 75, active: true },
];

const post = (over: Record<string, unknown> = {}) => ({
  kolId: "marine", tgHandle: "marshallog", postedAt: "2026-07-03T09:14:45.000Z",
  deliverableLink: "https://t.me/marshallog/22794", views: 2800, engagements: 3,
  reactionsDetail: "", itemId: "", topic: "", matchScore: "", pricePerPost: 100,
  fetchedAt: "", confirmed: "", ...over,
}) as never;

describe("ProjectMonthlyLog", () => {
  it("appends a post the log does not have yet, below the last used row", async () => {
    const h = harness([["KOL", "followers"], ["Marine", "1"], [""], [""], HEADER]);
    const uc = new ProjectMonthlyLog(h.sheet, () => "Jul.");

    const res = await uc.run({ month: "2026-07", roster, posts: [post()] });

    expect(res.written).toBe(1);
    expect(h.batches.map((b) => b.range)).toEqual([
      "Jul.!A6", "Jul.!B6", "Jul.!C6", "Jul.!D6", "Jul.!F6", "Jul.!G6", "Jul.!I6",
    ]);
    expect(h.batches.map((b) => b.rows[0][0])).toEqual([
      "Marine", "Telegram", 46206, "https://t.me/marshallog/22794", 2800, 3, 100,
    ]);
  });

  /** Keyed on the link, like the sheet's own `Duplicated?` formula — never on a name. */
  it("refreshes a post already in the log, in place", async () => {
    const h = harness([
      ["KOL", "followers"], ["Marine", "1"], [""], [""], HEADER,
      ["Marine", "Telegram", "46206", "https://t.me/marshallog/22794", "USPXx Live", "1000", "1", "", "100"],
    ]);
    const uc = new ProjectMonthlyLog(h.sheet, () => "Jul.");

    const res = await uc.run({ month: "2026-07", roster, posts: [post({ views: 2800 })] });

    expect(res.written).toBe(1);
    expect(h.batches.every((b) => b.range.endsWith("6"))).toBe(true);
    expect(h.batches.map((b) => b.range)).not.toContain("Jul.!E6"); // Topic survives
  });

  it("never writes Topic, Organic, or a formula column", async () => {
    const h = harness([["KOL"], [""], [""], HEADER]);
    const uc = new ProjectMonthlyLog(h.sheet, () => "Jul.");
    await uc.run({ month: "2026-07", roster, posts: [post()] });
    for (const col of ["E", "H", "J", "K", "L"]) {
      expect(h.batches.map((b) => b.range).some((r) => r.includes(`!${col}`))).toBe(false);
    }
  });

  /**
   * A KOL with no sheetLabel has no row name in this tab. Writing the kolId would invent a name the
   * summary's COUNTIF has never matched, so the post is reported instead.
   */
  it("reports a post whose KOL has no sheetLabel, and writes nothing for it", async () => {
    const h = harness([["KOL"], [""], [""], HEADER]);
    const uc = new ProjectMonthlyLog(h.sheet, () => "Jul.");

    const res = await uc.run({ month: "2026-07", roster, posts: [post({ kolId: "gmb" })] });

    expect(res.written).toBe(0);
    expect(res.unresolved).toEqual(["gmb"]);
    expect(h.batches).toEqual([]);
  });

  it("is idempotent — a second run writes the same cells and adds no row", async () => {
    const existing = [["KOL"], [""], [""], HEADER];
    const h = harness(existing);
    const uc = new ProjectMonthlyLog(h.sheet, () => "Jul.");
    const first = await uc.run({ month: "2026-07", roster, posts: [post()] });
    const ranges = h.batches.map((b) => b.range);
    h.batches.length = 0;
    // Feed back what the first run wrote, as the sheet would now return it.
    existing.push(["Marine", "Telegram", "46206", "https://t.me/marshallog/22794", "", "2800", "3", "", "100"]);
    const second = await uc.run({ month: "2026-07", roster, posts: [post()] });
    expect(second.written).toBe(first.written);
    expect(h.batches.map((b) => b.range)).toEqual(ranges);
  });
});
