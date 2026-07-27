import { describe, it, expect } from "vitest";
import { formatMeasureReport } from "../../../src/domain/tm/measureReport";

describe("formatMeasureReport", () => {
  it("estimates pages and incremental runs from the post count", () => {
    const msg = formatMeasureReport({ userName: "0xMantleKR", statusesCount: 4316 }, 20, 50);
    expect(msg).toContain("4316");
    expect(msg).toContain("216"); // ceil(4316/20)
    expect(msg).toContain("5");   // ceil(216/50)
  });

  it("degrades gracefully when the count is unknown", () => {
    const msg = formatMeasureReport({ userName: "0xMantleKR" }, 20, 50);
    expect(msg).toContain("unavailable");
    expect(msg).toContain("collect:reference");
  });
});
