import type { SheetClient } from "../ports/SheetClient";
import type { RosterEntry } from "../domain/sheet/models";
import { extractXHandle } from "../domain/metrics/handles";

// The roster tab + column headers are coupled to the team workbook; update here if renamed.
const ROSTER_RANGE = "'KOL list'!A:Z";
const COL_NAME = "kol";
const COL_PLATFORM = "social media";
const COL_LINK = "social media link";

export class LoadRoster {
  constructor(private readonly sheet: SheetClient) {}

  async run(): Promise<RosterEntry[]> {
    const rows = await this.sheet.getValues(ROSTER_RANGE);
    if (rows.length === 0) return [];
    const header = rows[0].map((h) => (h ?? "").trim().toLowerCase());
    const nameIdx = header.indexOf(COL_NAME);
    const platIdx = header.indexOf(COL_PLATFORM);
    const linkIdx = header.indexOf(COL_LINK);
    if (nameIdx < 0 || platIdx < 0 || linkIdx < 0) {
      throw new Error(`'KOL list' is missing a required column (need "KOL", "Social media", "Social media link")`);
    }
    const out: RosterEntry[] = [];
    for (const row of rows.slice(1)) {
      const name = (row[nameIdx] ?? "").trim();
      const handle = extractXHandle(row[platIdx] ?? "", row[linkIdx] ?? "");
      if (name && handle) out.push({ name, handle });
    }
    return out;
  }
}
