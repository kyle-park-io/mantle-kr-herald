// src/cli/kol-roster-migrate.ts
//
// One-shot operator script for the 2026-08-19 kol-quarter-tracking migration: copies `kol-map`'s 13
// rows into the four new columns `LoadKolMap` now reads off `KOL list` (see
// docs/superpowers/specs/2026-08-19-kol-quarter-tracking-design.md, "Migration, done once", step 1).
// `--yes`-gated like `state:pull` (src/cli/state-pull.ts) — the flagless run only ever previews.
//
// MATCHING. A `kol-map` row is matched to a `KOL list` row by comparing `kol-map`'s `tgHandle`
// against the Telegram handle `extractTelegramHandle` can pull out of that row's existing `Social
// media link` cell — the same column and the same parser `LoadKolMap` already uses to read the
// roster (src/app/LoadKolMap.ts). No fallback to a name guess: `KOL list`'s own "KOL" column and
// `kol-map`'s `sheetLabel`/`kolId` are FOUR DIFFERENT SPELLINGS of the same person in this workbook
// (Marine/Marshall, Enjoyhobby/Enjoymyhobby, CEK/Cek — spec §4, "One KOL, four names"), so treating
// any of them as equal would be exactly the kind of guess that corrupts a payment row silently. A row
// this cannot place is reported, never written.
//
// A matched row's `Social media link` cell is filled with the `kol-map` handle **only when that cell
// is blank** — the match itself requires the opposite (a non-blank cell is what the comparison found
// equal), so today this is a no-op on every row this run can place. It stays in, plain and
// unconditional-on-nothing-else, for the day matching stops requiring a pre-existing cell (a fuzzier
// join, or a `KOL list` row a human has already linked by hand) without silently overwriting
// whatever a human already put there.
//
// `kol-map` is not deleted. `--yes` marks its `A1` cell retired; a human who disagrees with a
// placement can still read the old data and correct `KOL list` by hand.
import "./registerErrorHandler";
import { skipIfLocal } from "./skipIfLocal";
import { createGoogleAuth } from "../adapters/drive/createGoogleAuth";
import { GoogleSheetClient } from "../adapters/sheets/GoogleSheetClient";
import type { SheetClient } from "../ports/SheetClient";
import { loadGoogleAuthConfig, loadGoogleSheetConfig } from "../config";
import { KOL_MAP_HEADER } from "../domain/kol/models";
import { extractTelegramHandle } from "../domain/metrics/handles";

skipIfLocal("kol-roster-migrate");

const KOL_MAP_RANGE = "'kol-map'!A:Z";
const KOL_LIST_RANGE = "'KOL list'!A:Z";
const RETIRED_MARK = "(은퇴 — KOL list로 이관)";
const NEW_COLUMN_NAMES = ["kolId", "sheetLabel", "pricePerPost", "active"] as const;

/** 0-based column index → A1 letter. Same shape as ProjectMonthlyLog.ts / RecordKolTelegramPosts.ts. */
function columnLetter(index: number): string {
  let n = index;
  let out = "";
  do {
    out = String.fromCharCode(65 + (n % 26)) + out;
    n = Math.floor(n / 26) - 1;
  } while (n >= 0);
  return out;
}

interface KolMapRow {
  rowNumber: number; // the sheet row this came from, for a human cross-referencing `kol-map` by hand
  kolId: string;
  tgHandle: string;
  sheetLabel: string;
  pricePerPost: string;
  active: string;
}

/** A blank spacer row (no `kolId`) carries nothing to migrate and is dropped, same rule `LoadKolMap` uses. */
function parseKolMap(rows: string[][]): KolMapRow[] {
  if (rows.length === 0) return [];
  const header = rows[0].map((h) => (h ?? "").trim().toLowerCase());
  const indexOf = Object.fromEntries(KOL_MAP_HEADER.map((name) => [name, header.indexOf(name.toLowerCase())])) as Record<
    (typeof KOL_MAP_HEADER)[number],
    number
  >;
  const missing = KOL_MAP_HEADER.filter((name) => indexOf[name] < 0);
  if (missing.length > 0) {
    throw new Error(`'kol-map' is missing required column(s): ${missing.join(", ")}`);
  }
  return rows
    .slice(1)
    .map((row, i) => ({
      rowNumber: i + 2, // the header is sheet row 1
      kolId: (row[indexOf.kolId] ?? "").trim(),
      tgHandle: (row[indexOf.tgHandle] ?? "").trim(),
      sheetLabel: (row[indexOf.sheetLabel] ?? "").trim(),
      pricePerPost: (row[indexOf.pricePerPost] ?? "").trim(),
      active: (row[indexOf.active] ?? "").trim(),
    }))
    .filter((r) => r.kolId !== "");
}

interface KolListIndex {
  header: string[];
  rows: string[][];
  socialLinkCol: number;
  kolNameCol: number; // -1 if the tab has no "KOL" column — only used for a friendlier report line
  /** normalised (lowercase) Telegram handle → 1-based sheet row number */
  handleToRow: Map<string, number>;
}

function indexKolList(rows: string[][]): KolListIndex {
  if (rows.length === 0) throw new Error("'KOL list' has no header row");
  const header = rows[0].map((h) => (h ?? "").trim());
  const socialLinkCol = header.findIndex((h) => h.toLowerCase() === "social media link");
  if (socialLinkCol < 0) throw new Error('\'KOL list\' has no "Social media link" column');
  const kolNameCol = header.findIndex((h) => h.toLowerCase() === "kol");

  const handleToRow = new Map<string, number>();
  const ambiguous = new Set<string>(); // two KOL list rows share a handle — refuse rather than guess which
  rows.slice(1).forEach((row, i) => {
    const rowNumber = i + 2;
    const handle = extractTelegramHandle(row[socialLinkCol] ?? "");
    if (!handle) return;
    const key = handle.toLowerCase();
    if (handleToRow.has(key)) {
      ambiguous.add(key);
      return;
    }
    handleToRow.set(key, rowNumber);
  });
  for (const key of ambiguous) handleToRow.delete(key);

  return { header, rows, socialLinkCol, kolNameCol, handleToRow };
}

interface NewColumns {
  kolId: number;
  sheetLabel: number;
  pricePerPost: number;
  active: number;
  isNew: boolean; // true when these four columns must still be appended to the header
}

/** All four already present → reuse them (a safe, idempotent re-run). None present → append after
 *  the last existing column, in `NEW_COLUMN_NAMES` order. Some but not all → refuse: a partially
 *  hand-edited header is a human's mess to sort out, not this script's to guess at. */
function findNewColumns(header: string[]): NewColumns {
  const find = (name: string) => header.findIndex((h) => h.trim().toLowerCase() === name.toLowerCase());
  const found = Object.fromEntries(NEW_COLUMN_NAMES.map((n) => [n, find(n)])) as Record<(typeof NEW_COLUMN_NAMES)[number], number>;
  const presentCount = Object.values(found).filter((i) => i >= 0).length;
  if (presentCount === NEW_COLUMN_NAMES.length) return { ...found, isNew: false };
  if (presentCount === 0) {
    const base = header.length;
    return { kolId: base, sheetLabel: base + 1, pricePerPost: base + 2, active: base + 3, isNew: true };
  }
  throw new Error(
    `'KOL list' has some but not all of ${NEW_COLUMN_NAMES.join("/")} already (found: ` +
      `${NEW_COLUMN_NAMES.filter((n) => found[n] >= 0).join(", ")}) — fix the header by hand before re-running`,
  );
}

interface Placement {
  kolMapRow: KolMapRow;
  kolListRow: number;
  kolListName: string;
}

function matchRows(kolMap: KolMapRow[], kolList: KolListIndex): { placed: Placement[]; unplaceable: KolMapRow[] } {
  const placed: Placement[] = [];
  const unplaceable: KolMapRow[] = [];
  for (const row of kolMap) {
    const handle = extractTelegramHandle(row.tgHandle);
    const targetRow = handle ? kolList.handleToRow.get(handle.toLowerCase()) : undefined;
    if (targetRow === undefined) {
      unplaceable.push(row);
      continue;
    }
    const kolListName = kolList.kolNameCol >= 0 ? (kolList.rows[targetRow - 1]?.[kolList.kolNameCol] ?? "").trim() : "";
    placed.push({ kolMapRow: row, kolListRow: targetRow, kolListName });
  }
  return { placed, unplaceable };
}

function printPlan(placed: Placement[], unplaceable: KolMapRow[]): void {
  console.log(`kol-roster-migrate: ${placed.length + unplaceable.length} 'kol-map' row(s) read.`);
  console.log();

  console.log(`Placed (${placed.length}) — would fill 'KOL list' row's kolId/sheetLabel/pricePerPost/active` + `, and its Social media link if that cell is blank:`);
  if (placed.length === 0) console.log("  (none)");
  for (const p of placed) {
    console.log(
      `  ${p.kolMapRow.kolId} → 'KOL list' row ${p.kolListRow}` +
        `${p.kolListName ? ` ("${p.kolListName}")` : ""} — sheetLabel=${JSON.stringify(p.kolMapRow.sheetLabel)}, ` +
        `pricePerPost=${JSON.stringify(p.kolMapRow.pricePerPost)}, active=${JSON.stringify(p.kolMapRow.active)}`,
    );
  }
  console.log();

  console.log(
    `Cannot place (${unplaceable.length}) — no 'KOL list' row's Social media link resolves to this handle ` +
      `(reported, not guessed by name):`,
  );
  if (unplaceable.length === 0) console.log("  (none)");
  for (const row of unplaceable) {
    console.log(
      `  ${row.kolId} (kol-map row ${row.rowNumber}, tgHandle=${JSON.stringify(row.tgHandle)}, ` +
        `sheetLabel=${JSON.stringify(row.sheetLabel)}, pricePerPost=${JSON.stringify(row.pricePerPost)}, ` +
        `active=${JSON.stringify(row.active)})`,
    );
  }
}

async function apply(sheet: SheetClient, kolList: KolListIndex, cols: NewColumns, placed: Placement[]): Promise<void> {
  const updates: { range: string; rows: string[][] }[] = [];

  if (cols.isNew) {
    updates.push({
      range: `'KOL list'!${columnLetter(cols.kolId)}1:${columnLetter(cols.active)}1`,
      rows: [[...NEW_COLUMN_NAMES]],
    });
  }

  for (const p of placed) {
    updates.push({
      range: `'KOL list'!${columnLetter(cols.kolId)}${p.kolListRow}:${columnLetter(cols.active)}${p.kolListRow}`,
      rows: [[p.kolMapRow.kolId, p.kolMapRow.sheetLabel, p.kolMapRow.pricePerPost, p.kolMapRow.active]],
    });

    const existingHandleCell = (kolList.rows[p.kolListRow - 1]?.[kolList.socialLinkCol] ?? "").trim();
    if (existingHandleCell === "") {
      updates.push({
        range: `'KOL list'!${columnLetter(kolList.socialLinkCol)}${p.kolListRow}`,
        rows: [[p.kolMapRow.tgHandle]],
      });
    }
  }

  // Always marked, whether or not every row placed: the migration was attempted and `kol-map` is
  // retired code-wise regardless (LoadKolMap has read 'KOL list' since the 2026-08-19 roster move) —
  // this cell is a note to a human glancing at the tab, not a claim that every row moved.
  updates.push({ range: "'kol-map'!A1", rows: [[RETIRED_MARK]] });

  await sheet.batchUpdateValues(updates);
}

const apply_ = process.argv.includes("--yes");

const auth = await createGoogleAuth(loadGoogleAuthConfig());
const sheet = new GoogleSheetClient(auth, loadGoogleSheetConfig().spreadsheetId);

const [kolMapRawRows, kolListRawRows] = await Promise.all([sheet.getValues(KOL_MAP_RANGE), sheet.getValues(KOL_LIST_RANGE)]);

const kolMap = parseKolMap(kolMapRawRows);
const kolList = indexKolList(kolListRawRows);
const cols = findNewColumns(kolList.header);
const { placed, unplaceable } = matchRows(kolMap, kolList);

printPlan(placed, unplaceable);
console.log();

if (!apply_) {
  console.log("Preview only — nothing written. Re-run with --yes to apply the plan above.");
} else {
  await apply(sheet, kolList, cols, placed);
  console.log(
    `Applied: wrote ${placed.length} row(s) into 'KOL list' (${cols.isNew ? "new" : "existing"} kolId/sheetLabel/pricePerPost/active columns), ` +
      `and marked 'kol-map'!A1 retired.`,
  );
}
