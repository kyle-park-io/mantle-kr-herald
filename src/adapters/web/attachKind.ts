// src/adapters/web/attachKind.ts
import type { Translation } from "../../domain/translation/models";
import type { ContentItem } from "../../domain/translation/contentItem";

export type ApiTranslation = Translation & {
  kind?: "post" | "article";
  /** Source item's post date (ISO), for the dashboard's [YYMMDD] prefix. */
  postedAt?: string;
};

/**
 * Attach each source item's display metadata (`kind`, `postedAt`) to its translation, joined by
 * itemId. Display-only: neither is persisted on Translation. Pure; does not mutate inputs.
 * A translation whose source item is absent (aged out, or a Lark item) simply gets no metadata.
 */
export function attachKind(translations: Translation[], items: ContentItem[]): ApiTranslation[] {
  const byId = new Map(items.map((i) => [i.id, i] as const));
  return translations.map((t) => {
    const item = byId.get(t.itemId);
    return { ...t, kind: item?.kind, postedAt: item?.createdAt };
  });
}
