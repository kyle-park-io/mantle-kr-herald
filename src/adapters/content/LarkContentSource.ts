import type { LarkMessage } from "../../domain/larkMessage";
import type { ContentItem } from "../../domain/translation/contentItem";
import type { ContentSource } from "../../ports/ContentSource";
import { readJsonFile } from "../../shared/store/jsonFile";

export class LarkContentSource implements ContentSource {
  constructor(private readonly itemsPath: string) {}

  async loadPending(translatedIds: Set<string>): Promise<ContentItem[]> {
    const messages = await readJsonFile<LarkMessage[]>(this.itemsPath, []);
    const items: ContentItem[] = [];
    for (const m of messages) {
      const id = `lark:${m.messageId}`;
      if (translatedIds.has(id)) continue;
      items.push({ id, source: "lark", text: m.text, createdAt: m.createdAt });
    }
    return items;
  }
}
