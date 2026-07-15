import type { DistributionTarget } from "../domain/sheet/models";
import type { SheetClient } from "../ports/SheetClient";

const TARGETS_RANGE = "targets!A2:E"; // data rows only (skip the header at row 1)

const cell = (row: string[], i: number): string => (row[i] ?? "").trim();

export class LoadTargets {
  constructor(private readonly sheet: SheetClient) {}

  async run(opts: { activeOnly?: boolean } = {}): Promise<DistributionTarget[]> {
    const rows = await this.sheet.getValues(TARGETS_RANGE);
    const targets = rows
      .filter((r) => r.some((c) => (c ?? "").trim() !== "")) // skip fully-blank rows
      .map((r) => ({
        channel: cell(r, 0),
        name: cell(r, 1),
        address: cell(r, 2),
        active: /^true$/i.test(cell(r, 3)),
        notes: cell(r, 4) || undefined,
      }));
    return opts.activeOnly ? targets.filter((t) => t.active) : targets;
  }
}
