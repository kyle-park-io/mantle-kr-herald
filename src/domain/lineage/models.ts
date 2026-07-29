/**
 * `"forked"` is a room's own copy of a rendering, not a fourth pipeline step: a fork branches off
 * `"rendered"` rather than following it. It earns a stage of its own because its text is the one
 * thing in the pipeline that cannot be regenerated — re-running `format` produces the group text,
 * never the reviewer's per-room edit.
 */
export type LineageStage = "translated" | "converted" | "rendered" | "forked";

export interface LineageEntry {
  itemId: string;
  stage: LineageStage;
  // stage qualifier: type ("announcement"), "type/channel" ("announcement/telegram"), or — on a
  // "forked" entry — "type/outletId" ("announcement/tg-blockchain"), the same shape one axis over.
  variant?: string;
  content: string; // the meaningful text produced at this stage
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
  sourceText?: string; // only on a "translated" entry: the English 원문
  at: string; // ISO timestamp
}
