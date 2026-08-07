/**
 * `"forked"` is a room's own copy of a rendering, not a fourth pipeline step: a fork branches off
 * `"rendered"` rather than following it. It earns a stage of its own because its text is the one
 * thing in the pipeline that cannot be regenerated — re-running `format` produces the group text,
 * never the reviewer's per-room edit.
 */
export type LineageStage = "translated" | "converted" | "rendered" | "forked";

/**
 * A lineage row with its text left behind — when something happened and what kind of thing it was,
 * and nothing that grows with the copy.
 *
 * Split out of `LineageEntry` for `activity.ts`, which counts rows and never reads a word of one.
 * `content` on a single entry can be a whole X Article body (3,774–12,215 characters — see
 * `SaveTranslation`'s `MAX_FEW_SHOT_SOURCE_LENGTH` comment for where those numbers come from), and
 * a date rollup over the whole table would otherwise pull every byte of every version of every
 * item across the wire to do arithmetic on `at`. `LineageStore.listEvents` projects to this shape
 * in SQL for exactly that reason, and `LineageEntry` extends it rather than repeating its fields,
 * so a full entry is always a valid event and the two can never disagree about what a stage or a
 * status is.
 */
export interface LineageEvent {
  itemId: string;
  stage: LineageStage;
  /**
   * Normally the record's own status at this point ("translated", "rendered", "approved"). One
   * value is an *event* rather than a status: **`"reverted"`** means this entry records a removal
   * and its `content` is the text that was discarded — the record itself no longer exists.
   *
   * That string is a contract between `SaveOutletOverride` (the only producer today) and
   * `render.ts`, which branches on it to print the discarded text in full instead of a diff. It has
   * to be an event, because a reverted fork's text is normally byte-identical to the entry before
   * it: carried as the record's status, the one moment a text was destroyed would render as
   * "(내용 동일)". Any future producer of a removal should use the same string.
   */
  status?: string;
  at: string; // ISO timestamp
}

export interface LineageEntry extends LineageEvent {
  // stage qualifier: type ("announcement"), "type/channel" ("announcement/telegram"), or — on a
  // "forked" entry — "type/outletId" ("announcement/tg-blockchain"), the same shape one axis over.
  variant?: string;
  content: string; // the meaningful text produced at this stage
  sourceText?: string; // only on a "translated" entry: the English 원문
}
