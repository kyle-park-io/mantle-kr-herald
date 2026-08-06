export type StageResult = { ok: true; stdout: string } | { ok: false; stage: string; detail: string };

export type StageRunner = (script: string, args: string[]) => Promise<StageResult>;

export type WorksheetKind = "translation" | "alignment";

export interface WorksheetAgent {
  fill(worksheetPath: string, kind: WorksheetKind): Promise<StageResult>;
}

/**
 * The stage name a failed agent pass reports. Lives here, next to the port, because two modules
 * need to produce the identical string and must not drift: `ClaudeCodeAgent` names its own
 * failures with it, and `WatchTick` names the *same* pass with it when its post-pass check finds
 * that a cleanly-exited agent saved nothing. A journal line saying `claude-agent:translation` has
 * to mean the same pass in both cases.
 */
export const agentStage = (kind: WorksheetKind): string => `claude-agent:${kind}`;
