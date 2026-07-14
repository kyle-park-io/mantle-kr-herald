import type { CollectedThread } from "../../domain/models";
import type { ContentItem } from "../../domain/translation/contentItem";
import type { ContentSource } from "../../ports/ContentSource";
import { readJsonFile } from "../../shared/store/jsonFile";

export class XContentSource implements ContentSource {
  constructor(private readonly itemsPath: string) {}

  async loadPending(translatedIds: Set<string>): Promise<ContentItem[]> {
    const threads = await readJsonFile<CollectedThread[]>(this.itemsPath, []);
    const items: ContentItem[] = [];
    for (const thread of threads) {
      if (thread.status !== "active") continue;
      const id = `x:${thread.rootId}`;
      if (translatedIds.has(id)) continue;
      const first = thread.tweets[0];
      items.push({
        id,
        source: "x",
        text: thread.tweets.map((t) => t.text).join("\n\n"),
        createdAt: first?.createdAt ?? "",
        refUrl: first?.url,
      });
    }
    return items;
  }
}
