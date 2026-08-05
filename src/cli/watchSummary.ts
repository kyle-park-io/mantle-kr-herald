import type { TickReport } from "../app/WatchTick";

export type WatchOutcome = { line: string; exitCode: 0 | 1 };

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

  const detail = report.failure ? `${report.failure.stage}: ${report.failure.detail}` : "unknown failure";
  return { line: `watch: FAILED — ${detail} (ran ${stages})`, exitCode: 1 };
}
