import { describe, it, expect } from "vitest";
import { mkdir, mkdtemp, symlink, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { IN_PROGRESS_MS, collectWriteDebris } from "../../src/storage/sweep";

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
    await backdate(join(dir, TEMP_NAME), IN_PROGRESS_MS + 60_000);
    await writeFile(join(dir, "items.json"), "[]");
    expect(await collectWriteDebris(dir)).toEqual([join(dir, TEMP_NAME)]);
  });

  /**
   * REGRESSION: an age gate that only covered `.lock` and let `.tmp-*` fall straight through would
   * repeat the bug this one guards. `writeJsonFileAtomic` writes its temp file and *then* renames
   * it, so a `pnpm clean --yes` landing in that gap removes the file the rename was about to move:
   * the rename throws ENOENT, `SendChannels` warns "was SENT but could NOT be recorded in the
   * ledger — a rerun will re-send it", and the next run posts the same copy into the live room again.
   *
   * A freshly-written temp file IS that gap — there is no other state a young one can be in.
   */
  it("leaves a temp file young enough to be an atomic write mid-rename", async () => {
    const dir = await scratch();
    await writeFile(join(dir, TEMP_NAME), "[]");
    await writeFile(join(dir, "deliveries.json"), "[]");
    expect(await collectWriteDebris(dir)).toEqual([]);
  });

  // A `.lock` file is purely historical now — nothing acquires one — so it needs no liveness check
  // of its own; it is judged by the same plain age gate as a `.tmp-*`.
  it("collects a stray lock file left by a build old enough to have written one", async () => {
    const dir = await scratch();
    const lock = join(dir, "deliveries.json.lock");
    await writeFile(lock, "4821\n");
    await backdate(lock, IN_PROGRESS_MS + 60_000);
    expect(await collectWriteDebris(dir)).toEqual([lock]);
  });

  it("leaves a lock young enough that the age gate cannot yet tell it apart from a live write", async () => {
    const dir = await scratch();
    await writeFile(join(dir, "deliveries.json.lock"), `${process.pid}\n`);
    expect(await collectWriteDebris(dir)).toEqual([]);
  });

  // REGRESSION: lock files used to be the most transient thing in the tree — created and deleted on
  // every ledger write — so a send releasing its lock between the readdir and the stat was the
  // normal case. Nothing creates one any more, but a stray leftover disappearing mid-walk (someone
  // cleaning up by hand, a second `pnpm clean` racing this one) must not abort the whole command
  // either. A dangling symlink reproduces it deterministically: readdir lists the name, stat follows
  // the link and reports ENOENT.
  it("skips a lock that disappears between the readdir and the stat", async () => {
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
    await backdate(join(dir, "publish", TEMP_NAME), IN_PROGRESS_MS + 60_000);
    expect(await collectWriteDebris(dir)).toEqual([join(dir, "publish", TEMP_NAME)]);
  });

  // Backdated past the age gate on purpose: without it this would pass for the wrong reason — the
  // file would be held back as possibly-live, and the test would stop saying anything about skipDir.
  it("leaves the archive alone — it has its own retention rule", async () => {
    const dir = await scratch();
    const archive = join(dir, "archive");
    await mkdir(archive, { recursive: true });
    await writeFile(join(archive, TEMP_NAME), "");
    await backdate(join(archive, TEMP_NAME), IN_PROGRESS_MS + 60_000);
    expect(await collectWriteDebris(dir, { skipDir: archive })).toEqual([]);
  });
});
