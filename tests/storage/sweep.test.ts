import { describe, it, expect } from "vitest";
import { mkdir, mkdtemp, symlink, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LOCK_STALE_MS, RECLAIM_CONFIRM_MS } from "../../src/shared/store/fileLock";
import { collectWriteDebris } from "../../src/storage/sweep";

const scratch = () => mkdtemp(join(tmpdir(), "sweep-"));

const TEMP_NAME = "items.json.tmp-4821-1750000000000-3f2b1c9d-aaaa-bbbb-cccc-ddddeeeeffff";

/** Backdates a path so the sweep sees it as abandoned rather than possibly-held. */
async function backdate(path: string, byMs: number): Promise<void> {
  const at = new Date(Date.now() - byMs);
  await utimes(path, at, at);
}

describe("collectWriteDebris", () => {
  it("collects a temp file stranded by an interrupted atomic write", async () => {
    const dir = await scratch();
    await writeFile(join(dir, TEMP_NAME), "");
    await backdate(join(dir, TEMP_NAME), LOCK_STALE_MS + 60_000);
    await writeFile(join(dir, "items.json"), "[]");
    expect(await collectWriteDebris(dir)).toEqual([join(dir, TEMP_NAME)]);
  });

  /**
   * REGRESSION: the age gate this branch added guarded `.lock` only, and `.tmp-*` fell straight
   * through to the collect. `writeJsonFileAtomic` writes its temp file and *then* renames it, so a
   * `pnpm clean --yes` landing in that gap removed the file the rename was about to move: the
   * rename throws ENOENT, `SendChannels` warns "was SENT but could NOT be recorded in the ledger —
   * a rerun will re-send it", and the next run posts the same copy into the live room again.
   *
   * A freshly-written temp file IS that gap — there is no other state a young one can be in.
   */
  it("leaves a temp file young enough to be an atomic write mid-rename", async () => {
    const dir = await scratch();
    await writeFile(join(dir, TEMP_NAME), "[]");
    await writeFile(join(dir, "deliveries.json"), "[]");
    expect(await collectWriteDebris(dir)).toEqual([]);
  });

  it("collects a lock whose owner plainly died", async () => {
    const dir = await scratch();
    const lock = join(dir, "deliveries.json.lock");
    await writeFile(lock, "4821\n");
    await backdate(lock, LOCK_STALE_MS + 60_000);
    // `confirmMs` only shortens the wait the sweep would take anyway — the default is asserted below.
    expect(await collectWriteDebris(dir, { confirmMs: 20 })).toEqual([lock]);
  });

  /**
   * REGRESSION: the sweep and the lock module read the same predicate off the same files, and the
   * sweep was the more permissive of the two. A lock may only be taken from its owner once it has
   * looked stale for `LOCK_STALE_MS` *and* stayed that way for `RECLAIM_CONFIRM_MS`; the sweep gated
   * on the first half alone, so for one second per window `pnpm clean --yes` deleted a lock that
   * `reclaimIfStale` itself still refused to touch — and a deleted lock lets a second process
   * interleave a read-modify-write of the ledger, drop a row, and re-send a live post.
   */
  it("leaves a lock the lock module itself would not yet reclaim", async () => {
    const dir = await scratch();
    const lock = join(dir, "deliveries.json.lock");
    await writeFile(lock, "4821\n");
    await backdate(lock, LOCK_STALE_MS + RECLAIM_CONFIRM_MS / 2);
    expect(await collectWriteDebris(dir, { confirmMs: 20 })).toEqual([]);
  });

  /**
   * The other half, and the one age cannot answer. `mtime` is judged against `Date.now()`, and this
   * machine's wall clock steps forward by ~22.7s at a time — which adds its whole size to the
   * apparent age of every lock at once, including one a running send stamped milliseconds ago. So the
   * sweep confirms the same way the reclaimer does: an mtime that MOVED is the holder's own proof of
   * life, true without reference to any clock.
   *
   * The beat below lands *during* the confirmation window and leaves the stamp still 90s old — which
   * is precisely what a live holder looks like under a forward step, and what an age-only gate reads
   * as a corpse.
   */
  it("leaves a lock whose mtime moves while it is being watched", async () => {
    const dir = await scratch();
    const lock = join(dir, "deliveries.json.lock");
    await writeFile(lock, `${process.pid}\n`);
    await backdate(lock, 90_000);
    let beats = 0;
    const collected = await collectWriteDebris(dir, {
      confirmMs: 20,
      sleep: async () => {
        beats += 1;
        await backdate(lock, 90_000 - beats); // moved, still old
      },
    });
    expect(beats).toBe(1); // the window was actually entered, so the assertion below means something
    expect(collected).toEqual([]);
  });

  // Removing a lock a running send still holds would let a second process interleave a
  // read-modify-write of the same ledger and drop a row — a duplicate live post, caused by the
  // cleanup command.
  it("leaves a lock young enough to still be held by a running send", async () => {
    const dir = await scratch();
    await writeFile(join(dir, "deliveries.json.lock"), `${process.pid}\n`);
    expect(await collectWriteDebris(dir)).toEqual([]);
  });

  // REGRESSION: lock files are the most transient thing in the tree — created and deleted on every
  // ledger write — so a send releasing its lock between the readdir and the stat is the normal
  // case. Letting that ENOENT escape aborted the whole command in exactly the situation the
  // staleness gate exists to survive. A dangling symlink reproduces it deterministically: readdir
  // lists the name, stat follows the link and reports ENOENT.
  it("skips a lock that is released between the readdir and the stat", async () => {
    const dir = await scratch();
    await symlink(join(dir, "gone"), join(dir, "deliveries.json.lock"));
    await expect(collectWriteDebris(dir)).resolves.toEqual([]);
  });

  it("skips any other entry that disappears mid-walk", async () => {
    const dir = await scratch();
    await symlink(join(dir, "gone"), join(dir, "renderings.json"));
    await expect(collectWriteDebris(dir)).resolves.toEqual([]);
  });

  it("recurses into subdirectories but never collects a live store", async () => {
    const dir = await scratch();
    await mkdir(join(dir, "publish"), { recursive: true });
    await writeFile(join(dir, "publish", "deliveries.json"), "[]");
    await writeFile(join(dir, "publish", TEMP_NAME), "");
    await backdate(join(dir, "publish", TEMP_NAME), LOCK_STALE_MS + 60_000);
    expect(await collectWriteDebris(dir)).toEqual([join(dir, "publish", TEMP_NAME)]);
  });

  /**
   * REGRESSION, and the one the heartbeat introduced. `sweep.ts` says it in its own comment: a lock
   * and the `.tmp-*` written inside the critical section it guards "are produced by one write, and
   * judging them by two different clocks would let the sweep take one while the other is still
   * protected". That used to hold for free — both were stamped once and aged together. Then the lock
   * gained a heartbeat and the tmp did not, so a slow-but-healthy write now has a fresh lock beside a
   * tmp of any age. Taking that tmp makes the `rename` throw ENOENT, and `SendChannels` reports "was
   * SENT but could NOT be recorded in the ledger — a rerun will re-send it".
   *
   * So the tmp is judged by the lock on the store it is being renamed onto, not by its own mtime.
   */
  it("leaves a temp file guarded by a live lock, however old the temp file looks", async () => {
    const dir = await scratch();
    const tmp = join(dir, TEMP_NAME);
    await writeFile(tmp, "[]");
    await backdate(tmp, LOCK_STALE_MS + 60_000);
    // `items.json.lock` — the lock `withFileLock` takes on the store TEMP_NAME is renamed onto.
    await writeFile(join(dir, "items.json.lock"), `${process.pid}\n`);
    expect(await collectWriteDebris(dir, { confirmMs: 20 })).toEqual([]);
  });

  // …and the other side of it, or the test above would be satisfied by never collecting a temp file
  // again: with the store's lock as dead as the temp file, both are debris.
  it("collects a temp file whose guarding lock is dead too", async () => {
    const dir = await scratch();
    const tmp = join(dir, TEMP_NAME);
    const lock = join(dir, "items.json.lock");
    await writeFile(tmp, "[]");
    await writeFile(lock, "4821\n");
    await backdate(tmp, LOCK_STALE_MS + 60_000);
    await backdate(lock, LOCK_STALE_MS + 60_000);
    expect((await collectWriteDebris(dir, { confirmMs: 20 })).sort()).toEqual([lock, tmp].sort());
  });

  // The wait is the lock module's own confirmation window, and it is paid once per sweep rather than
  // once per candidate — a tree with debris in several stores must not add a second per store.
  it("waits the lock module's confirmation window, once", async () => {
    const dir = await scratch();
    await mkdir(join(dir, "publish"), { recursive: true });
    for (const p of [join(dir, "a.json.lock"), join(dir, "publish", "b.json.lock")]) {
      await writeFile(p, "4821\n");
      await backdate(p, LOCK_STALE_MS + 60_000);
    }
    const waits: number[] = [];
    const collected = await collectWriteDebris(dir, { sleep: async (ms) => void waits.push(ms) });
    expect(waits).toEqual([RECLAIM_CONFIRM_MS]);
    expect(collected).toHaveLength(2);
  });

  // Backdated past the age gate on purpose: without it this would pass for the wrong reason — the
  // file would be held back as possibly-live, and the test would stop saying anything about skipDir.
  it("leaves the archive alone — it has its own retention rule", async () => {
    const dir = await scratch();
    const archive = join(dir, "archive");
    await mkdir(archive, { recursive: true });
    await writeFile(join(archive, TEMP_NAME), "");
    await backdate(join(archive, TEMP_NAME), LOCK_STALE_MS + 60_000);
    expect(await collectWriteDebris(dir, { skipDir: archive })).toEqual([]);
  });
});
