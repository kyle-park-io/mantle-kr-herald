// src/adapters/web/attachKind.ts
import type { Translation } from "../../domain/translation/models";
import type { ContentItem } from "../../domain/translation/contentItem";

export type ApiTranslation = Translation & {
  kind?: "post" | "article";
  /**
   * Source item's post date (ISO), for the dashboard's [YYMMDD] prefix. Named `sourcePostedAt`
   * rather than `postedAt` — a plain intersection field of that name would silently type-check
   * against `Translation.postedAt` (Task 2's reconcile-match timestamp; both are `string |
   * undefined`), and TypeScript gives zero protection against one meaning quietly overwriting the
   * other. `sourcePostedAt` cannot collide with anything on `Translation`, so this type's own shape
   * is proof the override is deliberate rather than accidental — see `attachKind()` below, which no
   * longer has anything to overwrite.
   */
  sourcePostedAt?: string;
};

/**
 * Attach each source item's display metadata (`kind`, `sourcePostedAt`) to its translation, joined
 * by itemId. Display-only: neither is persisted on Translation. Pure; does not mutate inputs.
 * A translation whose source item is absent (aged out, or a Lark item) simply gets no metadata.
 *
 * Unlike an earlier version of this function, this does NOT touch `t.postedAt` — that field is the
 * domain's own (Task 2's reconcile-match timestamp), and passes through unmodified via the spread.
 * The two concepts share no field name any more, so there is nothing here to shadow.
 */
export function attachKind(translations: Translation[], items: ContentItem[]): ApiTranslation[] {
  const byId = new Map(items.map((i) => [i.id, i] as const));
  return translations.map((t) => {
    const item = byId.get(t.itemId);
    return { ...t, kind: item?.kind, sourcePostedAt: item?.createdAt };
  });
}
