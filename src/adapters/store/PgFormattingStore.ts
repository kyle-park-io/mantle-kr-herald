import type { Db } from "../db/Db";
import { omitNulls } from "../db/omitNulls";
import type { ConversionType } from "../../domain/conversion/models";
import type { Channel, ChannelRendering } from "../../domain/formatting/models";
import { renderingKey, type FormattingStore } from "../../ports/FormattingStore";

/** The shape a row from `renderings` (see `src/adapters/db/schema.ts`) comes back as. */
interface RenderingRow {
  item_id: string;
  type: string;
  channel: string;
  text: string;
  refined: boolean;
  created_at: string;
  status: string;
  approved_at: string | null;
}

function toChannelRendering(row: RenderingRow): ChannelRendering {
  return omitNulls({
    itemId: row.item_id,
    type: row.type as ConversionType,
    channel: row.channel as Channel,
    text: row.text,
    refined: row.refined,
    createdAt: row.created_at,
    status: row.status as ChannelRendering["status"],
    approvedAt: row.approved_at,
  });
}

/**
 * `FormattingStore` backed by the `renderings` table. Replaces `JsonFormattingStore`.
 *
 * `upsert` is one `insert ... on conflict (item_id, type, channel) do update` statement — no
 * `loadAll` + merge + rewrite — so two concurrent upserts of different rows can never race and
 * drop one. The `on conflict` clause never assigns `ordinal`: that column is set once by
 * `bigserial` on the initial insert and an update leaves it alone, so `loadAll()`'s
 * `order by ordinal` keeps reproducing insertion order — the same order `JsonFormattingStore`
 * produces by appending to `renderings.json` — even after a row has been edited. That matters here
 * more than most: `status` carries the §7 second-review approval that flips a room from `rendered`
 * to `approved`, and an approval must never look like it also reordered the file.
 */
export class PgFormattingStore implements FormattingStore {
  constructor(private readonly db: Db) {}

  async loadAll(): Promise<ChannelRendering[]> {
    const rows = await this.db.query<RenderingRow>(
      `select item_id, type, channel, text, refined, created_at, status, approved_at
       from renderings
       order by ordinal`,
    );
    return rows.map(toChannelRendering);
  }

  async upsert(r: ChannelRendering): Promise<void> {
    await this.db.query(
      `insert into renderings
         (item_id, type, channel, text, refined, created_at, status, approved_at)
       values ($1, $2, $3, $4, $5, $6, $7, $8)
       on conflict (item_id, type, channel) do update set
         text = excluded.text,
         refined = excluded.refined,
         created_at = excluded.created_at,
         status = excluded.status,
         approved_at = excluded.approved_at`,
      [r.itemId, r.type, r.channel, r.text, r.refined, r.createdAt, r.status, r.approvedAt ?? null],
    );
  }

  async listRenderedKeys(): Promise<Set<string>> {
    const rows = await this.db.query<{ item_id: string; type: string; channel: string }>(
      "select item_id, type, channel from renderings",
    );
    // Through `renderingKey`, not a template literal of its own: this set is now read back by
    // `FormatVariants`' only-missing mode, and the two sides have to spell the key the same way or
    // that mode silently stops skipping anything. See the port's own comment.
    return new Set(
      rows.map((r) => renderingKey({ itemId: r.item_id, type: r.type as ConversionType, channel: r.channel as Channel })),
    );
  }
}
