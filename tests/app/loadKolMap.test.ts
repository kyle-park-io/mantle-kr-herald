import { describe, it, expect, vi, afterEach } from "vitest";
import { LoadKolMap } from "../../src/app/LoadKolMap";
import type { SheetClient } from "../../src/ports/SheetClient";

afterEach(() => vi.restoreAllMocks());

function sheetWith(rows: string[][]): { sheet: SheetClient; ranges: string[] } {
  const ranges: string[] = [];
  const sheet: SheetClient = {
    getValues: async (range) => { ranges.push(range); return rows; },
    appendValues: async () => {},
    updateValues: async () => {},
    batchUpdateValues: async () => {},
    createSpreadsheet: async () => ({ spreadsheetId: "x" }),
    ensureTab: async () => {},
  };
  return { sheet, ranges };
}

// "Social media link", not "tgHandle": the roster now lives in the humans' `KOL list` tab, whose
// handle column already existed under that name (see LoadKolMap's COL_TG_HANDLE).
const HEADER = ["kolId", "Social media link", "sheetLabel", "pricePerPost", "active"];

describe("LoadKolMap", () => {
  it("maps columns by header name, not position", async () => {
    const { sheet } = sheetWith([
      ["sheetLabel", "kolId", "active", "Social media link", "pricePerPost"],
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

  it("reads a comma-thousands price in full rather than stopping at the comma", async () => {
    // parseFloat("1,000") would silently return 1 — a real price shrunk 1000x, not an obviously
    // wrong one. The contract tab writes prices like "$1,100", so a human seeding kol-map from
    // it typing "1,100" is realistic.
    const { sheet } = sheetWith([HEADER, ["a", "https://t.me/aaaaa", "A", "1,000", "TRUE"]]);
    expect((await new LoadKolMap(sheet).run())[0].pricePerPost).toBe(1000);
  });

  it("rejects a price with a non-numeric suffix rather than parsing its numeric prefix", async () => {
    const { sheet } = sheetWith([HEADER, ["a", "https://t.me/aaaaa", "A", "100원", "TRUE"]]);
    expect((await new LoadKolMap(sheet).run())[0].pricePerPost).toBe(0);
  });

  it("reads every handle form the operator is told to use, not just a full url", async () => {
    // The paste table in docs/ko/kol-map-seed.md lists BARE handles, and the runbook says to fill
    // the tab with "13개 t.me 핸들". Locking the suite to the url form let a documented setup
    // produce a feature that swept nothing.
    const { sheet } = sheetWith([
      HEADER,
      ["enjoyhobby", "enjoymyhobby", "Enjoyhobby", "62.5", "TRUE"],
      ["gmb", "t.me/GMBLABS", "GMB", "75", "TRUE"],
      ["raoni", "@Raoni1", "Raoni", "60", "TRUE"],
      ["marine", "https://t.me/marshallog", "Marine", "100", "TRUE"],
    ]);
    expect((await new LoadKolMap(sheet).run()).map((e) => e.tgHandle)).toEqual([
      "enjoymyhobby", "GMBLABS", "Raoni1", "marshallog",
    ]);
  });

  it("names the row it drops for an unusable handle instead of dropping it silently", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const { sheet } = sheetWith([
      HEADER,
      ["typo", "ht tps://t.me/marshallog", "Marine", "100", "TRUE"],
      ["ok", "coinboys", "Coinboy", "100", "TRUE"],
    ]);
    expect((await new LoadKolMap(sheet).run()).map((e) => e.kolId)).toEqual(["ok"]);
    // Row 2 of the sheet, named, with the cell's contents quoted — a mistyped cell must never be
    // indistinguishable from "this KOL posted nothing about Mantle".
    const message = warn.mock.calls.flat().join(" ");
    expect(message).toMatch(/row 2/);
    expect(message).toMatch(/typo/);
    expect(message).toMatch(/ht tps:\/\/t\.me\/marshallog/);
  });

  it("stays silent about a row that is blank or deliberately inactive", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const { sheet } = sheetWith([
      HEADER,
      ["", "", "", "", ""], // a spacer row
      ["parked", "", "Parked", "100", "FALSE"], // deliberately out of the sweep
    ]);
    expect(await new LoadKolMap(sheet).run()).toEqual([]);
    expect(warn).not.toHaveBeenCalled();
  });

  it("reads a currency-formatted price, because getValues returns FORMATTED_VALUE", async () => {
    // getValues sends no valueRenderOption, so Sheets renders the cell: a rate column formatted as
    // currency arrives as "$100.00", which the whole-string numeric test read as 0 — and because
    // pricePerPost is only ever filled while blank, that 0 was sticky.
    const { sheet } = sheetWith([
      HEADER,
      ["a", "aaaaa", "A", "$100.00", "TRUE"],
      ["b", "bbbbb", "B", "$62.50", "TRUE"],
      ["c", "ccccc", "C", "₩100", "TRUE"],
      ["d", "ddddd", "D", "US$1,100", "TRUE"],
      ["e", "eeeee", "E", " $63 ", "TRUE"],
    ]);
    expect((await new LoadKolMap(sheet).run()).map((e) => e.pricePerPost)).toEqual([100, 62.5, 100, 1100, 63]);
  });

  it("warns, naming the row, when a non-empty price cell cannot be read", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const { sheet } = sheetWith([HEADER, ["a", "aaaaa", "A", "100원", "TRUE"]]);
    expect((await new LoadKolMap(sheet).run())[0].pricePerPost).toBe(0);
    const message = warn.mock.calls.flat().join(" ");
    expect(message).toMatch(/row 2/);
    expect(message).toMatch(/100원/);
  });

  it("does not warn about a blank price, which is a legitimate 'not priced yet'", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const { sheet } = sheetWith([HEADER, ["a", "aaaaa", "A", "", "TRUE"]]);
    expect((await new LoadKolMap(sheet).run())[0].pricePerPost).toBe(0);
    expect(warn).not.toHaveBeenCalled();
  });

  it("says the kol-map tab does not exist instead of surfacing a bare HTTP 400", async () => {
    // The very first real run happens before anyone has created the tab.
    const sheet: SheetClient = {
      getValues: async () => { throw new Error("Sheets getValues failed: HTTP 400"); },
      appendValues: async () => {},
      updateValues: async () => {},
      batchUpdateValues: async () => {},
      createSpreadsheet: async () => ({ spreadsheetId: "x" }),
      ensureTab: async () => {},
    };
    await expect(new LoadKolMap(sheet).run()).rejects.toThrow(/'kol-map' tab does not exist.*kol-map-seed\.md/s);
  });

  it("passes a non-400 sheet error through untouched", async () => {
    const sheet: SheetClient = {
      getValues: async () => { throw new Error("Sheets getValues failed: HTTP 403"); },
      appendValues: async () => {},
      updateValues: async () => {},
      batchUpdateValues: async () => {},
      createSpreadsheet: async () => ({ spreadsheetId: "x" }),
      ensureTab: async () => {},
    };
    await expect(new LoadKolMap(sheet).run()).rejects.toThrow(/HTTP 403/);
  });

  it("returns [] for an empty tab", async () => {
    const { sheet } = sheetWith([]);
    expect(await new LoadKolMap(sheet).run()).toEqual([]);
  });

  it("throws a named error when a required column is absent", async () => {
    const { sheet } = sheetWith([["kolId", "sheetLabel"], ["a", "A"]]);
    await expect(new LoadKolMap(sheet).run()).rejects.toThrow(/tgHandle/);
  });

  /**
   * The roster moved out of the machine-only `kol-map` tab into the humans' `KOL list`, which is
   * what lets a monthly-tab row be resolved through a declared roster instead of a guessed name.
   * `Social media link` was already there and empty, and `extractTelegramHandle` already reads all
   * four spellings a human might put in it, so no new handle column was added.
   */
  it("reads the roster from 'KOL list', taking the handle from Social media link", async () => {
    const { sheet } = sheetWith([
      ["KOL", "KOL Type", "Social media", "Content Price", "Social media link", "Note",
       "kolId", "sheetLabel", "pricePerPost", "active"],
      ["In contract"],
      ["Marshall", "General", "Telegram", "150", "https://t.me/marshallog", "",
       "marine", "Marine", "100", "TRUE"],
      ["Cek", "General", "Telegram", "125", "@airdr0p_lab", "",
       "cek", "CEK", "60", "TRUE"],
    ]);

    const entries = await new LoadKolMap(sheet).run();

    expect(entries).toEqual([
      { kolId: "marine", tgHandle: "marshallog", sheetLabel: "Marine", pricePerPost: 100, active: true },
      { kolId: "cek", tgHandle: "airdr0p_lab", sheetLabel: "CEK", pricePerPost: 60, active: true },
    ]);
  });

  it("skips a section row like 'In contract', which carries no kolId", async () => {
    const { sheet } = sheetWith([
      ["KOL", "Social media link", "kolId", "sheetLabel", "pricePerPost", "active"],
      ["In contract"],
      ["Marshall", "https://t.me/marshallog", "marine", "Marine", "100", "TRUE"],
    ]);
    expect((await new LoadKolMap(sheet).run()).map((e) => e.kolId)).toEqual(["marine"]);
  });
});
