import { describe, it, expect } from "vitest";
import { findLogLayout, logCells } from "../../../src/domain/kol/monthlyLog";

/** The live `Aug.` shape: summary block, two blank rows, then the log header on row 11. */
const AUG = [
  ["KOL", "followers", "Posts", "Views", "Avg.views", "Engagement"],
  ["Raoni", "13,675", "0", "0", "#DIV/0!", "0"],
  [""],
  [""],
  ["KOL", "Social media platform", "Posting date", "Deliverable Link", "Topic",
   "Content Views", "Engagements", "Engagement Rate", "Price per posting",
   "Cost per impression", "Organic", "Duplicated?"],
];

/** `Jul.` heads the same column `Social`, not `Social media platform`. */
const JUL = AUG.map((r, i) => (i === 4 ? r.map((c) => (c === "Social media platform" ? "Social" : c)) : r));

describe("findLogLayout", () => {
  it("finds the header row rather than assuming one", () => {
    expect(findLogLayout(AUG).headerRow).toBe(5);
  });

  /**
   * The summary block above the log grows when a KOL joins the roster, so the header moves. A
   * hardcoded row would then write a post's data on top of somebody's formulas.
   */
  it("still finds it when the summary block above has grown", () => {
    const grown = [AUG[0], AUG[1], AUG[1], AUG[1], AUG[2], AUG[3], AUG[4]];
    expect(findLogLayout(grown).headerRow).toBe(7);
  });

  it("accepts either spelling of the platform column", () => {
    expect(findLogLayout(AUG).columns.social).toBe(1);
    expect(findLogLayout(JUL).columns.social).toBe(1);
  });

  it("maps every logical column to the position it actually sits in", () => {
    expect(findLogLayout(AUG).columns).toEqual({
      kol: 0, social: 1, postedAt: 2, link: 3, topic: 4,
      views: 5, engagements: 6, pricePerPost: 8,
    });
  });

  /** A column inserted by hand shifts the rest; the map must follow, not offset blindly. */
  it("follows a column inserted by a human", () => {
    const shifted = AUG.map((r, i) => (i === 4 ? [r[0], "메모", ...r.slice(1)] : r));
    expect(findLogLayout(shifted).columns.social).toBe(2);
    expect(findLogLayout(shifted).columns.link).toBe(4);
  });

  it("throws when an expected column is missing, naming it", () => {
    const noLink = AUG.map((r, i) => (i === 4 ? r.filter((c) => c !== "Deliverable Link") : r));
    expect(() => findLogLayout(noLink)).toThrow(/Deliverable Link/);
  });

  it("throws when there is no log header at all", () => {
    expect(() => findLogLayout([AUG[0], AUG[1]])).toThrow(/log header/i);
  });
});

describe("logCells", () => {
  const layout = findLogLayout(AUG);

  it("emits only the seven value columns, and the date as a serial", () => {
    const cells = logCells({
      layout, kolLabel: "Marine", postedAt: "2026-07-03T09:14:45.000Z",
      link: "https://t.me/marshallog/22794", views: 2800, engagements: 3, pricePerPost: 100,
    });
    expect(cells).toEqual([
      { column: 0, value: "Marine" },
      { column: 1, value: "Telegram" },
      { column: 2, value: 46206 },
      { column: 3, value: "https://t.me/marshallog/22794" },
      { column: 5, value: 2800 },
      { column: 6, value: 3 },
      { column: 8, value: 100 },
    ]);
  });

  /** Topic is a human column, filled elsewhere and only while blank; the formulas are never ours. */
  it("never emits topic, organic, or a formula column", () => {
    const cells = logCells({
      layout, kolLabel: "Marine", postedAt: "2026-07-03", link: "l",
      views: 1, engagements: 1, pricePerPost: 1,
    });
    expect(cells.map((c) => c.column)).not.toContain(layout.columns.topic);
    for (const forbidden of [7, 9, 10, 11]) expect(cells.map((c) => c.column)).not.toContain(forbidden);
  });
});
