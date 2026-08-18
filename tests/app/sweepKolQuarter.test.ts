import { describe, it, expect } from "vitest";
import {
  monthsOfQuarter,
  tabForMonth,
  countPostsByKolName,
  compareAgainstContract,
  SweepKolQuarter,
} from "../../src/app/SweepKolQuarter";
import type { KolMapEntry, KolTelegramRow } from "../../src/domain/kol/models";
import type { DeliverableTarget } from "../../src/domain/kol/contractDeliverables";
import type { SheetClient } from "../../src/ports/SheetClient";
import type { TelegramChannelGateway } from "../../src/ports/TelegramChannelGateway";

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
  const rosterWith = (...sheetLabels: string[]): KolMapEntry[] =>
    sheetLabels.map((sheetLabel, i) => ({
      kolId: `kol-${i}`, tgHandle: `handle-${i}`, sheetLabel, pricePerPost: 0, active: true,
    }));

  it("reports a shortfall when the actual count is below the requirement", () => {
    const { shortfalls } = compareAgainstContract("2026-07", new Map([["Marine", 4]]), [target()], rosterWith("Marine"));
    expect(shortfalls).toEqual([{ month: "2026-07", kolName: "Marine", actual: 4, required: 10 }]);
  });

  it("reports nothing when the actual count meets or beats the requirement", () => {
    const { shortfalls } = compareAgainstContract("2026-07", new Map([["Marine", 10]]), [target()], rosterWith("Marine"));
    expect(shortfalls).toEqual([]);
  });

  it("treats a roster KOL with no recorded posts this month as a real shortfall of zero", () => {
    const { shortfalls, unmatchedContractNames } = compareAgainstContract(
      "2026-07", new Map(), [target()], rosterWith("Marine"),
    );
    expect(shortfalls).toEqual([{ month: "2026-07", kolName: "Marine", actual: 0, required: 10 }]);
    expect(unmatchedContractNames).toEqual([]);
  });

  /**
   * The Critical this round fixed: `countPostsByKolName` keys on the roster's `sheetLabel`
   * (`"Enjoyhobby"`), but the contract tab spells the same KOL `"Enjoy hobby"`. An exact-string
   * lookup treats those as two different KOLs and reports a fabricated shortfall for the one who
   * actually delivered. The join must be case/whitespace-normalised.
   */
  it("matches a contract name to a roster sheetLabel that differs only by case or whitespace", () => {
    const { shortfalls } = compareAgainstContract(
      "2026-07",
      new Map([["Enjoyhobby", 1]]),
      [target({ kolName: "Enjoy hobby", requirement: { kind: "count", count: 1 } })],
      rosterWith("Enjoyhobby"),
    );
    expect(shortfalls).toEqual([]);
  });

  /**
   * A contract name with no roster row at all (`"Leedogin"`, per the spec) must not be silently
   * treated as zero posts — that is indistinguishable from a real shortfall and would be reported
   * as one. It goes to `unmatchedContractNames` instead, and never appears in `shortfalls`.
   */
  it("routes a contract name with no matching roster entry to unmatchedContractNames, not shortfalls", () => {
    const { shortfalls, unmatchedContractNames } = compareAgainstContract(
      "2026-07",
      new Map(),
      [target({ kolName: "Leedogin", requirement: { kind: "count", count: 12 } })],
      rosterWith("Marine"), // Leedogin is not on this roster at all
    );
    expect(shortfalls).toEqual([]);
    expect(unmatchedContractNames).toEqual([{ month: "2026-07", kolName: "Leedogin", required: 12 }]);
  });

  it("produces nothing for an unlimited requirement", () => {
    const { shortfalls, unknownTargets } = compareAgainstContract(
      "2026-07", new Map(), [target({ requirement: { kind: "unlimited" } })], rosterWith("Marine"),
    );
    expect(shortfalls).toEqual([]);
    expect(unknownTargets).toEqual([]);
  });

  it("routes an unreadable requirement to unknownTargets instead of comparing it", () => {
    const { shortfalls, unknownTargets } = compareAgainstContract(
      "2026-07", new Map([["Coinboy", 3]]),
      [target({ kolName: "Coinboy", requirement: { kind: "unreadable", raw: "매월 5회" } })],
      rosterWith("Coinboy"),
    );
    expect(shortfalls).toEqual([]);
    expect(unknownTargets).toEqual([{ month: "2026-07", kolName: "Coinboy", raw: "매월 5회" }]);
  });

  it("ignores a target from a different month", () => {
    const { shortfalls, unknownTargets } = compareAgainstContract(
      "2026-08", new Map(), [target({ month: "2026-07" })], rosterWith("Marine"),
    );
    expect(shortfalls).toEqual([]);
    expect(unknownTargets).toEqual([]);
  });
});

/**
 * A fake `SheetClient` backed by fixture rows per tab, keyed on the tab name parsed out of the A1
 * range (quotes stripped). Mocks nothing about `SweepKolQuarter`'s collaborators — `LoadKolMap`,
 * `parseContractDeliverables`, `RecordKolTelegramPosts`, and `ProjectMonthlyLog` all run for real
 * against these rows, exactly as they would against a live workbook. Only the transport is fake.
 */
function fixtureSheet(tabs: Record<string, string[][]>): SheetClient {
  const store = new Map(Object.entries(tabs).map(([tab, rows]) => [tab, rows.map((r) => [...r])]));
  const tabOf = (range: string): string => {
    const name = range.slice(0, range.indexOf("!"));
    return name.startsWith("'") && name.endsWith("'") ? name.slice(1, -1) : name;
  };
  return {
    getValues: async (range) => {
      const rows = store.get(tabOf(range)) ?? [];
      if (/!A1:[A-Z]+1$/.test(range)) return rows[0] ? [rows[0]] : []; // a header-only probe
      if (/!A2:/.test(range)) return rows.slice(1); // a data-only read, header excluded
      return rows; // a wide "A:Z" read: header and data both
    },
    appendValues: async (range, rows) => {
      const tab = tabOf(range);
      store.set(tab, [...(store.get(tab) ?? []), ...rows.map((r) => [...r])]);
    },
    updateValues: async () => {}, // only exercised for the kol-telegram-posts header, already present here
    batchUpdateValues: async () => {}, // ProjectMonthlyLog's cell writes — not this test's concern
    createSpreadsheet: async () => ({ spreadsheetId: "x" }),
    ensureTab: async () => {},
  };
}

/** No channel ever has anything new to report — keeps every seeded `kol-telegram-posts` row exactly
 *  as fixtured, so the sweep's RecordKolTelegramPosts pass cannot change what this test is counting. */
const quietGateway: TelegramChannelGateway = {
  fetchPostsInWindow: async () => ({ posts: [], truncated: false }),
};

const KOL_LIST_HEADER_ROW = ["kolId", "Social media link", "sheetLabel", "pricePerPost", "active"];
const KOL_TELEGRAM_HEADER_ROW = [
  "kolId", "tgHandle", "postedAt", "deliverableLink", "views", "engagements",
  "reactionsDetail", "itemId", "topic", "matchScore", "pricePerPost", "fetchedAt", "confirmed",
];
const MONTHLY_LOG_HEADER_ROW = [
  "KOL", "Social media platform", "Posting date", "Deliverable Link", "Topic",
  "Content Views", "Engagements", "Engagement Rate", "Price per posting",
  "Cost per impression", "Organic", "Duplicated?",
];

/**
 * Fixture rows taken from the spec's own live-data example: the contract tab spells one KOL
 * `"Enjoy hobby"`, the roster's `sheetLabel` for the same KOL is `"Enjoyhobby"`, and the contract
 * also lists `"Leedogin"`, who has no roster row at all.
 */
function quarterFixtureTabs(): Record<string, string[][]> {
  return {
    "KOL list": [
      KOL_LIST_HEADER_ROW,
      ["marine", "https://t.me/marshallog", "Marine", "100", "TRUE"],
      ["gmb", "https://t.me/GMBLABS", "GMB", "75", "TRUE"],
      ["enjoyhobby", "https://t.me/enjoymyhobby", "Enjoyhobby", "62.5", "TRUE"],
      // Leedogin: deliberately absent — the contract names a KOL this roster does not carry.
    ],
    " Q3 KOL 계약 리스트": [
      ["Q3 Budget", "$10,000", "Current Expense", "10000", "Remained", "$0"],
      [""],
      ["July", "KOL", "Deliverables", "Price", "Contract Status", "Tx"],
      ["", "Marine", "Monthly (2)", "1000", "Solved", ""],
      ["", "GMB", "Monthly (1)", "600", "Non solved"],
      ["", "Enjoy hobby", "Monthly (1)", "500", "Non solved"],
      ["", "Leedogin", "TG (12)", "1100", "Non solved"],
      [""],
      ["August", "KOL", "Deliverables", "Price", "Contract Status", "Tx"],
      ["", "Marine", "Monthly (10)", "1000"],
    ],
    "kol-telegram-posts": [
      KOL_TELEGRAM_HEADER_ROW,
      ["marine", "marshallog", "2026-07-03T09:14:45.000Z", "https://t.me/marshallog/1", "100", "5", "", "", "", "", "100", "", ""],
      ["marine", "marshallog", "2026-07-10T09:14:45.000Z", "https://t.me/marshallog/2", "120", "6", "", "", "", "", "100", "", ""],
      ["enjoyhobby", "enjoymyhobby", "2026-07-05T09:14:45.000Z", "https://t.me/enjoymyhobby/1", "50", "2", "", "", "", "", "62.5", "", ""],
      // gmb: no posts at all this quarter — its July requirement is a genuine, real shortfall.
    ],
    "Jul.": [["KOL", "followers"], ["Marine", "1"], [""], [""], MONTHLY_LOG_HEADER_ROW],
    "Aug.": [["KOL", "followers"], ["Marine", "1"], [""], [""], MONTHLY_LOG_HEADER_ROW],
    "Sep.": [["KOL", "followers"], ["Marine", "1"], [""], [""], MONTHLY_LOG_HEADER_ROW],
  };
}

describe("SweepKolQuarter (fixture integration — mocks no collaborator, only the sheet transport)", () => {
  it("joins the contract's KOL names to the roster's sheetLabel, normalised, instead of fabricating shortfalls", async () => {
    const sheet = fixtureSheet(quarterFixtureTabs());
    const sweep = new SweepKolQuarter(sheet, quietGateway);

    const report = await sweep.run({ quarter: "2026-Q3", renderings: [] });

    // Marine met July's requirement (2 posts, 2 required) — no shortfall.
    expect(report.shortfalls).not.toContainEqual(expect.objectContaining({ kolName: "Marine", month: "2026-07" }));

    // "Enjoy hobby" (contract spelling) resolves to "Enjoyhobby" (roster spelling) and that KOL's
    // one real July post satisfies the one-post requirement — the Critical this fixes: an exact
    // string match here reports a fabricated shortfall for a KOL who actually delivered.
    expect(report.shortfalls).not.toContainEqual(expect.objectContaining({ kolName: "Enjoy hobby" }));

    // GMB has a roster row but zero posts — this is a *real* shortfall, and normalising the join
    // must not turn it into "unmatched" or make it disappear.
    expect(report.shortfalls).toContainEqual({ month: "2026-07", kolName: "GMB", actual: 0, required: 1 });

    // Marine's August requirement (10) has no August posts recorded this quarter — also real.
    expect(report.shortfalls).toContainEqual({ month: "2026-08", kolName: "Marine", actual: 0, required: 10 });

    // Leedogin has no roster row under any spelling — reported as unmatched, never as a shortfall of
    // zero. Before this fix, an unresolved name and a real zero were the same code path.
    expect(report.unmatchedContractNames).toEqual([{ month: "2026-07", kolName: "Leedogin", required: 12 }]);
    expect(report.shortfalls).not.toContainEqual(expect.objectContaining({ kolName: "Leedogin" }));

    expect(report.contractError).toBeUndefined();
  });

  it("surfaces each month's underlying Telegram-sweep counters instead of discarding them", async () => {
    const sheet = fixtureSheet(quarterFixtureTabs());
    const report = await new SweepKolQuarter(sheet, quietGateway).run({ quarter: "2026-Q3", renderings: [] });

    expect(report.months).toHaveLength(3);
    for (const m of report.months) {
      expect(m.recorded).toEqual(
        expect.objectContaining({
          created: expect.any(Number),
          refreshed: expect.any(Number),
          channelsSwept: expect.any(Number),
          channelsFailed: expect.any(Number),
          channelsTruncated: expect.any(Number),
        }),
      );
    }
  });

  it("reports a channel failure through the surfaced counters rather than swallowing it", async () => {
    const failingGateway: TelegramChannelGateway = {
      fetchPostsInWindow: async (handle) => {
        if (handle === "marshallog") throw new Error("channel unreadable");
        return { posts: [], truncated: false };
      },
    };
    const sheet = fixtureSheet(quarterFixtureTabs());
    const report = await new SweepKolQuarter(sheet, failingGateway).run({ quarter: "2026-Q3", renderings: [] });

    const july = report.months.find((m) => m.month === "2026-07")!;
    expect(july.recorded.channelsFailed).toBeGreaterThan(0);
  });

  it("degrades to a distinctly-reported 'targets unavailable' rather than a false all-clear when the contract tab cannot be read", async () => {
    const tabs = quarterFixtureTabs();
    delete tabs[" Q3 KOL 계약 리스트"]; // getValues on this tab now returns [] — parseContractDeliverables throws
    const sheet = fixtureSheet(tabs);

    const report = await new SweepKolQuarter(sheet, quietGateway).run({ quarter: "2026-Q3", renderings: [] });

    expect(report.contractError).toBeTruthy();
    expect(report.shortfalls).toEqual([]);
    expect(report.unknownTargets).toEqual([]);
    expect(report.unmatchedContractNames).toEqual([]);
  });
});
