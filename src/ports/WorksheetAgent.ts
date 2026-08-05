export type StageResult = { ok: true; stdout: string } | { ok: false; stage: string; detail: string };

export type StageRunner = (script: string, args: string[]) => Promise<StageResult>;

export interface WorksheetAgent {
  fill(worksheetPath: string, kind: "translation" | "alignment"): Promise<StageResult>;
}
