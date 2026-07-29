import { PUBLISH_DELAY_MS } from "../adapters/send/typefullyPublish";

type ReconcilePass = () => Promise<{ reconciled: number; pending: number; error?: string }>;

/**
 * Poll Typefully for scheduled drafts that have gone live, so the board stops showing `예약됨` for
 * a post that published minutes ago without anyone clicking [게시 확인].
 *
 * The interval matches the delay a send schedules with: checking faster than posts can publish only
 * spends rate limit. An idle tick is genuinely free — `ReconcilePublished` skips every row that is
 * not awaiting publish before it calls Typefully, so a board with nothing pending makes no requests.
 */
export function startReconcileScheduler(
  run: ReconcilePass,
  opts: { intervalMs?: number; log?: (msg: string) => void } = {},
): () => void {
  const intervalMs = opts.intervalMs ?? PUBLISH_DELAY_MS;
  const log = opts.log ?? console.warn;
  let running = false;

  const timer = setInterval(() => {
    // Typefully can be slow; a second pass over the same rows would only double the lookups.
    if (running) return;
    running = true;
    void run()
      .then((r) => {
        if (r.error) log(`[reconcile] pass reported an error: ${r.error}`);
        else if (r.reconciled > 0) log(`[reconcile] ${r.reconciled} row(s) now carry their x.com url`);
      })
      .catch((err) => log(`[reconcile] pass failed: ${(err as Error).message}`))
      .finally(() => { running = false; });
  }, intervalMs);

  // Never hold the process open for a background poll.
  timer.unref?.();
  return () => clearInterval(timer);
}
