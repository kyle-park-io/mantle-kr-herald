import type { ContentItem } from "../../domain/translation/contentItem";
import type { ContentSource } from "../../ports/ContentSource";

export class CompositeContentSource implements ContentSource {
  constructor(private readonly sources: ContentSource[]) {}

  async loadPending(translatedIds: Set<string>): Promise<ContentItem[]> {
    const all: ContentItem[] = [];
    for (const source of this.sources) {
      all.push(...(await source.loadPending(translatedIds)));
    }
    return all;
  }
}
