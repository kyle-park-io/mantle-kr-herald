export interface StatusInput {
  collected: number;
  translations: { status: string }[];
  variants: { status: string }[];
  renderings: { status: string }[];
  published: number;
}

export interface StageCount {
  label: string;
  total: number;
  note?: string;
}

const approved = (items: { status: string }[]) => items.filter((i) => i.status === "approved").length;

/**
 * Translations are the one stage with a *terminal* status besides `approved`: reconcile retires a
 * hand-published item to `posted`, which leaves 1차 검수 for good. A bare `approved N` therefore
 * reads as "N of these totalN are done, the rest are waiting" — which is a lie the moment any item
 * is `posted`, and it lied loudly here (23 translations, `approved 0`, but only 2 actually waiting).
 * So this stage names all three buckets, actionable first. Variants and renderings keep the bare
 * `approved N` because they have no terminal third status to hide behind it.
 *
 * A rendering under a `posted` translation is deliberately NOT discounted anywhere: the X post
 * having gone out by hand says nothing about its 공지 still being owed to Telegram and Kakao.
 */
const translatedNote = (items: { status: string }[]) =>
  `pending ${items.filter((i) => i.status === "translated").length} · approved ${approved(items)}` +
  ` · posted ${items.filter((i) => i.status === "posted").length}`;

export function pipelineStages(input: StatusInput): StageCount[] {
  return [
    { label: "Collected (X + Lark)", total: input.collected },
    { label: "Translated", total: input.translations.length, note: translatedNote(input.translations) },
    { label: "Converted (variants)", total: input.variants.length, note: `approved ${approved(input.variants)}` },
    { label: "Rendered (channels)", total: input.renderings.length, note: `approved ${approved(input.renderings)}` },
    { label: "Published (drive)", total: input.published },
  ];
}

export function formatStatus(stages: StageCount[]): string {
  const labelW = stages.reduce((w, s) => Math.max(w, s.label.length), 0);
  const numW = stages.reduce((w, s) => Math.max(w, String(s.total).length), 0);
  const lines = stages.map(
    (s) => `  ${s.label.padEnd(labelW)}  ${String(s.total).padStart(numW)}${s.note ? `   (${s.note})` : ""}`,
  );
  return ["Pipeline status", "", ...lines].join("\n");
}
