import "./registerErrorHandler";
import { readdir } from "node:fs/promises";
import { join } from "node:path";
import { paths } from "../paths";
import { archiveFile } from "../shared/store/archive";

const worksheetDirs: Array<[string, string]> = [
  [paths.translationsWorksheets, "worksheet-translations"],
  [paths.variantsWorksheets, "worksheet-variants"],
  [paths.formattedWorksheets, "worksheet-formatted"],
];

let moved = 0;
for (const [dir, label] of worksheetDirs) {
  let names: string[];
  try {
    names = await readdir(dir);
  } catch {
    continue; // stage never ran
  }
  for (const name of names) {
    if (!name.endsWith(".md")) continue;
    const dest = await archiveFile(join(dir, name), paths.archiveDir, label);
    if (dest) {
      console.log(`  ${name} → ${dest}`);
      moved += 1;
    }
  }
}

console.log(moved === 0 ? "nothing to archive" : `archived ${moved} worksheet(s)`);
