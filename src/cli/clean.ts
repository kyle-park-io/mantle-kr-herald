import "./registerErrorHandler";
import { readdir, rm } from "node:fs/promises";
import { join } from "node:path";
import { argValue } from "./args";
import { OUTPUT_DIR, paths } from "../paths";
import { expiredArchiveDays } from "../storage/retention";
import { collectWriteDebris } from "../storage/sweep";

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

// 2. Debris of an interrupted write: temp files from an atomic write, plus any stray lock file left
//    by a build old enough to have written one. Live stores are never matched, and a temp file
//    young enough to still be in active use is left alone.
targets.push(...(await collectWriteDebris(OUTPUT_DIR, { skipDir: paths.archiveDir })));

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
