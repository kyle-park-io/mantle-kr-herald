import type { ClaudeSpawnFn } from "../adapters/agent/ClaudeCodeAgent";
import { spawnCapture } from "../adapters/agent/spawnCapture";

/**
 * The real `ClaudeSpawnFn` wiring `watch.ts` hands to `ClaudeCodeAgent`. Pulled into its own,
 * named export rather than left as an inline lambda inside `watch.ts`, specifically so this exact
 * line — the one that forwards `ClaudeCodeAgent`'s abort signal into `spawnCapture` (which honours
 * it, proven on its own in `tests/adapters/agent/spawnCapture.test.ts`) — is importable by a test
 * without needing to run the full `watch.ts` pipeline. That pipeline can't reach this code at all
 * without a real, reachable database returning real collected work; `spawnCapture` alone proved
 * only that IT honours a signal, never that anything actually passes one through from here.
 *
 * See `tests/cli/claudeSpawnKill.test.ts`, which spawns a real process tree exercising exactly
 * this export (via `tests/cli/fixtures/claudeSpawnHarness.ts`) against a stub `claude` on `PATH`.
 */
export const realClaudeSpawn: ClaudeSpawnFn = (cmd, args, signal) => spawnCapture(cmd, args, { signal });
