import type { StageResult, StageRunner } from "../../ports/WorksheetAgent";
import { condense } from "../../shared/text/condense";
import { spawnCapture } from "./spawnCapture";

/**
 * A failing stage's stderr is raw: a Node stack trace, a pg driver error with a query in it, a
 * pnpm banner. It ends up inside the single line `watch.ts` prints, which
 * `deploy/herald-notify-failure.sh` reads back out of the journal with `journalctl -n 5` and then
 * tail-slices to 500 characters — so an untruncated multi-line stderr costs the alert its
 * `watch: FAILED — <stage>:` prefix entirely. 300 leaves room for that prefix and for
 * `watchSummary`'s `(ran …)` suffix inside the hook's budget while still carrying the first, most
 * diagnostic part of the message. See `condense`'s own doc comment for the mechanics.
 */
const MAX_STDERR_CHARS = 300;

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

  const detail = condense(result.stderr, MAX_STDERR_CHARS) || `pnpm ${script} exited with code ${result.code}`;
  return { ok: false, stage: script, detail };
};
