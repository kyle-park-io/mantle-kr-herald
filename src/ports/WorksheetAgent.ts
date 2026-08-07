export type StageResult = { ok: true; stdout: string } | { ok: false; stage: string; detail: string };

export type StageRunner = (script: string, args: string[]) => Promise<StageResult>;

/**
 * Which worksheet the agent is being asked to fill, and therefore which directory it may touch and
 * which single `pnpm` command it may run. `translation` and `alignment` both end in
 * `pnpm translate:save`; `conversion` ends in `pnpm convert:save` and reads a different directory
 * entirely (`paths.variantsWorksheets`). `ClaudeCodeAgent` holds one profile per kind — adding a
 * kind here without one there is a type error, which is the point.
 */
export type WorksheetKind = "translation" | "alignment" | "conversion";

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
