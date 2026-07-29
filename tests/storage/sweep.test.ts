import { describe, it, expect } from "vitest";
import { mkdir, mkdtemp, symlink, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LOCK_STALE_MS } from "../../src/shared/store/fileLock";
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
    await writeFile(join(dir, "items.json"), "[]");
    expect(await collectWriteDebris(dir)).toEqual([join(dir, TEMP_NAME)]);
  });

  it("collects a lock whose owner plainly died", async () => {
    const dir = await scratch();
    const lock = join(dir, "deliveries.json.lock");
    await writeFile(lock, "4821\n");
    await backdate(lock, LOCK_STALE_MS + 60_000);
    expect(await collectWriteDebris(dir)).toEqual([lock]);
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
    expect(await collectWriteDebris(dir)).toEqual([join(dir, "publish", TEMP_NAME)]);
  });

  it("leaves the archive alone — it has its own retention rule", async () => {
    const dir = await scratch();
    const archive = join(dir, "archive");
    await mkdir(archive, { recursive: true });
    await writeFile(join(archive, TEMP_NAME), "");
    expect(await collectWriteDebris(dir, { skipDir: archive })).toEqual([]);
  });
});
