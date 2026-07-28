import { readJsonFile } from "../../shared/store/jsonFile";

interface RawThread {
  rootId?: string;
  tweets?: { article?: { coverImageUrl?: string } }[];
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
    const article = thread?.tweets?.map((t) => t.article).find((a) => a);
    if (!article) return { isArticle: false };
    return { isArticle: true, coverImageUrl: article.coverImageUrl };
  };
}
