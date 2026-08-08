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

  /**
   * Lines a stage produced that are worth a human's attention but are not a failure — today, the
   * over-length emissions `FormatVariants` warns about (`ConvertTick`'s format stage).
   *
   * They exist because `runStage` captures each stage's stdout and a successful tick discards it:
   * without a way out of the report, a warning printed by a scheduled `pnpm format` is seen by
   * nobody, ever. `tickOutcome` prints them ahead of the outcome line, which keeps that line last —
   * `deploy/herald-notify-failure.sh` reads the journal's last 5 entries.
   *
   * Deliberately not a failure: an over-limit rendering is a copy problem for 2차 검수 to fix on the
   * board, where the length is shown per destination anyway. Failing the tick would page whoever is
   * on call because a Korean tweet came out two weighted characters long, and — worse — would leave
   * the tick's real work reported as broken.
   */
  notes?: string[];
};
