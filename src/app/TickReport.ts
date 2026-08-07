/**
 * What one scheduled tick did, and — if it went wrong — where and why.
 *
 * Shared by `WatchTick` and `ConvertTick` rather than declared twice, because the thing that reads
 * it is shared too: `src/cli/tickOutcome.ts` turns this into the single journal line systemd's
 * `OnFailure=` hook tails into a Telegram alert. Two structurally identical types would let one of
 * them grow a field the formatter never learned to print, which is a failure detail that exists in
 * the process and never reaches the phone.
 *
 * `stagesRun` is every `pnpm <script>` stage the tick actually reached, in order, including the
 * `status` runs that bracket an agent pass — it is the "(ran …)" suffix of the outcome line, and the
 * only record of how far a failed tick got. `failure.stage` may name a stage that is NOT in that
 * list: an agent pass reports itself as `claude-agent:<kind>` (see `agentStage`), which is not a
 * pnpm script and is never pushed there.
 */
export type TickReport = {
  ok: boolean;
  stagesRun: string[];
  failure?: { stage: string; detail: string };
};
