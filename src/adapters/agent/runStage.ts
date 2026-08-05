import type { StageResult, StageRunner } from "../../ports/WorksheetAgent";
import { spawnCapture } from "./spawnCapture";

/**
 * The `StageRunner` `WatchTick` drives every pipeline stage (`collect`, `translate:prepare`,
 * `translate:align`) through: `pnpm <script> <args...>`, spawned via `spawnCapture` — see that
 * module for why this is an argv array rather than a shell command string, and why `cwd` is fixed
 * to the repo root regardless of the caller's own working directory (a systemd unit, a developer's
 * shell elsewhere, or a test runner).
 *
 * A non-zero exit becomes `{ ok: false, stage: script, detail }`, with `stderr` in the detail —
 * falling back to a generic reason only when the failing script left stderr empty (e.g. `pnpm`
 * itself printing a "script not found" message to stdout instead, as it does for an unknown
 * script name).
 */
export const runStage: StageRunner = async (script, args): Promise<StageResult> => {
  let result;
  try {
    result = await spawnCapture("pnpm", [script, ...args]);
  } catch (err) {
    return {
      ok: false,
      stage: script,
      detail: `pnpm ${script} failed to start: ${err instanceof Error ? err.message : String(err)}`,
    };
  }

  if (result.code === 0) {
    return { ok: true, stdout: result.stdout };
  }

  const detail = result.stderr.trim() || `pnpm ${script} exited with code ${result.code}`;
  return { ok: false, stage: script, detail };
};
