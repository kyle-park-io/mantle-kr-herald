import type { Db } from "../db/Db";
import type { CollectedThread, CollectionStatus, SourceTweet } from "../../domain/models";
import type { LarkMessage } from "../../domain/larkMessage";
import type { ContentItem } from "../../domain/translation/contentItem";
import type { ContentSource } from "../../ports/ContentSource";
import { flattenXThreads } from "../content/XContentSource";
import { flattenLarkMessages } from "../content/LarkContentSource";

interface XThreadRow {
  root_id: string;
  tweets: SourceTweet[];
  status: string;
}

interface LarkItemRow {
  message_id: string;
  text: string;
  created_at: string;
}

/**
 * `ContentSource` backed directly by the `x_threads` and `lark_items` tables — the database
 * equivalent of `CompositeContentSource([new XContentSource(...), new LarkContentSource(...)])`,
 * X items first and Lark items second, same as every existing wiring of that composite
 * (`src/cli/serve.ts`, `src/cli/status.ts`, `src/cli/translate-prepare.ts`).
 *
 * The flattening itself — thread joining, media markers, article rendering, the commenter-reply
 * marker — is not reimplemented here. `flattenXThreads`/`flattenLarkMessages` (extracted from
 * `XContentSource`/`LarkContentSource`, which now call them too) are pure functions of already-
 * loaded rows, so this class's only job is to read the two tables and pass the results through the
 * same code the file-backed sources use — `tests/adapters/content/*` covers that behaviour once,
 * for both callers.
 */
export class PgContentSource implements ContentSource {
  constructor(private readonly db: Db) {}

  async loadPending(translatedIds: Set<string>): Promise<ContentItem[]> {
    const threadRows = await this.db.query<XThreadRow>(
      `select root_id, tweets, status from x_threads order by ordinal`,
    );
    const threads: Pick<CollectedThread, "rootId" | "tweets" | "status">[] = threadRows.map((r) => ({
      rootId: r.root_id,
      tweets: r.tweets,
      status: r.status as CollectionStatus,
    }));

    const larkRows = await this.db.query<LarkItemRow>(
      `select id as message_id, text, created_at from lark_items order by ordinal`,
    );
    const messages: Pick<LarkMessage, "messageId" | "text" | "createdAt">[] = larkRows.map((r) => ({
      messageId: r.message_id,
      text: r.text,
      createdAt: r.created_at,
    }));

    return [...flattenXThreads(threads, translatedIds), ...flattenLarkMessages(messages, translatedIds)];
  }
}
