import type { PublishRecord } from "../domain/sheet/models";
import type { SheetClient } from "../ports/SheetClient";

const DATA_RANGE = "history!A2:G"; // publish columns, data rows (header is row 1)

const toRow = (r: PublishRecord): string[] => [r.itemId, r.type, r.channel, r.postId ?? "", r.url ?? "", r.status, r.publishedAt];

export class RecordPublish {
  constructor(private readonly sheet: SheetClient) {}

  async record(rec: PublishRecord): Promise<void> {
    const rows = await this.sheet.getValues(DATA_RANGE);
    const idx = rows.findIndex((r) => r[0] === rec.itemId && r[1] === rec.type && r[2] === rec.channel);
    if (idx >= 0) {
      const rowNumber = idx + 2; // data starts at sheet row 2
      await this.sheet.updateValues(`history!A${rowNumber}:G${rowNumber}`, [toRow(rec)]);
    } else {
      await this.sheet.appendValues(DATA_RANGE, [toRow(rec)]);
    }
  }
}
