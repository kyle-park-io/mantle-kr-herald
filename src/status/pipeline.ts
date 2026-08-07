export interface StatusInput {
  collected: number;
  translations: { status: string }[];
  /**
   * Rows, not items — and past the translation stage the two stop agreeing. A variant is keyed
   * `(itemId, type)` and a rendering `(itemId, type, channel)`, so one approved translation becomes
   * several of each. Read as bare totals the stages appear to gain work between them (10 converted
   * → 13 rendered) when three items simply fanned out twice, and the eye reads a funnel where the
   * pipeline branches. Hence `itemId` here: every fan-out stage reports how many items it covers.
   */
  variants: { itemId: string; status: string }[];
  renderings: { itemId: string; status: string }[];
  /**
   * Ledger rows, one per `(itemId, status, target)` upload. Not downstream of `renderings` at all —
   * this is the *translation* markdown on Drive, a sibling branch off the translation stage. Items
   * appear here with no rendering to their name, and always will.
   */
  published: { itemId: string }[];
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

/** Distinct items behind a set of rows — the only count comparable with the stage before it. */
export const itemCount = (rows: { itemId: string }[]): number => new Set(rows.map((r) => r.itemId)).size;

const fannedOutNote = (rows: { itemId: string; status: string }[]) =>
  `${itemCount(rows)} items · approved ${approved(rows)}`;

export function pipelineStages(input: StatusInput): StageCount[] {
  return [
    { label: "Collected (X + Lark)", total: input.collected },
    { label: "Translated", total: input.translations.length, note: translatedNote(input.translations) },
    { label: "Converted (variants)", total: input.variants.length, note: fannedOutNote(input.variants) },
    { label: "Rendered (channels)", total: input.renderings.length, note: fannedOutNote(input.renderings) },
    { label: "Published (drive)", total: input.published.length, note: `${itemCount(input.published)} items` },
  ];
}

/**
 * How many distinct items reached a stage, and how many rows that produced there. Equal until the
 * pipeline starts branching; past that, `rows` alone is the number that made 변환 10 → 렌더 13 read
 * as though the pipeline gained work between two stages.
 */
export interface StageTally {
  items: number;
  rows: number;
}

export interface FunnelCounts {
  collected: StageTally;
  translated: StageTally;
  converted: StageTally;
  rendered: StageTally;
  published: StageTally;
}

/**
 * The dashboard header's numbers, from the same `StatusInput` `pipelineStages` renders for the CLI.
 *
 * One function for both readers on purpose: they were separate, and the separation showed — the CLI
 * learned to report the terminal `posted` status while the header kept counting it as work in
 * progress, and nothing in the code connected the two well enough to make that obvious.
 */
export function funnelCounts(input: StatusInput): FunnelCounts {
  // Collected and translated are one row per item — `x_threads.root_id` and `translations.item_id`
  // are primary keys — so their two counts are equal by construction, not by coincidence.
  const perItem = (n: number): StageTally => ({ items: n, rows: n });
  const fanOut = (rows: { itemId: string }[]): StageTally => ({ items: itemCount(rows), rows: rows.length });
  return {
    collected: perItem(input.collected),
    translated: perItem(input.translations.length),
    converted: fanOut(input.variants),
    rendered: fanOut(input.renderings),
    published: fanOut(input.published),
  };
}

export function formatStatus(stages: StageCount[]): string {
  const labelW = stages.reduce((w, s) => Math.max(w, s.label.length), 0);
  const numW = stages.reduce((w, s) => Math.max(w, String(s.total).length), 0);
  const lines = stages.map(
    (s) => `  ${s.label.padEnd(labelW)}  ${String(s.total).padStart(numW)}${s.note ? `   (${s.note})` : ""}`,
  );
  return ["Pipeline status", "", ...lines].join("\n");
}
