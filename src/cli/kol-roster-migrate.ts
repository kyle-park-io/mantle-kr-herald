// src/cli/kol-roster-migrate.ts
//
// One-shot operator script for the 2026-08-19 kol-quarter-tracking migration: copies `kol-map`'s 13
// rows into the four new columns `LoadKolMap` now reads off `KOL list` (see
// docs/superpowers/specs/2026-08-19-kol-quarter-tracking-design.md, "Migration, done once", step 1).
// `--yes`-gated like `state:pull` (src/cli/state-pull.ts) — the flagless run only ever previews.
//
// MATCHING (src/domain/kol/rosterMigration.ts, where the rules live and are tested). A `kol-map`
// row is matched to a `KOL list` row by its Telegram handle first — `kol-map`'s `tgHandle` against
// the handle `extractTelegramHandle` pulls out of that row's `Social media link` cell, the same
// column and parser `LoadKolMap` uses to build the roster — and, only for a row no handle placed,
// by a NORMALISED NAME: `normalizeKolName` (case-folded, whitespace-stripped) over `kol-map`'s
// `sheetLabel` then `kolId` against `KOL list`'s own `KOL` column. That is the same narrow fold
// `SweepKolQuarter` uses to join contract names to the roster, reused rather than re-written.
//
// The name fallback exists because the handle key alone places NOTHING: `Social media link` is
// blank on all 63 live rows, so a handle-only join placed 0 of 13, `LoadKolMap` dropped every row
// for want of a `kolId`, and both `kol:quarter` and `kol-telegram:record` swept an empty roster
// while exiting 0. It is defensible HERE and nowhere else in this feature, because this command
// previews and a human reads every proposed placement before `--yes` writes anything — the preview
// names the key each row matched on, so a wrong name match ("Marine" is not "Marshall") is
// something a reader can catch. Nothing in the weekly sweep joins on a name this way. A row that
// neither key places is reported, never written.
//
// A matched row's `Social media link` cell is filled with the `kol-map` handle **only when that
// cell is blank** — which is now the common case rather than a no-op, since a name-matched row is
// by definition one whose handle cell held nothing usable. A cell a human already filled is never
// overwritten.
//
import "./registerErrorHandler";
import { skipIfLocal } from "./skipIfLocal";
import { createGoogleAuth } from "../adapters/drive/createGoogleAuth";
import { GoogleSheetClient } from "../adapters/sheets/GoogleSheetClient";
import type { SheetClient } from "../ports/SheetClient";
import { loadGoogleAuthConfig, loadGoogleSheetConfig } from "../config";
import {
  parseKolMap,
  indexKolList,
  findNewColumns,
  matchRows,
  planLines,
  NEW_COLUMN_NAMES,
} from "../domain/kol/rosterMigration";
import type { KolListIndex, NewColumns, Placement } from "../domain/kol/rosterMigration";

skipIfLocal("kol-roster-migrate");

const KOL_MAP_RANGE = "'kol-map'!A:Z";
const KOL_LIST_RANGE = "'KOL list'!A:Z";
const RETIRED_MARK = "(은퇴 — KOL list로 이관)";

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

for (const line of planLines(placed, unplaceable)) console.log(line);
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
