import { readJsonFile } from "../../shared/store/jsonFile";
import type { Db } from "../db/Db";

interface RawThread {
  rootId?: string;
  tweets?: { article?: { coverImageUrl?: string; blocks?: unknown[] } }[];
}

/** Whether an item is an X Article and its cover image url, from the collected items. Never throws. */
export function xArticleMeta(itemsPath: string): (itemId: string) => Promise<{ isArticle: boolean; coverImageUrl?: string }> {
  return async (itemId: string) => {
    if (!itemId.startsWith("x:")) return { isArticle: false };
    let threads: RawThread[];
    try {
      threads = await readJsonFile<RawThread[]>(itemsPath, []);
    } catch {
      return { isArticle: false };
    }
    const thread = threads.find((t) => t.rootId === itemId.slice(2));
    // Match XContentSource's definition: an article contributes markdown to koreanText only when it has
    // body blocks, so a metadata-only article (blocks not fetched) is NOT sent — its koreanText would
    // not be the article's `# Title` markdown that X Article requires.
    const article = thread?.tweets?.map((t) => t.article).find((a) => a?.blocks?.length);
    if (!article) return { isArticle: false };
    return { isArticle: true, coverImageUrl: article.coverImageUrl };
  };
}

interface XThreadTweetsRow {
  tweets: { article?: { coverImageUrl?: string; blocks?: unknown[] } }[];
}

/** The database equivalent of `xArticleMeta` above — reads the `x_threads` table (by `root_id`)
 *  instead of `x/items.json`. Same definition of "is an article": body blocks must be present, not
 *  just metadata. Never throws — a lookup failure is not a reason to fail an otherwise-ready send. */
export function pgXArticleMeta(db: Db): (itemId: string) => Promise<{ isArticle: boolean; coverImageUrl?: string }> {
  return async (itemId: string) => {
    if (!itemId.startsWith("x:")) return { isArticle: false };
    let rows: XThreadTweetsRow[];
    try {
      rows = await db.query<XThreadTweetsRow>(`select tweets from x_threads where root_id = $1`, [itemId.slice(2)]);
    } catch {
      return { isArticle: false };
    }
    const article = rows[0]?.tweets?.map((t) => t.article).find((a) => a?.blocks?.length);
    if (!article) return { isArticle: false };
    return { isArticle: true, coverImageUrl: article.coverImageUrl };
  };
}
