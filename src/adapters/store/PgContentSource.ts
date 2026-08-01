import type { Db } from "../db/Db";
import type { CollectedThread, CollectionStatus, SourceTweet } from "../../domain/models";
import type { LarkMessage } from "../../domain/larkMessage";
import type { ContentItem } from "../../domain/translation/contentItem";
import type { ContentSource } from "../../ports/ContentSource";
import { flattenXThreads } from "../content/XContentSource";
import { flattenLarkMessages } from "../content/LarkContentSource";
import { CompositeContentSource } from "../content/CompositeContentSource";

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
 * `ContentSource` backed directly by the `x_threads` table — the database equivalent of
 * `XContentSource` (which reads `x/items.json`). Split out from `PgContentSource` so a caller that
 * needs just one source (`translate-prepare.ts`'s `--source x`/`--source lark` selector) can get it
 * without also reading the other table — `CompositeContentSource([new PgXContentSource(db), new
 * PgLarkContentSource(db)])` is exactly what `PgContentSource` composes below.
 */
export class PgXContentSource implements ContentSource {
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
    return flattenXThreads(threads, translatedIds);
  }
}

/** `ContentSource` backed directly by the `lark_items` table — the database equivalent of
 *  `LarkContentSource` (which reads `lark/items.json`). See `PgXContentSource`'s doc comment for
 *  why this is split out rather than folded into `PgContentSource` alone. */
export class PgLarkContentSource implements ContentSource {
  constructor(private readonly db: Db) {}

  async loadPending(translatedIds: Set<string>): Promise<ContentItem[]> {
    const larkRows = await this.db.query<LarkItemRow>(
      `select id as message_id, text, created_at from lark_items order by ordinal`,
    );
    const messages: Pick<LarkMessage, "messageId" | "text" | "createdAt">[] = larkRows.map((r) => ({
      messageId: r.message_id,
      text: r.text,
      createdAt: r.created_at,
    }));
    return flattenLarkMessages(messages, translatedIds);
  }
}

/**
 * `ContentSource` backed directly by the `x_threads` and `lark_items` tables — the database
 * equivalent of `CompositeContentSource([new XContentSource(...), new LarkContentSource(...)])`,
 * X items first and Lark items second, same as every existing wiring of that composite
 * (`src/cli/serve.ts`, `src/cli/status.ts`, `src/cli/translate-prepare.ts`).
 *
 * Composed from `PgXContentSource` + `PgLarkContentSource` rather than re-querying both tables
 * itself, so there is exactly one place each table is read from.
 *
 * The flattening itself — thread joining, media markers, article rendering, the commenter-reply
 * marker — is not reimplemented here. `flattenXThreads`/`flattenLarkMessages` (extracted from
 * `XContentSource`/`LarkContentSource`, which now call them too) are pure functions of already-
 * loaded rows, so this class's only job is to read the two tables and pass the results through the
 * same code the file-backed sources use — `tests/adapters/content/*` covers that behaviour once,
 * for both callers.
 */
export class PgContentSource implements ContentSource {
  private readonly composite: ContentSource;

  constructor(db: Db) {
    this.composite = new CompositeContentSource([new PgXContentSource(db), new PgLarkContentSource(db)]);
  }

  async loadPending(translatedIds: Set<string>): Promise<ContentItem[]> {
    return this.composite.loadPending(translatedIds);
  }
}
