import type { SheetClient } from "../ports/SheetClient";
import type { SourceGateway } from "../ports/SourceGateway";
import type { SourceTweet } from "../domain/models";
import type { RosterEntry } from "../domain/sheet/models";
import { X_PERFORMANCE_HEADER } from "../domain/sheet/models";
import { aggregateMonth } from "../domain/metrics/aggregate";
import { monthWindow } from "../domain/metrics/window";

const TAB = "x-performance";
const HEADER_RANGE = `${TAB}!A1:I1`;
const DATA_RANGE = `${TAB}!A2:I`;

interface Account { handle: string; name: string; type: "official" | "kol"; }

export interface RecordMetricsInput { month: string; officialHandle: string; roster: RosterEntry[]; }
export interface RecordMetricsResult { recorded: number; skipped: number; }

export class RecordMetrics {
  constructor(
    private readonly sheet: SheetClient,
    private readonly gateway: SourceGateway,
    private readonly now: () => Date = () => new Date(),
  ) {}

  async run(input: RecordMetricsInput): Promise<RecordMetricsResult> {
    const window = monthWindow(input.month);
    const accounts: Account[] = [
      { handle: input.officialHandle, name: "Mantle KR", type: "official" },
      ...input.roster.map((r) => ({ handle: r.handle, name: r.name, type: "kol" as const })),
    ];

    await this.sheet.ensureTab(TAB);
    const header = await this.sheet.getValues(HEADER_RANGE);
    if (header.length === 0 || (header[0] ?? []).length === 0) {
      await this.sheet.updateValues(HEADER_RANGE, [X_PERFORMANCE_HEADER]);
    }

    let recorded = 0;
    let skipped = 0;
    for (const acc of accounts) {
      try {
        const profile = await this.gateway.fetchUserProfile(acc.handle);
        const tweets: SourceTweet[] = [];
        for await (const t of this.gateway.fetchAuthoredTweets(acc.handle, window.startISO)) tweets.push(t);
        const agg = aggregateMonth(tweets, window);
        const row = [
          acc.handle,
          acc.name,
          acc.type,
          input.month,
          profile.followers !== undefined ? String(profile.followers) : "",
          String(agg.posts),
          String(agg.views),
          String(agg.engagement),
          this.now().toISOString(),
        ];
        await this.upsert(acc.handle, input.month, row);
        recorded += 1;
      } catch (err) {
        console.warn(`[metrics] ${acc.handle} skipped: ${(err as Error).message}`);
        skipped += 1;
      }
    }
    return { recorded, skipped };
  }

  private async upsert(handle: string, month: string, row: string[]): Promise<void> {
    const rows = await this.sheet.getValues(DATA_RANGE);
    const idx = rows.findIndex((r) => r[0] === handle && r[3] === month);
    if (idx >= 0) {
      const rowNumber = idx + 2; // data starts at sheet row 2
      await this.sheet.updateValues(`${TAB}!A${rowNumber}:I${rowNumber}`, [row]);
    } else {
      await this.sheet.appendValues(DATA_RANGE, [row]);
    }
  }
}
