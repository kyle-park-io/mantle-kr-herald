import type { Db } from "../db/Db";
import { omitNulls } from "../db/omitNulls";
import type { LarkMessage } from "../../domain/larkMessage";
import type { LarkRepository } from "../../ports/LarkRepository";

/** The shape a row from `lark_items` (see `src/adapters/db/schema.ts`) comes back as. */
interface LarkItemRow {
  id: string;
  chat_id: string;
  msg_type: string;
  created_at: string;
  sender_id: string | null;
  thread_id: string | null;
  parent_id: string | null;
  text: string;
  raw_content: string;
}

function toLarkMessage(row: LarkItemRow): LarkMessage {
  return omitNulls({
    messageId: row.id,
    chatId: row.chat_id,
    msgType: row.msg_type,
    createdAt: row.created_at,
    senderId: row.sender_id,
    threadId: row.thread_id,
    parentId: row.parent_id,
    text: row.text,
    rawContent: row.raw_content,
  });
}

/**
 * `LarkRepository` backed by the `lark_items` table. Replaces the `LarkRepository` half of
 * `LarkLocalStore`; the `WatermarkStore` half (`get`/`set` over `lark/state.json`) stays on disk for
 * the same reason `PgCollectionRepository`'s doc comment gives for `x/state.json` — `collect-lark` is
 * a local job per the spec — so `LarkLocalStore` remains in the tree for that, and this class
 * implements `LarkRepository` only.
 *
 * The port's own comment reads "merge by messageId (incoming wins). Never drops stored messages." —
 * exactly what one `insert ... on conflict (id) do update` per message gives for free: a message
 * already stored but absent from `messages` is simply never touched, and one present in both is
 * fully replaced by the incoming row (matching `LarkLocalStore.upsert`'s `byId.set(...)`, which does
 * the same field-for-field replacement rather than merging). Unlike `PgCollectionRepository.upsert`,
 * there is no per-row merge rule here (no `article`-style regression to protect), so no read-before-
 * write is needed — each message maps to one independent statement. The whole batch still runs
 * inside `db.tx()` so a failure partway through a multi-message call rolls back what it already wrote,
 * matching `LarkLocalStore.upsert`'s single atomic file write. The `on conflict` clause never assigns
 * `ordinal`, so `loadAll()`'s `order by ordinal` keeps reproducing insertion order even after a
 * message has been re-upserted.
 */
export class PgLarkRepository implements LarkRepository {
  constructor(private readonly db: Db) {}

  async loadAll(): Promise<LarkMessage[]> {
    const rows = await this.db.query<LarkItemRow>(
      `select id, chat_id, msg_type, created_at, sender_id, thread_id, parent_id, text, raw_content
       from lark_items
       order by ordinal`,
    );
    return rows.map(toLarkMessage);
  }

  async upsert(messages: LarkMessage[]): Promise<void> {
    if (messages.length === 0) return;
    await this.db.tx(async (tx) => {
      for (const m of messages) {
        await tx.query(
          `insert into lark_items
             (id, chat_id, msg_type, created_at, sender_id, thread_id, parent_id, text, raw_content)
           values ($1, $2, $3, $4, $5, $6, $7, $8, $9)
           on conflict (id) do update set
             chat_id = excluded.chat_id,
             msg_type = excluded.msg_type,
             created_at = excluded.created_at,
             sender_id = excluded.sender_id,
             thread_id = excluded.thread_id,
             parent_id = excluded.parent_id,
             text = excluded.text,
             raw_content = excluded.raw_content`,
          [
            m.messageId,
            m.chatId,
            m.msgType,
            m.createdAt,
            m.senderId ?? null,
            m.threadId ?? null,
            m.parentId ?? null,
            m.text,
            m.rawContent,
          ],
        );
      }
    });
  }
}
