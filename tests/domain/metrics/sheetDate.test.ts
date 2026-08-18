import { describe, it, expect } from "vitest";
import { toSheetSerial } from "../../../src/domain/metrics/sheetDate";

/**
 * Google Sheets counts days from 1899-12-30. The expected value is not derived from the formula —
 * it is the integer the live `Jul.` tab already holds for its first logged post (2026-07-03), read
 * with `valueRenderOption=FORMULA` on 2026-08-19. A serial is written rather than a date string
 * because `GoogleSheetClient` writes with `valueInputOption=RAW`, under which "2026-07-03" lands as
 * text in a column of real dates.
 */
describe("toSheetSerial", () => {
  it("matches the serial the live sheet already stores for that date", () => {
    expect(toSheetSerial("2026-07-03")).toBe(46206);
  });

  it("counts whole days, so a later date in the same month steps by one per day", () => {
    expect(toSheetSerial("2026-07-22")).toBe(46225);
  });

  it("reads only the date, ignoring a time and zone on an ISO timestamp", () => {
    expect(toSheetSerial("2026-07-03T09:14:45.000Z")).toBe(46206);
  });

  it("refuses a value that is not a date rather than returning a number for it", () => {
    expect(() => toSheetSerial("not-a-date")).toThrow(/not-a-date/);
  });
});
