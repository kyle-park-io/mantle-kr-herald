import "./registerErrorHandler";
import { copyFile, readdir } from "node:fs/promises";
import { join } from "node:path";
import { paths } from "../paths";

const SUFFIX = ".example";

/** Copy `<name>.example.<ext>` → `<name>.<ext>` when the real file is absent. Never overwrites. */
async function initDir(dir: string): Promise<number> {
  let created = 0;
  const names = await readdir(dir);
  const existing = new Set(names);
  for (const name of names) {
    const dot = name.lastIndexOf(".");
    if (dot < 0) continue;
    const base = name.slice(0, dot);
    const ext = name.slice(dot);
    if (!base.endsWith(SUFFIX)) continue;
    const target = `${base.slice(0, -SUFFIX.length)}${ext}`;
    if (existing.has(target)) continue;
    await copyFile(join(dir, name), join(dir, target));
    console.log(`  created ${join(dir, target)}`);
    created += 1;
  }
  return created;
}

const created = (await initDir(paths.translationConfigDir)) + (await initDir(paths.conversionConfigDir));
console.log(created === 0 ? "steering config already in place — nothing to do" : `created ${created} file(s)`);
