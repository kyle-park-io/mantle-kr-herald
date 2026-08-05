import type { TickReport } from "../app/WatchTick";
import { condense } from "../shared/text/condense";

export type WatchOutcome = { line: string; exitCode: 0 | 1 };

/**
 * The last place a failure detail can still be made one line long. `runStage` already caps the
 * stderr it puts in a detail, but not every detail comes from there — `ClaudeCodeAgent` builds its
 * own from `claude -p`'s stderr or its `result` text, and a `WorksheetAgent` implementation added
 * later needn't cap anything at all. Capping here means the invariant that actually matters — the
 * printed line is one journal entry, short enough that
 * `deploy/herald-notify-failure.sh`'s 500-character tail-slice still contains the
 * `watch: FAILED — <stage>:` prefix — holds no matter who produced the detail.
 */
const MAX_DETAIL_CHARS = 300;

/**
 * Turns a `TickReport` into the one line `watch.ts` prints and the exit code it sets. Pulled out of
 * `watch.ts` itself so this decision — the one thing standing between a broken tick and systemd's
 * `OnFailure=` hook noticing (Task 5) — is unit-testable without spawning a real process or a real
 * `WatchTick`. `watch.ts`'s own job is only to call this and act on the result; no sequencing
 * decision belongs there (those all live in `WatchTick`, where they're tested).
 */
export function watchOutcome(report: TickReport): WatchOutcome {
  const stages = report.stagesRun.length > 0 ? report.stagesRun.join(" → ") : "(none)";

  if (report.ok) {
    return { line: `watch: ok — ran ${stages}`, exitCode: 0 };
  }

  const detail = report.failure
    ? condense(`${report.failure.stage}: ${report.failure.detail}`, MAX_DETAIL_CHARS)
    : "unknown failure";
  return { line: `watch: FAILED — ${detail} (ran ${stages})`, exitCode: 1 };
}
