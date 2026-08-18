// src/domain/kol/rosterMigration.ts
//
// The pure half of `pnpm kol-roster-migrate` (src/cli/kol-roster-migrate.ts): which `kol-map` row
// belongs on which `KOL list` row, which four columns to write it into, and what the preview says.
// Nothing here reads or writes a sheet — the CLI does that — so every placement rule below is
// testable against fixture rows.
import { KOL_MAP_HEADER } from "./models";
import { normalizeKolName } from "./names";
import { extractTelegramHandle } from "../metrics/handles";

export const NEW_COLUMN_NAMES = ["kolId", "sheetLabel", "pricePerPost", "active"] as const;

export interface KolMapRow {
  rowNumber: number; // the sheet row this came from, for a human cross-referencing `kol-map` by hand
  kolId: string;
  tgHandle: string;
  sheetLabel: string;
  pricePerPost: string;
  active: string;
}

/** A blank spacer row (no `kolId`) carries nothing to migrate and is dropped, same rule `LoadKolMap` uses. */
export function parseKolMap(rows: string[][]): KolMapRow[] {
  if (rows.length === 0) return [];
  const header = rows[0]!.map((h) => (h ?? "").trim().toLowerCase());
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

export interface KolListIndex {
  header: string[];
  rows: string[][];
  socialLinkCol: number;
  kolNameCol: number; // -1 if the tab has no "KOL" column — then there is no name key to fall back to
  /** normalised (lowercase) Telegram handle → 1-based sheet row number */
  handleToRow: Map<string, number>;
  /** `normalizeKolName`d `KOL` cell → 1-based sheet row number; a name two rows share is dropped */
  nameToRow: Map<string, number>;
}

export function indexKolList(rows: string[][]): KolListIndex {
  if (rows.length === 0) throw new Error("'KOL list' has no header row");
  const header = rows[0]!.map((h) => (h ?? "").trim());
  const socialLinkCol = header.findIndex((h) => h.toLowerCase() === "social media link");
  if (socialLinkCol < 0) throw new Error('\'KOL list\' has no "Social media link" column');
  const kolNameCol = header.findIndex((h) => h.toLowerCase() === "kol");

  const handleToRow = new Map<string, number>();
  const ambiguousHandles = new Set<string>(); // two KOL list rows share a handle — refuse rather than guess which
  const nameToRow = new Map<string, number>();
  const ambiguousNames = new Set<string>();
  rows.slice(1).forEach((row, i) => {
    const rowNumber = i + 2;
    const handle = extractTelegramHandle(row[socialLinkCol] ?? "");
    if (handle) {
      const key = handle.toLowerCase();
      if (handleToRow.has(key)) ambiguousHandles.add(key);
      else handleToRow.set(key, rowNumber);
    }
    if (kolNameCol >= 0) {
      const name = normalizeKolName(row[kolNameCol] ?? "");
      if (name !== "") {
        if (nameToRow.has(name)) ambiguousNames.add(name);
        else nameToRow.set(name, rowNumber);
      }
    }
  });
  for (const key of ambiguousHandles) handleToRow.delete(key);
  for (const key of ambiguousNames) nameToRow.delete(key);

  return { header, rows, socialLinkCol, kolNameCol, handleToRow, nameToRow };
}

/** Which key placed a row. `handle` is an identifier; the other two are names, and a name match is
 *  a judgement a human confirms in the preview. */
export type MatchKey = "handle" | "sheetLabel" | "kolId";

export interface Placement {
  kolMapRow: KolMapRow;
  kolListRow: number;
  kolListName: string;
  matchedBy: MatchKey;
  /** The `kol-map` value that matched, so the preview can show the comparison, not just its verdict. */
  matchedValue: string;
}

export interface NewColumns {
  kolId: number;
  sheetLabel: number;
  pricePerPost: number;
  active: number;
  isNew: boolean; // true when these four columns must still be appended to the header
}

/** All four already present → reuse them (a safe, idempotent re-run). None present → append after
 *  the last existing column, in `NEW_COLUMN_NAMES` order. Some but not all → refuse: a partially
 *  hand-edited header is a human's mess to sort out, not this script's to guess at. */
export function findNewColumns(header: string[]): NewColumns {
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

/**
 * Places each `kol-map` row on a `KOL list` row, handle first and normalised name second.
 *
 * THE HANDLE IS THE PREFERRED KEY and every handle match is resolved before any name is considered:
 * a Telegram handle is an identifier, a name is a spelling. `extractTelegramHandle` reads it out of
 * the `KOL list` row's existing `Social media link` cell — the same column and parser `LoadKolMap`
 * uses to build the roster.
 *
 * THE NAME IS A FALLBACK, and it exists because the handle key alone places nothing: `Social media
 * link` is blank on all 63 live rows, so a handle-only join placed 0 of 13 rows, `LoadKolMap` then
 * dropped every row for want of a `kolId`, and both `kol:quarter` and `kol-telegram:record` swept an
 * empty roster while exiting 0. The join is `normalizeKolName` — the same narrow case/whitespace
 * fold `SweepKolQuarter` uses for the contract join, deliberately not a fuzzy match: `"CEK"`/`"Cek"`
 * is one person, `"Marine"`/`"Marshall"` is not, and this must never bridge the second pair.
 *
 * A name match is defensible **here specifically** because this command previews and a human reads
 * every proposed placement before `--yes` writes anything — `planLines` names the key each row
 * matched on for exactly that reading. Nothing in the weekly sweep may join on a name this way.
 *
 * One `KOL list` row is claimed at most once: a second row landing on it would overwrite the first
 * one's `kolId`/`sheetLabel`/`pricePerPost`/`active` with someone else's.
 */
export function matchRows(kolMap: KolMapRow[], kolList: KolListIndex): { placed: Placement[]; unplaceable: KolMapRow[] } {
  const usedRows = new Set<number>();
  const byHandle = new Map<KolMapRow, number>();

  for (const row of kolMap) {
    const handle = extractTelegramHandle(row.tgHandle);
    const target = handle ? kolList.handleToRow.get(handle.toLowerCase()) : undefined;
    if (target === undefined || usedRows.has(target)) continue;
    usedRows.add(target);
    byHandle.set(row, target);
  }

  const placed: Placement[] = [];
  const unplaceable: KolMapRow[] = [];
  const nameOf = (row: number) =>
    kolList.kolNameCol >= 0 ? (kolList.rows[row - 1]?.[kolList.kolNameCol] ?? "").trim() : "";

  for (const row of kolMap) {
    const byHandleRow = byHandle.get(row);
    if (byHandleRow !== undefined) {
      placed.push({
        kolMapRow: row,
        kolListRow: byHandleRow,
        kolListName: nameOf(byHandleRow),
        matchedBy: "handle",
        matchedValue: row.tgHandle,
      });
      continue;
    }

    const nameKeys: { key: MatchKey; value: string }[] = [
      { key: "sheetLabel", value: row.sheetLabel },
      { key: "kolId", value: row.kolId },
    ];
    const hit = nameKeys
      .map((k) => ({ ...k, target: k.value === "" ? undefined : kolList.nameToRow.get(normalizeKolName(k.value)) }))
      .find((k) => k.target !== undefined && !usedRows.has(k.target));

    if (!hit || hit.target === undefined) {
      unplaceable.push(row);
      continue;
    }
    usedRows.add(hit.target);
    placed.push({
      kolMapRow: row,
      kolListRow: hit.target,
      kolListName: nameOf(hit.target),
      matchedBy: hit.key,
      matchedValue: hit.value,
    });
  }

  return { placed, unplaceable };
}

/** How a placement is described to the human reading the preview. A name match must read as a name
 *  match — it is the one this command can get wrong, and only a reader can catch it. */
function matchNote(p: Placement): string {
  if (p.matchedBy === "handle") return `matched by handle ${JSON.stringify(p.matchedValue)}`;
  return (
    `matched by name (kol-map ${p.matchedBy} ${JSON.stringify(p.matchedValue)} = 'KOL list' ` +
    `${JSON.stringify(p.kolListName)}) — check this is the same person`
  );
}

/** The whole preview, as lines. Pure, so a test can read what a human would. */
export function planLines(placed: Placement[], unplaceable: KolMapRow[]): string[] {
  const lines: string[] = [];
  lines.push(`kol-roster-migrate: ${placed.length + unplaceable.length} 'kol-map' row(s) read.`);
  lines.push("");
  lines.push(
    `Placed (${placed.length}) — would fill 'KOL list' row's kolId/sheetLabel/pricePerPost/active, ` +
      `and its Social media link if that cell is blank:`,
  );
  if (placed.length === 0) lines.push("  (none)");
  for (const p of placed) {
    lines.push(
      `  ${p.kolMapRow.kolId} → 'KOL list' row ${p.kolListRow}` +
        `${p.kolListName ? ` ("${p.kolListName}")` : ""} — ${matchNote(p)}; ` +
        `sheetLabel=${JSON.stringify(p.kolMapRow.sheetLabel)}, ` +
        `pricePerPost=${JSON.stringify(p.kolMapRow.pricePerPost)}, active=${JSON.stringify(p.kolMapRow.active)}`,
    );
  }
  lines.push("");
  lines.push(
    `Cannot place (${unplaceable.length}) — no 'KOL list' row matched this row's Telegram handle, ` +
      `and none carries a name that folds to its sheetLabel or kolId (reported, never guessed):`,
  );
  if (unplaceable.length === 0) lines.push("  (none)");
  for (const row of unplaceable) {
    lines.push(
      `  ${row.kolId} (kol-map row ${row.rowNumber}, tgHandle=${JSON.stringify(row.tgHandle)}, ` +
        `sheetLabel=${JSON.stringify(row.sheetLabel)}, pricePerPost=${JSON.stringify(row.pricePerPost)}, ` +
        `active=${JSON.stringify(row.active)})`,
    );
  }
  return lines;
}
