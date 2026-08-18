import { describe, it, expect } from "vitest";
import {
  monthsOfQuarter,
  tabForMonth,
  countPostsByKolName,
  compareAgainstContract,
} from "../../src/app/SweepKolQuarter";
import type { KolMapEntry, KolTelegramRow } from "../../src/domain/kol/models";
import type { DeliverableTarget } from "../../src/domain/kol/contractDeliverables";

describe("monthsOfQuarter", () => {
  it("expands a quarter into its three months", () => {
    expect(monthsOfQuarter("2026-Q3")).toEqual(["2026-07", "2026-08", "2026-09"]);
    expect(monthsOfQuarter("2026-Q1")).toEqual(["2026-01", "2026-02", "2026-03"]);
  });

  it("refuses anything that is not a quarter, rather than sweeping a guess", () => {
    expect(() => monthsOfQuarter("2026-07")).toThrow(/quarter/i);
    expect(() => monthsOfQuarter("2026-Q5")).toThrow(/quarter/i);
  });
});

// `tabForMonth` decides which live tab every write in the sweep lands on — a wrong mapping here
// would silently write one month's posts into another month's log.
describe("tabForMonth", () => {
  it("maps the quarter's months to the live tabs' actual names, trailing dot included", () => {
    expect(tabForMonth("2026-07")).toBe("Jul.");
    expect(tabForMonth("2026-08")).toBe("Aug.");
    expect(tabForMonth("2026-09")).toBe("Sep.");
  });

  it("refuses anything that is not a YYYY-MM month", () => {
    expect(() => tabForMonth("2026-Q3")).toThrow(/month/i);
    expect(() => tabForMonth("2026-13")).toThrow(/month/i);
  });
});

// Extracted per the controller's ruling: this is the one piece of real logic the orchestrator would
// otherwise carry, so it gets its own pure-data test instead of living untested inside `.run()`.
describe("countPostsByKolName", () => {
  const roster: KolMapEntry[] = [
    { kolId: "marine", tgHandle: "marshallog", sheetLabel: "Marine", pricePerPost: 100, active: true },
    { kolId: "gmb", tgHandle: "GMBLABS", sheetLabel: "", pricePerPost: 75, active: true },
  ];
  const post = (over: Partial<KolTelegramRow> = {}): KolTelegramRow => ({
    kolId: "marine", tgHandle: "marshallog", postedAt: "2026-07-03T09:14:45.000Z",
    deliverableLink: "https://t.me/marshallog/1", views: 0, engagements: 0, reactionsDetail: "",
    itemId: "", topic: "", matchScore: "", pricePerPost: "", fetchedAt: "", confirmed: "", ...over,
  });

  it("counts one deliverable per distinct link, keyed on the roster's sheetLabel", () => {
    const counts = countPostsByKolName(
      [post({ deliverableLink: "https://t.me/marshallog/1" }), post({ deliverableLink: "https://t.me/marshallog/2" })],
      roster,
    );
    expect(counts.get("Marine")).toBe(2);
  });

  it("does not double-count two posts sharing one deliverableLink", () => {
    const counts = countPostsByKolName(
      [post({ deliverableLink: "https://t.me/marshallog/1" }), post({ deliverableLink: "https://t.me/marshallog/1" })],
      roster,
    );
    expect(counts.get("Marine")).toBe(1);
  });

  it("skips a post whose KOL has no sheetLabel, same as ProjectMonthlyLog's unresolved", () => {
    const counts = countPostsByKolName([post({ kolId: "gmb" })], roster);
    expect(counts.has("")).toBe(false);
    expect(counts.size).toBe(0);
  });
});

describe("compareAgainstContract", () => {
  const target = (over: Partial<DeliverableTarget> = {}): DeliverableTarget => ({
    month: "2026-07", kolName: "Marine", requirement: { kind: "count", count: 10 }, ...over,
  });

  it("reports a shortfall when the actual count is below the requirement", () => {
    const { shortfalls } = compareAgainstContract("2026-07", new Map([["Marine", 4]]), [target()]);
    expect(shortfalls).toEqual([{ month: "2026-07", kolName: "Marine", actual: 4, required: 10 }]);
  });

  it("reports nothing when the actual count meets or beats the requirement", () => {
    const { shortfalls } = compareAgainstContract("2026-07", new Map([["Marine", 10]]), [target()]);
    expect(shortfalls).toEqual([]);
  });

  it("treats a KOL with no recorded posts at all as zero, not as absent", () => {
    const { shortfalls } = compareAgainstContract("2026-07", new Map(), [target()]);
    expect(shortfalls).toEqual([{ month: "2026-07", kolName: "Marine", actual: 0, required: 10 }]);
  });

  it("produces nothing for an unlimited requirement", () => {
    const { shortfalls, unknownTargets } = compareAgainstContract(
      "2026-07", new Map(), [target({ requirement: { kind: "unlimited" } })],
    );
    expect(shortfalls).toEqual([]);
    expect(unknownTargets).toEqual([]);
  });

  it("routes an unreadable requirement to unknownTargets instead of comparing it", () => {
    const { shortfalls, unknownTargets } = compareAgainstContract(
      "2026-07", new Map([["Coinboy", 3]]),
      [target({ kolName: "Coinboy", requirement: { kind: "unreadable", raw: "매월 5회" } })],
    );
    expect(shortfalls).toEqual([]);
    expect(unknownTargets).toEqual([{ month: "2026-07", kolName: "Coinboy", raw: "매월 5회" }]);
  });

  it("ignores a target from a different month", () => {
    const { shortfalls, unknownTargets } = compareAgainstContract(
      "2026-08", new Map(), [target({ month: "2026-07" })],
    );
    expect(shortfalls).toEqual([]);
    expect(unknownTargets).toEqual([]);
  });
});
