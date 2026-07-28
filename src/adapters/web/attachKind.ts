// src/adapters/web/attachKind.ts
import type { Translation } from "../../domain/translation/models";
import type { ContentItem } from "../../domain/translation/contentItem";

export type ApiTranslation = Translation & { kind?: "post" | "article" };

/**
 * Attach each source item's `kind` (post/article) to its translation, joined by itemId.
 * Display-only: `kind` is never persisted on Translation. Pure; does not mutate inputs.
 * A translation whose source item is absent (aged out, or a Lark item) gets no kind.
 */
export function attachKind(translations: Translation[], items: ContentItem[]): ApiTranslation[] {
  const kindById = new Map(items.map((i) => [i.id, i.kind] as const));
  return translations.map((t) => ({ ...t, kind: kindById.get(t.itemId) }));
}
