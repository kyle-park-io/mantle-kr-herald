import type { ContentItem } from "../domain/translation/contentItem";

export interface ContentSource {
  /** Collected items not yet translated (id not in translatedIds). */
  loadPending(translatedIds: Set<string>): Promise<ContentItem[]>;
}
