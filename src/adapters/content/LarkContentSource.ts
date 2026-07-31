import type { LarkMessage } from "../../domain/larkMessage";
import type { ContentItem } from "../../domain/translation/contentItem";
import type { ContentSource } from "../../ports/ContentSource";
import { readJsonFile } from "../../shared/store/jsonFile";

/**
 * Pure: flattens collected Lark messages to `ContentItem[]`, filtering out ids already in
 * `translatedIds`. Only `messageId`/`text`/`createdAt` are read. Shared by `LarkContentSource`
 * (reads `lark-items.json`) and `PgContentSource` (reads the `lark_items` table) so both sources
 * flatten messages exactly the same way.
 */
export function flattenLarkMessages(
  messages: Pick<LarkMessage, "messageId" | "text" | "createdAt">[],
  translatedIds: Set<string>,
): ContentItem[] {
  const items: ContentItem[] = [];
  for (const m of messages) {
    const id = `lark:${m.messageId}`;
    if (translatedIds.has(id)) continue;
    items.push({ id, source: "lark", text: m.text, createdAt: m.createdAt });
  }
  return items;
}

export class LarkContentSource implements ContentSource {
  constructor(private readonly itemsPath: string) {}

  async loadPending(translatedIds: Set<string>): Promise<ContentItem[]> {
    const messages = await readJsonFile<LarkMessage[]>(this.itemsPath, []);
    return flattenLarkMessages(messages, translatedIds);
  }
}
