import { readJsonFile } from "../../shared/store/jsonFile";

interface RawMedia {
  type?: string;
  url?: string;
}
interface RawThread {
  rootId?: string;
  status?: string;
  tweets?: { media?: RawMedia[] }[];
}

/**
 * A send-time photo lookup backed by the collected X items. Returns every photo url a post carries
 * (article images live in the article body, not `media`, so an article yields []). Never throws:
 * a missing file / unknown id / text-only item all return []. Photos only — videos are excluded.
 */
export function xPhotos(itemsPath: string): (itemId: string) => Promise<string[]> {
  return async (itemId: string): Promise<string[]> => {
    if (!itemId.startsWith("x:")) return [];
    const rootId = itemId.slice(2);
    const threads = await readJsonFile<RawThread[]>(itemsPath, []);
    const thread = threads.find((t) => t.rootId === rootId);
    if (!thread?.tweets) return [];
    return thread.tweets
      .flatMap((t) => t.media ?? [])
      .filter((m) => m.type === "photo" && typeof m.url === "string")
      .map((m) => m.url as string);
  };
}
