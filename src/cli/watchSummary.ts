import type { TickReport } from "../app/WatchTick";
import { tickOutcome, type TickOutcome } from "./tickOutcome";

export type WatchOutcome = TickOutcome;

/**
 * `watch.ts`'s outcome line: `tickOutcome` under this command's own label.
 *
 * The formatting, the 300-character detail cap and the reasoning behind both moved to
 * `./tickOutcome` when `convert:tick` became a second scheduled tick needing the identical line —
 * two copies of a rule about what survives `deploy/herald-notify-failure.sh`'s tail-slice is two
 * places for it to stop being true. This wrapper stays so `watch.ts` and its tests keep naming the
 * command they are about rather than passing a string literal around.
 */
export function watchOutcome(report: TickReport): WatchOutcome {
  return tickOutcome("watch", report);
}
