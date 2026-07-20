import { access, readFile } from "node:fs/promises";
import { join } from "node:path";
import { ALL_TYPES } from "../domain/conversion/models";

/** Files that must exist for translation and every conversion type to be steered at all. */
export function steeringFiles(translationDir: string, conversionDir: string): string[] {
  return [
    join(translationDir, "glossary.json"),
    join(translationDir, "style-guide.md"),
    join(translationDir, "locale.json"),
    // loadTypeGuide() falls back to "" on ENOENT, so a type missing its guide converts with no
    // steering rather than failing loudly.
    ...ALL_TYPES.map((type) => join(conversionDir, `${type}.md`)),
  ];
}

export async function missingSteeringFiles(files: string[]): Promise<string[]> {
  const missing: string[] = [];
  for (const f of files) {
    try {
      await access(f);
    } catch {
      missing.push(f);
    }
  }
  return missing;
}

/**
 * Steering files that exist but carry no steering: an empty glossary, or a guide still identical
 * to its `*.example.*` skeleton. `pnpm config:init` produces exactly this state, so presence
 * alone would report ok while translation runs with none of the team's terminology — the silent
 * failure this check exists to catch. Returns short display paths, not absolute ones.
 */
export async function skeletonSteeringFiles(translationDir: string, conversionDir: string): Promise<string[]> {
  const found: string[] = [];

  try {
    const parsed: unknown = JSON.parse(await readFile(join(translationDir, "glossary.json"), "utf8"));
    if (Array.isArray(parsed) && parsed.length === 0) found.push("translation/glossary.json");
  } catch {
    // Unreadable or malformed steers nothing either, but a missing file is the presence check's
    // job to report — stay silent so the two checks don't both fire on the same cause.
  }

  const guides: [string, string, string][] = [
    [translationDir, "translation", "style-guide.md"],
    ...ALL_TYPES.map((t) => [conversionDir, "conversion", `${t}.md`] as [string, string, string]),
  ];
  for (const [dir, label, name] of guides) {
    const example = name.replace(/\.(md|json)$/, ".example.$1");
    try {
      const [real, skeleton] = await Promise.all([
        readFile(join(dir, name), "utf8"),
        readFile(join(dir, example), "utf8"),
      ]);
      if (real.trim() === skeleton.trim()) found.push(`${label}/${name}`);
    } catch {
      // No skeleton to compare against (or the real file is missing) — nothing to conclude.
    }
  }
  return found;
}
