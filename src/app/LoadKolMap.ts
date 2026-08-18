import type { SheetClient } from "../ports/SheetClient";
import type { KolMapEntry } from "../domain/kol/models";
import { KOL_MAP_HEADER, KOL_LIST_HEADER } from "../domain/kol/models";
import { extractTelegramHandle } from "../domain/metrics/handles";

// The roster lives in the humans' `KOL list` tab; `kol-map` is retired (see the 2026-08-19
// kol-quarter-tracking spec). Update here if the tab is renamed.
const KOL_MAP_RANGE = "'KOL list'!A:Z";
const SEED_DOC = "docs/ko/kol-map-seed.md";

/**
 * The header text this loader looks for, taken from `KOL_MAP_HEADER` so that constant really is
 * the single source of truth it claims to be — rename a column there and the lookup follows it.
 * Previously the loader matched its own lowercase literals and `KOL_MAP_HEADER` was referenced
 * only by its own test, so a rename would have left the loader hunting for the old name.
 *
 * `field` is a `keyof KolMapEntry`, so a typo fails `pnpm typecheck`; the runtime lookup then
 * fails loudly if the constant no longer carries that column at all.
 */
function headerText(field: keyof KolMapEntry): string {
  const name = KOL_MAP_HEADER.find((h) => h === field);
  if (!name) throw new Error(`KOL_MAP_HEADER no longer declares a "${field}" column`);
  return name.toLowerCase();
}

/**
 * `KolMapEntry.tgHandle` has no column of that name in `KOL list` — the tab's existing, empty
 * `Social media link` column (already read by `LoadRoster` for X handles) is read instead, since
 * `extractTelegramHandle` accepts every form a human might paste there. This can't go through
 * `headerText()` above, which matches a header cell against a `KolMapEntry` field *name*, and
 * "Social media link" isn't one — so it's matched against the literal header text instead.
 */
function requireHeader(header: readonly string[], text: string): string {
  const name = header.find((h) => h === text);
  if (!name) throw new Error(`KOL_LIST_HEADER no longer declares a "${text}" column`);
  return name.toLowerCase();
}

const COL_KOL_ID = headerText("kolId");
const COL_SHEET_LABEL = headerText("sheetLabel");
const COL_PRICE = headerText("pricePerPost");
const COL_ACTIVE = headerText("active");
const COL_TG_HANDLE = requireHeader(KOL_LIST_HEADER, "Social media link");

/** A leading currency symbol Sheets' FORMATTED_VALUE rendering may prepend to a rate cell. */
const CURRENCY_PREFIX = /^(?:US\$|\$|₩)\s*/i;

function isActive(raw: string): boolean {
  return /^(true|y|yes|1)$/i.test((raw ?? "").trim());
}

/**
 * A price cell as a number, `0` for a blank cell, or `undefined` when a **non-empty** cell cannot
 * be read — the caller warns on `undefined` so a mistyped rate is never silently a zero.
 *
 * A price is a clean number or it is nothing; there are no partial parses. `parseFloat` alone
 * would take "1,000" as 1 — a real price shrunk 1000x rather than an obviously wrong one — so the
 * numeric test is deliberately whole-string.
 *
 * The currency prefix is tolerated because `getValues` sends no `valueRenderOption` and therefore
 * receives **FORMATTED_VALUE**: a rate column formatted as currency arrives as "$100.00", not
 * `100`. A trailing unit ("100원") is still rejected — only a leading symbol is stripped.
 */
function parsePrice(raw: string): number | undefined {
  const trimmed = (raw ?? "").trim();
  if (trimmed === "") return 0;
  const s = trimmed.replace(CURRENCY_PREFIX, "").replace(/,/g, "").trim();
  if (!/^\d+(\.\d+)?$/.test(s)) return undefined;
  const n = Number.parseFloat(s);
  return Number.isFinite(n) ? n : undefined;
}

export class LoadKolMap {
  constructor(private readonly sheet: SheetClient) {}

  async run(): Promise<KolMapEntry[]> {
    const rows = await this.readTab();
    if (rows.length === 0) return [];
    const header = rows[0].map((h) => (h ?? "").trim().toLowerCase());
    const kolIdIdx = header.indexOf(COL_KOL_ID);
    const tgHandleIdx = header.indexOf(COL_TG_HANDLE);
    const sheetLabelIdx = header.indexOf(COL_SHEET_LABEL);
    const priceIdx = header.indexOf(COL_PRICE);
    const activeIdx = header.indexOf(COL_ACTIVE);
    if (kolIdIdx < 0 || tgHandleIdx < 0 || sheetLabelIdx < 0 || priceIdx < 0 || activeIdx < 0) {
      throw new Error(
        `'KOL list' is missing a required column (need ${KOL_LIST_HEADER.map((h) => `"${h}"`).join(", ")}) — see ${SEED_DOC}`,
      );
    }
    const out: KolMapEntry[] = [];
    rows.slice(1).forEach((row, i) => {
      const rowNumber = i + 2; // the header is sheet row 1, so data starts at row 2
      const kolId = (row[kolIdIdx] ?? "").trim();
      const handleCell = (row[tgHandleIdx] ?? "").trim();
      const active = isActive(row[activeIdx] ?? "");
      // A blank spacer row and a deliberately parked channel are both silent by design; only a row
      // the operator meant to sweep is worth complaining about.
      if (!kolId || !active) return;

      const tgHandle = extractTelegramHandle(handleCell);
      if (!tgHandle) {
        // Without this warning a mistyped cell drops the channel from the sweep and the run still
        // reports a clean "0 created", which reads as "this KOL posted nothing about Mantle".
        console.warn(
          `[kol-telegram] 'KOL list' row ${rowNumber} (${kolId}): unusable tgHandle ` +
            `${JSON.stringify(handleCell)} — this channel was NOT swept. Accepted forms: ` +
            `https://t.me/<handle>, t.me/<handle>, @<handle>, or a bare <handle> ` +
            `(5-32 characters of A-Z a-z 0-9 _). See ${SEED_DOC}`,
        );
        return;
      }

      const price = parsePrice(row[priceIdx] ?? "");
      if (price === undefined) {
        console.warn(
          `[kol-telegram] 'KOL list' row ${rowNumber} (${kolId}): pricePerPost ` +
            `${JSON.stringify((row[priceIdx] ?? "").trim())} is not a number — this channel's rows ` +
            `get a blank pricePerPost. Fix the cell and re-run: a row whose pricePerPost is still ` +
            `blank is filled on the next run, but one that already carries a number is not. ` +
            `See ${SEED_DOC}`,
        );
      }

      out.push({
        kolId,
        tgHandle,
        sheetLabel: (row[sheetLabelIdx] ?? "").trim(),
        pricePerPost: price ?? 0,
        active,
      });
    });
    return out;
  }

  /**
   * The very first real run happens before anyone has created the tab, and the raw Sheets error
   * for that is `HTTP 400` — which says nothing about what to do next.
   */
  private async readTab(): Promise<string[][]> {
    try {
      return await this.sheet.getValues(KOL_MAP_RANGE);
    } catch (err) {
      const message = (err as Error)?.message ?? "";
      if (/HTTP 400/.test(message)) {
        throw new Error(
          `The 'KOL list' tab does not exist in the configured workbook (GSHEET_ID). Create a tab ` +
            `named exactly 'KOL list' with the header row ` +
            `${KOL_LIST_HEADER.join(" | ")} and seed it — see ${SEED_DOC}. ` +
            `(Sheets reported: ${message})`,
          { cause: err },
        );
      }
      throw err;
    }
  }
}
