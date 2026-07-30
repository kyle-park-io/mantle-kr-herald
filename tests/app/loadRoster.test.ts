import { describe, it, expect } from "vitest";
import { LoadRoster } from "../../src/app/LoadRoster";
import type { SheetClient } from "../../src/ports/SheetClient";

function sheet(rows: string[][]): SheetClient {
  return {
    getValues: async () => rows,
    appendValues: async () => {},
    updateValues: async () => {},
    batchUpdateValues: async () => {},
    createSpreadsheet: async () => ({ spreadsheetId: "x" }),
    ensureTab: async () => {},
  };
}

describe("LoadRoster", () => {
  it("returns X KOLs by header name (any column order), skipping non-X and section rows", async () => {
    // header order deliberately not A=KOL to prove name-based mapping
    const rows = [
      ["Social media", "KOL", "Note", "Social media link"],
      ["", "In contract", "", ""],                          // section row → skip (no handle)
      ["X", "Marine", "", "https://x.com/marine_x"],        // keep
      ["Telegram", "Coinboy", "", "https://t.me/coinboy"],  // skip (not X)
      ["X", "BadLink", "", ""],                             // skip (blank link)
    ];
    const got = await new LoadRoster(sheet(rows)).run();
    expect(got).toEqual([{ name: "Marine", handle: "marine_x" }]);
  });

  it("throws when a required column is missing", async () => {
    await expect(new LoadRoster(sheet([["KOL", "Note"]])).run()).rejects.toThrow(/Social media/);
  });

  it("returns [] for an empty sheet", async () => {
    expect(await new LoadRoster(sheet([])).run()).toEqual([]);
  });
});
