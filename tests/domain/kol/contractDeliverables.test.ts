import { describe, it, expect } from "vitest";
import { parseContractDeliverables } from "../../../src/domain/kol/contractDeliverables";

const LIVE = [
  ["Q3 Budget", "$10,000", "Current Expense", "10000", "Remained", "$0"],
  [""],
  ["July", "KOL", "Deliverables", "Price", "Contract Status", "Tx"],
  ["", "Marine", "Monthly (10)", "1000", "Soloved", "https://etherscan.io/tx/0x97c0"],
  ["", "Raoni", "Monthly (unlimited)", "900", "Soloved", ""],
  ["", "Enjoy hobby", "Monthly (8)", "500", "Non soloved"],
  ["", "GMB", "TG (8)", "600", "Non soloved"],
  ["", " Leedogin", "TG (12)", "1100", "Non soloved"],
  [""],
  [""],
  ["August", "KOL", "Deliverables", "Price", "Contract Status", "Tx"],
  ["", "Marine", "Monthly (10)", "1000"],
  ["", "Coinboy", "매월 5회", "500"],
];

describe("parseContractDeliverables", () => {
  it("reads a count out of both spellings of the deliverable", () => {
    const out = parseContractDeliverables(LIVE, 2026);
    expect(out).toContainEqual({ month: "2026-07", kolName: "Marine", requirement: { kind: "count", count: 10 } });
    expect(out).toContainEqual({ month: "2026-07", kolName: "GMB", requirement: { kind: "count", count: 8 } });
  });

  /** `unlimited` is a real contract state — no target — not a parse failure. */
  it("reads unlimited as its own state", () => {
    const out = parseContractDeliverables(LIVE, 2026);
    expect(out).toContainEqual({ month: "2026-07", kolName: "Raoni", requirement: { kind: "unlimited" } });
  });

  it("carries an unreadable deliverable through as unreadable, with the text that confused it", () => {
    const out = parseContractDeliverables(LIVE, 2026);
    expect(out).toContainEqual({
      month: "2026-08", kolName: "Coinboy", requirement: { kind: "unreadable", raw: "매월 5회" },
    });
  });

  it("attributes each row to the month block above it, not to the first block", () => {
    const out = parseContractDeliverables(LIVE, 2026);
    const marine = out.filter((t) => t.kolName === "Marine").map((t) => t.month);
    expect(marine).toEqual(["2026-07", "2026-08"]);
  });

  it("trims the stray leading space the live tab has on one name", () => {
    const out = parseContractDeliverables(LIVE, 2026);
    expect(out.some((t) => t.kolName === "Leedogin")).toBe(true);
  });

  it("ignores the budget header and the blank separator rows", () => {
    const out = parseContractDeliverables(LIVE, 2026);
    expect(out.some((t) => t.kolName === "" || t.kolName === "KOL" || t.kolName === "Q3 Budget")).toBe(false);
  });

  /**
   * Refusing beats mis-attributing. If the month headers are gone, every row would otherwise be
   * filed under whatever block the parser last saw — or under none — and a count silently attached
   * to the wrong month is worse than no count at all.
   */
  it("throws when no month block can be recognised", () => {
    expect(() => parseContractDeliverables([["KOL", "Deliverables"], ["Marine", "Monthly (10)"]], 2026))
      .toThrow(/month/i);
  });
});
