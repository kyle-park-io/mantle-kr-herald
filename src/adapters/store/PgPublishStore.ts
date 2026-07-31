import type { Db } from "../db/Db";
import { omitNulls } from "../db/omitNulls";
import { entryKey, type SyncEntry } from "../../domain/publish/syncLedger";
import type { PublishStore } from "../../ports/PublishStore";

/** The shape a row from `publish_entries` (see `src/adapters/db/schema.ts`) comes back as. */
interface PublishEntryRow {
  item_id: string;
  stage: string;
  status: string;
  target: string;
  file_name: string | null;
  remote_id: string | null;
  url: string | null;
  content_hash: string | null;
  uploaded_at: string | null;
}

function toSyncEntry(row: PublishEntryRow): SyncEntry {
  return omitNulls({
    itemId: row.item_id,
    stage: row.stage as SyncEntry["stage"],
    status: row.status,
    target: row.target,
    fileName: row.file_name,
    remoteId: row.remote_id,
    url: row.url,
    contentHash: row.content_hash,
    uploadedAt: row.uploaded_at,
  });
}

/**
 * `PublishStore` backed by the `publish_entries` table. Replaces `JsonPublishStore`.
 *
 * `record` is one `insert ... on conflict (item_id, status, target) do update` statement — no
 * `loadAll` + filter + rewrite — so two concurrent `record()`s of different rows can never race
 * and drop one. The `on conflict` clause never assigns `ordinal`: that column is set once by
 * `bigserial` on the initial insert and an update leaves it alone, so `listEntries()`'s
 * `order by ordinal` keeps reproducing insertion order — the same order `JsonPublishStore`
 * produces by appending to `state.json`'s `entries` array — even after a row has been re-uploaded.
 *
 * `listEntries()` has no equivalent of `JsonPublishStore.listEntries()`'s fallback to the legacy
 * `{published: string[]}` format: that migration is a one-time, file-shape concern that `db:import`
 * (a later task) owns, not something this store reproduces at read time.
 *
 * `remove` takes the same joined string key `entryKey` produces (`${itemId}:${status}:${target}`).
 * `itemId` contains a colon of its own ("x:1934"), so this recomputes the join in SQL —
 * `item_id || ':' || status || ':' || target` — and compares it whole, exactly like
 * `PgOutletOverrideStore.remove` does, rather than splitting the key apart and risking a
 * misassigned segment.
 */
export class PgPublishStore implements PublishStore {
  constructor(private readonly db: Db) {}

  async listEntries(): Promise<SyncEntry[]> {
    const rows = await this.db.query<PublishEntryRow>(
      `select item_id, stage, status, target, file_name, remote_id, url, content_hash, uploaded_at
       from publish_entries
       order by ordinal`,
    );
    return rows.map(toSyncEntry);
  }

  async record(entry: SyncEntry): Promise<void> {
    await this.db.query(
      `insert into publish_entries
         (item_id, stage, status, target, file_name, remote_id, url, content_hash, uploaded_at)
       values ($1, $2, $3, $4, $5, $6, $7, $8, $9)
       on conflict (item_id, status, target) do update set
         stage = excluded.stage,
         file_name = excluded.file_name,
         remote_id = excluded.remote_id,
         url = excluded.url,
         content_hash = excluded.content_hash,
         uploaded_at = excluded.uploaded_at`,
      [
        entry.itemId,
        entry.stage,
        entry.status,
        entry.target,
        entry.fileName ?? null,
        entry.remoteId ?? null,
        entry.url ?? null,
        entry.contentHash ?? null,
        entry.uploadedAt ?? null,
      ],
    );
  }

  async remove(key: string): Promise<void> {
    await this.db.query(
      // Mirrors `entryKey` (src/domain/publish/syncLedger.ts): `${itemId}:${status}:${target}`.
      "delete from publish_entries where item_id || ':' || status || ':' || target = $1",
      [key],
    );
  }
}
