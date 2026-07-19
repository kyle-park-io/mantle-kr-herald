import "./registerErrorHandler";
import { readdir, rm, stat } from "node:fs/promises";
import { join } from "node:path";
import { argValue } from "./args";
import { OUTPUT_DIR, paths } from "../paths";
import { expiredArchiveDays, isStrandedTempFile } from "../storage/retention";

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

// 2. Temp files stranded by an interrupted atomic write. Live stores are never matched.
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
