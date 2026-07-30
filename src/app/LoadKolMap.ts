import type { SheetClient } from "../ports/SheetClient";
import type { KolMapEntry } from "../domain/kol/models";
import { extractTelegramHandle } from "../domain/metrics/handles";

// The kol-map tab + column headers are coupled to the team workbook; update here if renamed.
const KOL_MAP_RANGE = "'kol-map'!A:Z";
const COL_KOL_ID = "kolid";
const COL_TG_HANDLE = "tghandle";
const COL_SHEET_LABEL = "sheetlabel";
const COL_PRICE = "priceperpost";
const COL_ACTIVE = "active";

function isActive(raw: string): boolean {
  return /^(true|y|yes|1)$/i.test((raw ?? "").trim());
}

function parsePrice(raw: string): number {
  const n = parseFloat((raw ?? "").trim());
  return Number.isFinite(n) ? n : 0;
}

export class LoadKolMap {
  constructor(private readonly sheet: SheetClient) {}

  async run(): Promise<KolMapEntry[]> {
    const rows = await this.sheet.getValues(KOL_MAP_RANGE);
    if (rows.length === 0) return [];
    const header = rows[0].map((h) => (h ?? "").trim().toLowerCase());
    const kolIdIdx = header.indexOf(COL_KOL_ID);
    const tgHandleIdx = header.indexOf(COL_TG_HANDLE);
    const sheetLabelIdx = header.indexOf(COL_SHEET_LABEL);
    const priceIdx = header.indexOf(COL_PRICE);
    const activeIdx = header.indexOf(COL_ACTIVE);
    if (kolIdIdx < 0 || tgHandleIdx < 0 || sheetLabelIdx < 0 || priceIdx < 0 || activeIdx < 0) {
      throw new Error(
        `'kol-map' is missing a required column (need "kolId", "tgHandle", "sheetLabel", "pricePerPost", "active")`
      );
    }
    const out: KolMapEntry[] = [];
    for (const row of rows.slice(1)) {
      const kolId = (row[kolIdIdx] ?? "").trim();
      const tgHandle = extractTelegramHandle(row[tgHandleIdx] ?? "");
      const active = isActive(row[activeIdx] ?? "");
      if (!kolId || !tgHandle || !active) continue;
      const sheetLabel = (row[sheetLabelIdx] ?? "").trim();
      const pricePerPost = parsePrice(row[priceIdx] ?? "");
      out.push({ kolId, tgHandle, sheetLabel, pricePerPost, active });
    }
    return out;
  }
}
