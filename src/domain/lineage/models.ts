export type LineageStage = "translated" | "converted" | "rendered";

export interface LineageEntry {
  itemId: string;
  stage: LineageStage;
  variant?: string; // stage qualifier: type ("announcement") or "type/channel" ("announcement/telegram")
  content: string; // the meaningful text produced at this stage
  status?: string; // the record's status at this point
  sourceText?: string; // only on a "translated" entry: the English 원문
  at: string; // ISO timestamp
}
