import { describe, it, expect } from "vitest";
import { currentMonth, monthWindow } from "../../../src/domain/metrics/window";

describe("currentMonth", () => {
  it("formats YYYY-MM in UTC", () => {
    expect(currentMonth(new Date("2026-07-15T09:00:00Z"))).toBe("2026-07");
    expect(currentMonth(new Date("2026-01-01T00:00:00Z"))).toBe("2026-01");
  });
});

describe("monthWindow", () => {
  it("returns the UTC month bounds, end exclusive", () => {
    expect(monthWindow("2026-07")).toEqual({
      month: "2026-07",
      startISO: "2026-07-01T00:00:00.000Z",
      endExclusiveISO: "2026-08-01T00:00:00.000Z",
    });
  });
  it("rolls December into next January", () => {
    expect(monthWindow("2026-12").endExclusiveISO).toBe("2027-01-01T00:00:00.000Z");
  });
  it("rejects a malformed or out-of-range month", () => {
    expect(() => monthWindow("2026-7")).toThrow();
    expect(() => monthWindow("2026-13")).toThrow();
    expect(() => monthWindow("nope")).toThrow();
  });
});
