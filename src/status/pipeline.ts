import {
  collectedScopeNote,
  formatTranslateFloor,
  type CollectedScope,
  type TranslateFloorStatus,
} from "./translateFloor";

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

/**
 * `scope` is not optional, and that is the fix. Every collected item the scheduler will never look
 * at is still counted in this stage's total, so a bare `Collected (X + Lark)  108` reads as a
 * backlog of 108 — it was read that way, and reported to a human that way, on 2026-08-08. Requiring
 * the scope means the table cannot be rendered without stating how much of that total the
 * translation floor actually leaves in reach (`./translateFloor`).
 *
 * The scope's optional `intake` extends the same line backwards, to what collection found before the
 * reply filter took 41% of it: `223 X threads - 92 replies dropped + 3 Lark · in scope 20 · below
 * floor 114`. One line, left to right, no second output line — `WatchTick`/`ConvertTick` parse this
 * stdout, and every line that is not a stage line is one more thing they have to be safe against.
 */
export function pipelineStages(input: StatusInput, scope: CollectedScope): StageCount[] {
  return [
    { label: "Collected (X + Lark)", total: input.collected, note: collectedScopeNote(scope) },
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

/**
 * Where to go when the question was actually about history.
 *
 * Every number above is a `status` column: where a record stands *now*. The `translatedNote`
 * comment names what that hides; this names the tool that does not hide it. Without a pointer here
 * the next person reads a count as a history — which has already happened, by hand-rolling
 * `select status, count(*) from translations`, seeing `approved 0`, and concluding 1차 검수 had
 * stalled for ten days when the day before had carried 22 events.
 *
 * ⚠️ **`src/app/WatchTick.ts` parses this command's stdout and fails a scheduled tick on output it
 * does not recognise.** Its `TRANSLATED_LINE = /^\s*Translated\s+(\d+)/m` is line-anchored with the
 * `m` flag, so extra lines are safe *provided none of them begins with optional whitespace and the
 * word `Translated` followed by a number* — a second match would be found before the real stage
 * line and read as the translated total. Neither line below starts with a capitalised word at all.
 * `tests/app/watchTick.test.ts` builds its `pnpm status` fixture by calling this function, so that
 * suite is the regression check; do not hand-write a fixture there.
 */
const HISTORY_POINTER = [
  "  these are current states, not a history — a `posted` row was `approved` once and no longer says so",
  "  `pnpm lineage --activity` rolls up the append-only lineage by date: what happened, and when",
];

/**
 * `floor` is required for the same reason `pipelineStages`'s scope is: the floor's only real home is
 * a systemd unit, so before this line existed there was no read-only way to ask what the scheduler
 * would actually select with — which is exactly why the Collected total was so easy to misread.
 * Printed here rather than left to the caller so it travels with the table it qualifies.
 */
export function formatStatus(stages: StageCount[], floor: TranslateFloorStatus): string {
  const labelW = stages.reduce((w, s) => Math.max(w, s.label.length), 0);
  const numW = stages.reduce((w, s) => Math.max(w, String(s.total).length), 0);
  const lines = stages.map(
    (s) => `  ${s.label.padEnd(labelW)}  ${String(s.total).padStart(numW)}${s.note ? `   (${s.note})` : ""}`,
  );
  return ["Pipeline status", "", ...lines, "", ...formatTranslateFloor(floor), "", ...HISTORY_POINTER].join("\n");
}
