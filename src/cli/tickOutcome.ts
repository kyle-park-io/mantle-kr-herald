import type { TickReport } from "../app/TickReport";
import { condense } from "../shared/text/condense";

export type TickOutcome = { line: string; exitCode: 0 | 1 };

/**
 * The last place a failure detail can still be made one line long. `runStage` already caps the
 * stderr it puts in a detail, but not every detail comes from there — `ClaudeCodeAgent` builds its
 * own from `claude -p`'s stderr or its `result` text, and a `WorksheetAgent` implementation added
 * later needn't cap anything at all. Capping here means the invariant that actually matters — the
 * printed line is one journal entry, short enough that `deploy/herald-notify-failure.sh`'s
 * 500-character tail-slice still contains the `<label>: FAILED — <stage>:` prefix — holds no matter
 * who produced the detail.
 */
const MAX_DETAIL_CHARS = 300;

/**
 * Turns a `TickReport` into the one line a scheduled tick's entry point prints, and the exit code it
 * sets. Pulled out of those entry points so this decision — the one thing standing between a broken
 * tick and systemd's `OnFailure=` hook noticing — is unit-testable without spawning a real process
 * or a real tick. Each entry point's own job is only to call this and act on the result; no
 * sequencing decision belongs there (those all live in the tick classes, where they're tested).
 *
 * `label` is the command's own name (`watch`, `convert`), and it is the first thing on the line for
 * a reason: the failure hook is templated over units and both schedulers send into the same Telegram
 * room, so "which scheduler is this?" has to be answerable from the message text alone, not only
 * from the unit name systemd puts above it.
 */
export function tickOutcome(label: string, report: TickReport): TickOutcome {
  const stages = report.stagesRun.length > 0 ? report.stagesRun.join(" → ") : "(none)";

  if (report.ok) {
    return { line: `${label}: ok — ran ${stages}`, exitCode: 0 };
  }

  const detail = report.failure
    ? condense(`${report.failure.stage}: ${report.failure.detail}`, MAX_DETAIL_CHARS)
    : "unknown failure";
  return { line: `${label}: FAILED — ${detail} (ran ${stages})`, exitCode: 1 };
}
