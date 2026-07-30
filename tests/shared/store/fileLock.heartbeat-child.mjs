import { withFileLock } from "../../../src/shared/store/fileLock.ts";

// A hold that never settles — the pathological case the heartbeat exists for, reached in real life
// by a job awaiting something that never comes back, or by a caller that races the lock promise
// against a timeout and abandons it. `withFileLock` never returns here, so its `finally` never runs
// and the heartbeat's timer is still armed when this process runs out of work.
//
// A short-lived CLI must exit anyway. Every caller of this module is one — `pnpm send:channels` and
// friends — and if the heartbeat's interval is not `unref`'d it becomes the only thing holding the
// event loop open, so the command hangs forever with no output and no way to tell why. Exiting
// instead leaves a lock file behind, which is the ordinary crash path the staleness window already
// recovers from within `staleMs`.
const [, , path] = process.argv;

void withFileLock(path, () => new Promise(() => {}), { staleMs: 200 });

// Long enough for the lock to be acquired and several beats to have fired, so the timer under test
// is demonstrably live rather than merely scheduled. This `setTimeout` is ref'd and is the only
// thing keeping the process up until it fires; what happens after it is the actual assertion.
await new Promise((r) => setTimeout(r, 400));
