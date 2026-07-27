import type { PublishRecord } from "../domain/sheet/models";
import { HISTORY_HEADER } from "../domain/sheet/models";
import type { SheetClient } from "../ports/SheetClient";

const TAB = "history";
const HEADER_RANGE = `${TAB}!A1:I1`; // labels A–G (publish) + H,I (impressions, filled by §9b)
const DATA_RANGE = `${TAB}!A2:G`; // publish columns, data rows (header is row 1)

const toRow = (r: PublishRecord): string[] => [r.itemId, r.type, r.channel, r.postId ?? "", r.url ?? "", r.status, r.publishedAt];

export class RecordPublish {
  private ensured = false;

  constructor(private readonly sheet: SheetClient) {}

  async record(rec: PublishRecord): Promise<void> {
    await this.ensureHistoryTab();

    const rows = await this.sheet.getValues(DATA_RANGE);
    const idx = rows.findIndex((r) => r[0] === rec.itemId && r[1] === rec.type && r[2] === rec.channel);
    if (idx >= 0) {
      const rowNumber = idx + 2; // data starts at sheet row 2
      await this.sheet.updateValues(`${TAB}!A${rowNumber}:G${rowNumber}`, [toRow(rec)]);
    } else {
      await this.sheet.appendValues(DATA_RANGE, [toRow(rec)]);
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
