/**
 * Serializes async jobs run through the returned function: each call waits for every job already
 * queued on that same serializer to settle before it starts. `writeJsonFileAtomic` makes each write
 * all-or-nothing, but a read-modify-write pair — read the file, mutate in memory, write it back — is
 * not atomic across two calls: two overlapping calls both read the same file and the second rename
 * silently discards the first one's row. A ledger that runs both a scheduled reconcile pass and an
 * operator-triggered send against the same instance hits that overlap routinely — and a dropped row
 * means a live post the ledger cannot see, which the next run publishes a second time.
 *
 * Each call to `createSerializer()` returns a fresh, independent chain — jobs only serialize against
 * other jobs submitted through the *same* returned function. Two instances of the same store class
 * have two independent chains and do not protect each other, and two *processes* never can: this is
 * an in-memory queue, so a `pnpm send:channels` run and the dashboard's `pnpm serve` see nothing of
 * each other's writes.
 *
 * The send ledgers — `JsonDeliveryLedger` and `JsonXArticleLedger`, the two stores whose rows record
 * something irreversible — therefore wrap this in `withFileLock` (see `./fileLock`), which closes
 * that gap on disk. The two layers are complementary, not redundant: this one is a free in-process
 * queue, the lock is the cross-process one. Stores whose worst case is lost review work rather than
 * a duplicate live post use this serializer alone.
 */
export function createSerializer(): <T>(fn: () => Promise<T>) => Promise<T> {
  let queue: Promise<void> = Promise.resolve();
  return function serial<T>(fn: () => Promise<T>): Promise<T> {
    const next = queue.then(fn);
    // A rejected predecessor must not prevent the next job from running, or one failed job would
    // wedge every job on this serializer after it. Converting both outcomes of `next` to a resolved
    // `void` is what keeps `queue` itself from ever rejecting, so the line above never needs an
    // onRejected handler of its own.
    queue = next.then(() => {}, () => {});
    return next;
  };
}
