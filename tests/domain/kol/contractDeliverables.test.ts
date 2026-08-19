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
   * A month block ends where the month's rows do, and the live tab proves it needs saying: row 28
   * of ` Q3 KOL 계약 리스트` opens a `Q3 조정 단가 표` — a pricing table with its own header and its
   * own rows — right below the September block. With no terminator the parser swallowed all of it,
   * and the 2026-08-19 first live run reported fourteen September "targets" like
   * `"500 (최소 8건)": "$63"` and `"$75": "$75"`. Nothing was written to a sheet (a target is
   * report-only), but a reader could not find the three real September rows in the noise.
   *
   * What separates the two: a month block's data rows leave column A blank. The pricing table's
   * rows do not.
   */
  it("ends a block at the next section, so a table below it is not read as that month's rows", () => {
    const out = parseContractDeliverables([
      ["September", "KOL", "Deliverables", "Price", "Contract Status"],
      ["", "Marine", "Monthly (10)", "1000"],
      ["", "Enjoy hobby", "Monthly (8)", "500"],
      [""],
      ["Q3 조정 단가 표"],
      ["KOL", "Q3 조정 금액 (1달)", "Q3 조정 개당 단가", "건당 평균 뷰수(K)", "CPI"],
      ["Enjoy hobby", "500 (최소 8건)", "$63", "3,626"],
      ["GMB", "$75", "$75", "4,071"],
      ["Marine", "1000 (최소 10건)", "$100", "2,331"],
    ], 2026);

    expect(out).toEqual([
      { month: "2026-09", kolName: "Marine", requirement: { kind: "count", count: 10 } },
      { month: "2026-09", kolName: "Enjoy hobby", requirement: { kind: "count", count: 8 } },
    ]);
  });

  /** A blank row inside a block is a spacer, not a terminator — the live tab has them. */
  it("does not end a block on the blank rows the live tab puts between its own rows", () => {
    const out = parseContractDeliverables([
      ["July", "KOL", "Deliverables", "Price"],
      ["", "Marine", "Monthly (10)", "1000"],
      [""],
      ["", "Raoni", "Monthly (unlimited)", "900"],
    ], 2026);

    expect(out.map((t) => t.kolName)).toEqual(["Marine", "Raoni"]);
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
