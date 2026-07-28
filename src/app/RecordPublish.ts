import type { PublishRecord } from "../domain/sheet/models";
import { HISTORY_HEADER } from "../domain/sheet/models";
import type { SheetClient } from "../ports/SheetClient";

const TAB = "history";
const HEADER_RANGE = `${TAB}!A1:J1`; // labels A–G (publish) + H,I (impressions, filled by §9b) + J (outletId)
const DATA_RANGE = `${TAB}!A2:J`; // data rows (header is row 1) — J is read to identify the room
const OUTLET_COL = 9; // zero-based index of column J in a row

const publishCells = (r: PublishRecord): string[] => [r.itemId, r.type, r.channel, r.postId ?? "", r.url ?? "", r.status, r.publishedAt];
/** A brand-new row: publish columns, then the impression columns left empty for §9b, then the room. */
const newRow = (r: PublishRecord): string[] => [...publishCells(r), "", "", r.outletId ?? ""];

export class RecordPublish {
  private ensured = false;

  constructor(private readonly sheet: SheetClient) {}

  async record(rec: PublishRecord): Promise<void> {
    await this.ensureHistoryTab();

    const rows = await this.sheet.getValues(DATA_RANGE);
    // Keyed by room, not channel alone. 맨틀 한국 커뮤니티 and 맨틀 한국 데브방 are both telegram, so a
    // channel-keyed upsert made the second room's send overwrite the first's postId and t.me url —
    // one row where two sends happened, and the first room's link gone from the record.
    //
    // Channel is still required in the predicate: legacy rows (written before the outlet column
    // existed) all carry a blank J, so without a channel check `--outlet`-less calls (the manual
    // `history:record` CLI path) would match *any* blank-J row for the item+type — telegram or x —
    // and clobber whichever one the sheet happened to list first. An outlet maps to exactly one
    // channel, so this is a no-op on the outlet-keyed path and only tightens the legacy fallback.
    const idx = rows.findIndex(
      (r) => r[0] === rec.itemId && r[1] === rec.type && r[2] === rec.channel && (r[OUTLET_COL] ?? "") === (rec.outletId ?? ""),
    );
    if (idx >= 0) {
      const rowNumber = idx + 2; // data starts at sheet row 2
      // A–G only: H/I are the impression columns, and J already holds this room (it is how the row
      // was matched), so neither is rewritten.
      await this.sheet.updateValues(`${TAB}!A${rowNumber}:G${rowNumber}`, [publishCells(rec)]);
    } else {
      await this.sheet.appendValues(DATA_RANGE, [newRow(rec)]);
    }
  }

  /**
   * Create the `history` tab + header if the target workbook lacks them, so history lives in
   * whatever `GSHEET_ID` names — the same auto-create RecordMetrics does for `x-performance`.
   * This lets one workbook hold every machine tab (the "one file" layout), and stops a send from
   * 400-ing when the sheet was created by hand or by `metrics:record` rather than `sheet:init`.
   * Memoized: a batch of records reuses one RecordPublish, so the tab is ensured once, not per row.
   */
  private async ensureHistoryTab(): Promise<void> {
    if (this.ensured) return;
    await this.sheet.ensureTab(TAB);
    const header = await this.sheet.getValues(HEADER_RANGE);
    if (header.length === 0 || (header[0] ?? []).length === 0) {
      await this.sheet.updateValues(HEADER_RANGE, [HISTORY_HEADER]);
    }
    this.ensured = true;
  }
}
