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
  status?: string; // the record's status at this point
  sourceText?: string; // only on a "translated" entry: the English 원문
  at: string; // ISO timestamp
}
