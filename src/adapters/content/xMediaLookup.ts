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
    // Never throw: a corrupt/half-written items.json must not fail an otherwise-fine (text-only)
    // send — readJsonFile only maps ENOENT to the default, and re-throws on malformed JSON.
    let threads: RawThread[];
    try {
      threads = await readJsonFile<RawThread[]>(itemsPath, []);
    } catch {
      return [];
    }
    const thread = threads.find((t) => t.rootId === rootId);
    if (!thread?.tweets) return [];
    return thread.tweets
      .flatMap((t) => t.media ?? [])
      .filter((m) => m.type === "photo" && typeof m.url === "string")
      .map((m) => m.url as string);
  };
}
