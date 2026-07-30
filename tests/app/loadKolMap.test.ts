import { describe, it, expect } from "vitest";
import { LoadKolMap } from "../../src/app/LoadKolMap";
import type { SheetClient } from "../../src/ports/SheetClient";

function sheetWith(rows: string[][]): { sheet: SheetClient; ranges: string[] } {
  const ranges: string[] = [];
  const sheet: SheetClient = {
    getValues: async (range) => { ranges.push(range); return rows; },
    appendValues: async () => {},
    updateValues: async () => {},
    createSpreadsheet: async () => ({ spreadsheetId: "x" }),
    ensureTab: async () => {},
  };
  return { sheet, ranges };
}

const HEADER = ["kolId", "tgHandle", "sheetLabel", "pricePerPost", "active"];

describe("LoadKolMap", () => {
  it("maps columns by header name, not position", async () => {
    const { sheet } = sheetWith([
      ["sheetLabel", "kolId", "active", "tgHandle", "pricePerPost"],
      ["Marine", "marine", "TRUE", "https://t.me/marshallog", "100"],
    ]);
    expect(await new LoadKolMap(sheet).run()).toEqual([
      { kolId: "marine", tgHandle: "marshallog", sheetLabel: "Marine", pricePerPost: 100, active: true },
    ]);
  });

  it("extracts the handle from a url and trims the sheet's stray whitespace", async () => {
    const { sheet } = sheetWith([
      HEADER,
      ["marine", " https://t.me/marshallog", "Marine", "100", "TRUE"],
      ["atm", "https://t.me/Bounty_ATM ", "Airdrop ATM", "100", "TRUE"],
    ]);
    const out = await new LoadKolMap(sheet).run();
    expect(out.map((e) => e.tgHandle)).toEqual(["marshallog", "Bounty_ATM"]);
  });

  it("keeps a fractional price unrounded", async () => {
    // The rate table says Enjoyhobby is 62.5 while the July rows say 63; the map carries 62.5.
    const { sheet } = sheetWith([HEADER, ["enjoyhobby", "https://t.me/enjoymyhobby", "Enjoyhobby", "62.5", "TRUE"]]);
    expect((await new LoadKolMap(sheet).run())[0].pricePerPost).toBe(62.5);
  });

  // Placeholder handles must be at least 5 characters: `extractTelegramHandle` enforces
  // Telegram's real 5-32 rule, so a 3-letter stand-in would be dropped as unusable and the
  // test would pass for the wrong reason.
  it("drops inactive rows so a channel can leave the sweep without losing its row", async () => {
    const { sheet } = sheetWith([
      HEADER,
      ["a", "https://t.me/aaaaa", "A", "10", "TRUE"],
      ["b", "https://t.me/bbbbb", "B", "10", "FALSE"],
      ["c", "https://t.me/ccccc", "C", "10", ""],
    ]);
    expect((await new LoadKolMap(sheet).run()).map((e) => e.kolId)).toEqual(["a"]);
  });

  it("skips a row with no usable handle rather than sweeping a bad url", async () => {
    const { sheet } = sheetWith([
      HEADER,
      ["a", "https://x.com/aaa", "A", "10", "TRUE"],
      ["b", "", "B", "10", "TRUE"],
      ["c", "https://t.me/ccccc", "C", "10", "TRUE"],
    ]);
    expect((await new LoadKolMap(sheet).run()).map((e) => e.kolId)).toEqual(["c"]);
  });

  it("treats a missing or unreadable price as 0 rather than NaN", async () => {
    const { sheet } = sheetWith([HEADER, ["a", "https://t.me/aaaaa", "A", "", "TRUE"]]);
    expect((await new LoadKolMap(sheet).run())[0].pricePerPost).toBe(0);
  });

  it("returns [] for an empty tab", async () => {
    const { sheet } = sheetWith([]);
    expect(await new LoadKolMap(sheet).run()).toEqual([]);
  });

  it("throws a named error when a required column is absent", async () => {
    const { sheet } = sheetWith([["kolId", "sheetLabel"], ["a", "A"]]);
    await expect(new LoadKolMap(sheet).run()).rejects.toThrow(/tgHandle/);
  });
});
