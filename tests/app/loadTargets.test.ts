import { describe, it, expect } from "vitest";
import { LoadTargets } from "../../src/app/LoadTargets";
import type { SheetClient } from "../../src/ports/SheetClient";

function sheet(rows: string[][]): SheetClient {
  return {
    getValues: async () => rows,
    appendValues: async () => {},
    updateValues: async () => {},
    createSpreadsheet: async () => ({ spreadsheetId: "x" }),
  };
}

describe("LoadTargets", () => {
  it("maps data rows to targets (active parsed case-insensitively, notes optional, blank rows skipped)", async () => {
    const uc = new LoadTargets(
      sheet([
        ["telegram", "Mantle KR", "oc_a", "TRUE", "main group"],
        ["x", "Mantle Official", "@Mantle_Official", "false", ""],
        ["", "", "", "", ""], // blank → skipped
      ]),
    );
    const targets = await uc.run();
    expect(targets).toEqual([
      { channel: "telegram", name: "Mantle KR", address: "oc_a", active: true, notes: "main group" },
      { channel: "x", name: "Mantle Official", address: "@Mantle_Official", active: false, notes: undefined },
    ]);
  });

  it("filters to active rows with --active-only", async () => {
    const uc = new LoadTargets(
      sheet([
        ["telegram", "A", "oc_a", "true", ""],
        ["x", "B", "@b", "false", ""],
      ]),
    );
    expect(await uc.run({ activeOnly: true })).toEqual([
      { channel: "telegram", name: "A", address: "oc_a", active: true, notes: undefined },
    ]);
  });
});
