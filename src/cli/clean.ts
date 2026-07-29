import "./registerErrorHandler";
import { readdir, rm, stat } from "node:fs/promises";
import { join } from "node:path";
import { argValue } from "./args";
import { OUTPUT_DIR, paths } from "../paths";
import { LOCK_STALE_MS } from "../shared/store/fileLock";
import { expiredArchiveDays, isLockFile, isStrandedTempFile } from "../storage/retention";

const olderThanDays = Number(argValue("--older-than") ?? "30");
if (!Number.isFinite(olderThanDays) || olderThanDays < 0) {
  throw new Error(`Invalid --older-than: ${argValue("--older-than")} (expected a non-negative number of days)`);
}
const confirmed = process.argv.includes("--yes");

const targets: string[] = [];

// 1. Expired archive day-folders.
try {
  const days = await readdir(paths.archiveDir);
  for (const day of expiredArchiveDays(days, olderThanDays, new Date())) {
    targets.push(join(paths.archiveDir, day));
  }
} catch {
  // no archive yet
}

// 2. Debris of an interrupted write: temp files from an atomic write, and lock files whose owner
//    died. Live stores are never matched.
async function sweepTemp(dir: string): Promise<void> {
  let names: string[];
  try {
    names = await readdir(dir);
  } catch {
    return;
  }
  for (const name of names) {
    const full = join(dir, name);
    if (isStrandedTempFile(name)) {
      // A lock younger than the staleness window may still be held by a running send. Removing it
      // would let a second process interleave a read-modify-write of the same ledger and drop a
      // row — and a dropped send row is a duplicate live post. Leave those to their owner.
      if (isLockFile(name) && Date.now() - (await stat(full)).mtimeMs < LOCK_STALE_MS) continue;
      targets.push(full);
      continue;
    }
    if ((await stat(full)).isDirectory() && full !== paths.archiveDir) await sweepTemp(full);
  }
}
await sweepTemp(OUTPUT_DIR);

if (targets.length === 0) {
  console.log("nothing to clean");
} else if (!confirmed) {
  console.log(`would remove ${targets.length} path(s) (older than ${olderThanDays} day(s)):`);
  for (const t of targets) console.log(`  ${t}`);
  console.log("\nre-run with --yes to remove them");
} else {
  for (const t of targets) await rm(t, { recursive: true, force: true });
  console.log(`removed ${targets.length} path(s)`);
}
