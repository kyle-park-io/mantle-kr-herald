import { describe, it, expect } from "vitest";
import {
  parseKolMap,
  indexKolList,
  matchRows,
  findNewColumns,
  planLines,
} from "../../../src/domain/kol/rosterMigration";

const KOL_MAP = [
  ["kolId", "tgHandle", "sheetLabel", "pricePerPost", "active"],
  ["marine", "marshallog", "Marine", "100", "TRUE"],
  ["cek", "airdr0p_lab", "CEK", "80", "TRUE"],
];

/** The live tab's real shape: `Social media link` (L) exists and is **blank on all 63 rows**. */
const KOL_LIST = (over: Partial<{ links: string[]; names: string[] }> = {}) => {
  const names = over.names ?? ["Marshall", "Cek"];
  const links = over.links ?? ["", ""];
  return [
    ["KOL", "Content Price", "Social media link", "Note"],
    ...names.map((name, i) => [name, "150", links[i] ?? "", ""]),
  ];
};

describe("parseKolMap", () => {
  it("reads every row that carries a kolId, and drops blank spacers", () => {
    const rows = parseKolMap([...KOL_MAP, ["", "", "", "", ""]]);
    expect(rows.map((r) => r.kolId)).toEqual(["marine", "cek"]);
    expect(rows[0]!.rowNumber).toBe(2);
  });
});

describe("matchRows", () => {
  /** The handle stays the preferred key: it is an identifier, not a spelling of a name. */
  it("matches on the handle in Social media link when that cell carries one", () => {
    const list = indexKolList(KOL_LIST({ links: ["https://t.me/marshallog", ""] }));
    const { placed } = matchRows(parseKolMap(KOL_MAP), list);
    const marine = placed.find((p) => p.kolMapRow.kolId === "marine");
    expect(marine?.kolListRow).toBe(2);
    expect(marine?.matchedBy).toBe("handle"); // not "sheetLabel" — the handle is the preferred key
  });

  /**
   * The Critical: `Social media link` is blank on all 63 live rows, so a handle-only join places 0
   * of 13 and `LoadKolMap` then drops every row for want of a `kolId` — the roster is `[]` on merge
   * day and the weekly timer reports success forever while sweeping nothing.
   *
   * The fallback is defensible *here* and nowhere else in this feature: the migration previews every
   * proposed placement and a human reads them before `--yes` writes anything.
   */
  it("falls back to a normalised name when no row's Social media link resolves to the handle", () => {
    const list = indexKolList(KOL_LIST()); // every link cell blank, as live
    const { placed, unplaceable } = matchRows(parseKolMap(KOL_MAP), list);

    // "CEK" (kol-map) vs "Cek" (KOL list) — a case difference, not a different person.
    const cek = placed.find((p) => p.kolMapRow.kolId === "cek");
    expect(cek?.kolListRow).toBe(3);
    expect(cek?.matchedBy).toBe("sheetLabel");

    // "Marine" vs "Marshall" is a genuinely different name — normalising must not reach it.
    expect(unplaceable.map((r) => r.kolId)).toEqual(["marine"]);
  });

  it("matches on kolId when that is the spelling the KOL list carries", () => {
    const list = indexKolList(KOL_LIST({ names: ["Marshall", "airdr0p"] }));
    const kolMap = [...KOL_MAP, ["airdr0p", "airdrop_two", "Airdrop Two", "10", "TRUE"]];
    const { placed } = matchRows(parseKolMap(kolMap), list);
    const hit = placed.find((p) => p.kolMapRow.kolId === "airdr0p");
    expect(hit?.matchedBy).toBe("kolId");
  });

  /** Two rows must never land on one `KOL list` row: the second write would overwrite the first. */
  it("never lets a name match take a row a handle match already claimed", () => {
    const list = indexKolList(KOL_LIST({ names: ["Cek", "Other"], links: ["", "https://t.me/airdr0p_lab"] }));
    const { placed, unplaceable } = matchRows(parseKolMap(KOL_MAP), list);
    const cek = placed.find((p) => p.kolMapRow.kolId === "cek");
    expect(cek?.matchedBy).toBe("handle");
    expect(cek?.kolListRow).toBe(3); // the handle's row, not the same-name row 2
    expect(unplaceable.map((r) => r.kolId)).toEqual(["marine"]);
  });

  it("refuses a name two KOL list rows share, rather than guessing which one", () => {
    const list = indexKolList(KOL_LIST({ names: ["Cek", "cek"] }));
    const { placed, unplaceable } = matchRows(parseKolMap(KOL_MAP), list);
    expect(placed).toEqual([]);
    expect(unplaceable.map((r) => r.kolId)).toEqual(["marine", "cek"]);
  });
});

describe("planLines", () => {
  /** A human reads every proposed placement before `--yes`, so the preview has to say which key
   *  matched — a wrong name match is only spottable if the reader can see it was a name match. */
  it("names the key each placement matched on", () => {
    const list = indexKolList(KOL_LIST({ links: ["https://t.me/marshallog", ""] }));
    const { placed, unplaceable } = matchRows(parseKolMap(KOL_MAP), list);
    const text = planLines(placed, unplaceable).join("\n");
    expect(text).toMatch(/matched by handle/);
    expect(text).toMatch(/matched by name/);
    expect(text).toMatch(/"Cek"/); // the KOL list spelling the name matched against
  });
});

describe("findNewColumns", () => {
  it("appends the four columns after the last existing one when none are present", () => {
    const cols = findNewColumns(["KOL", "Content Price", "Social media link", "Note"]);
    expect(cols).toEqual({ kolId: 4, sheetLabel: 5, pricePerPost: 6, active: 7, isNew: true });
  });

  it("refuses a header carrying only some of them", () => {
    expect(() => findNewColumns(["KOL", "kolId"])).toThrow(/some but not all/i);
  });
});
