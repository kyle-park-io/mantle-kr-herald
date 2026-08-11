/**
 * What git-ignored configuration a checkout is holding, as `path → sha-256` — the measurement both
 * "may this deploy proceed?" and "is the deployed config stale?" are answered from.
 *
 * It lived inside `src/cli/deploy-freeze.ts` until 2026-08-11 and moved here unchanged, because that
 * file calls `main()` at import time: importing a single function out of it would have run the
 * deploy command. `pnpm doctor`'s deploy-drift check needs the identical comparison the deploy gate
 * makes — same file list, same symlink rules, same hashes — and a second implementation of it would
 * be a second answer to one question, free to disagree with the gate that actually withholds a
 * deploy.
 *
 * Hashes, never contents. Every caller reports names only (`configFreeze.ts`'s `NameDiff`), and this
 * file is where that becomes structural rather than a habit: no value read here can reach a caller.
 *
 * *Which* files count is not this module's decision — `isSteeringConfigFile`
 * (`src/domain/config/steering.ts`) owns the line between configuration and the `db:export` few-shot
 * artifacts that sit in the same directories, and `config:push`/`config:pull` ask it the same
 * question. This module is where that predicate meets the filesystem, once, for every caller that
 * needs a checkout measured.
 */
import { readFileSync, readdirSync, existsSync, lstatSync, statSync } from "node:fs";
import { createHash } from "node:crypto";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { isSteeringConfigFile } from "../domain/config/steering";

/** The same three the old `link_ignored_config` walked, in the same order. */
export const STEERING_DIRS = ["translation", "conversion", "keys"] as const;

/**
 * Which of the two trees a path is being examined in. **This is not one predicate wearing a
 * parameter — the two trees are asked opposite questions and must get opposite symlink semantics.**
 * Collapsing them back into a single "is it a file?" test is the bug this type exists to prevent:
 * the first version of `deploy:freeze` did exactly that, and one `isFile()` produced three separate
 * silent failures at once — one per call site. They are pinned in `deployFreeze.test.ts` under
 * "the two trees' opposite symlink rules".
 *
 * - `"dev"` asks *what will the scheduler actually read?* A development `.env` or glossary that is
 *   itself a symlink is configuration like any other, so every decision about it must **follow the
 *   link** — `apply()` copies with `readFileSync`, which follows, and the bash this replaced gated
 *   on `[ -f "$src" ]`, which also follows and would have linked it. Deciding with `lstat` here
 *   skips the file in `apply()` while reporting it as absent in the diff, both silently.
 * - `"app"` asks *is there a real snapshot here?* A symlink in the deploy checkout is never a
 *   snapshot — it is the pre-2026-08-09 layout, left by `ln -sfn`, waiting to be migrated — so this
 *   side must **not follow**. It must still *enumerate* links, though: `ln -sfn` never removed
 *   anything, so a link whose development file has since been deleted is exactly what the sweep in
 *   `apply()` exists to clear, and a link filtered out of the listing survives every deploy forever.
 */
export type Tree = "dev" | "app";

/**
 * Stands where the content hash of a deploy-checkout entry would go when that entry is a symlink.
 * It can never collide with a sha-256, so the entry reports as `changed` against a development file
 * of the same name (`--apply` replaces the link with a copy) and as `removed` when the development
 * checkout no longer has one (`--apply` sweeps the link). Deliberately not the target's hash: the
 * link is the old layout regardless of what it currently resolves to, and the stale case resolves to
 * nothing at all, so reading through it would throw `ENOENT` on precisely the entry that matters.
 */
const UNMIGRATED_LINK = "symlink — pre-freeze layout, not a snapshot";

/**
 * Every git-ignored file in a checkout's steering directory — derived, never hardcoded, so a
 * steering file added later needs no edit here. `check-ignore` exits 1 when it matches nothing,
 * which is not an error — it means the directory holds only committed examples.
 *
 * The raw listing. `steeringFilesIn` below is what callers want: git-ignored is *nearly* the same
 * question as "is it configuration", but not quite, and the gap is the `db:export` few-shot
 * artifacts.
 *
 * `tree` picks the symlink rule; see the `Tree` doc comment for why the two differ. On the
 * development side a dangling link is skipped, because `[ -f ]` and `readFileSync` both agree there
 * is nothing there to copy; on the deploy side it is listed, because clearing it is the job.
 */
export function ignoredFilesIn(root: string, rel: string, tree: Tree): string[] {
  const dir = join(root, rel);
  if (!existsSync(dir)) return [];
  const entries = readdirSync(dir, { withFileTypes: true });
  const names = entries
    .filter((e) =>
      tree === "dev"
        ? statSync(join(dir, e.name), { throwIfNoEntry: false })?.isFile() === true
        : e.isFile() || e.isSymbolicLink(),
    )
    .map((e) => e.name);
  if (names.length === 0) return [];
  const res = spawnSync("git", ["-C", root, "check-ignore", ...names.map((n) => join(dir, n))], {
    encoding: "utf8",
  });
  const ignored = new Set(res.stdout.split("\n").map((s) => s.trim()).filter(Boolean));
  return names.filter((n) => ignored.has(join(dir, n))).sort();
}

/**
 * The two of `STEERING_DIRS` whose git-ignored contents are not all configuration: they also hold
 * the `few-shot*.json` files `pnpm db:export` writes for the rollback path. `keys/` is deliberately
 * absent — everything git-ignored there is a credential, and a name-shaped filter over it could only
 * ever drop one silently.
 */
const CORPUS_DIRS = new Set<string>(["translation", "conversion"]);

/**
 * `ignoredFilesIn` narrowed to what the deploy checkout should actually be *given*.
 *
 * **Asymmetric on purpose, and the asymmetry is the cleanup mechanism.** The development side is
 * filtered, so a `db:export` artifact is never frozen into production. The deploy side is not, so
 * copies frozen by earlier deploys still appear in `readSnapshot` — reported once as `- ` removals
 * by `--check`, then swept by `apply()`, exactly as it already sweeps a file deleted upstream.
 * Filtering both sides would instead leave every already-frozen copy sitting in the deploy checkout
 * forever, invisible to the diff that is supposed to describe that tree.
 *
 * `pnpm doctor`'s drift check reads through this function too, asymmetry included, and inherits the
 * consequence deliberately: on a machine whose deploy checkout still holds pre-2026-08-11 few-shot
 * copies, both it and `deploy:freeze --check` see the same seven removals until the next deploy
 * sweeps them. That is the whole point of sharing the derivation — a doctor that filtered both sides
 * would report the trees identical while the gate stopped the very next deploy over seven files.
 * `src/doctor/deploySteering.ts` grades a removals-only difference as `ok` rather than pretending it
 * is not there; see `stale-in-deploy` for why the two directions are not the same finding.
 */
export function steeringFilesIn(root: string, rel: string, tree: Tree): string[] {
  const names = ignoredFilesIn(root, rel, tree);
  if (tree === "app" || !CORPUS_DIRS.has(rel)) return names;
  return names.filter(isSteeringConfigFile);
}

/**
 * Every steering file in `dir`, keyed `<subdir>/<name>` so two checkouts' maps compare directly
 * through `diffFiles`. `.env` is deliberately not in here: it is the deploy gate's own concern
 * (`readSnapshot` in `src/cli/deploy-freeze.ts` adds it), it is diffed as parsed variables rather
 * than as a file, and keeping it out means a reader of this map — `pnpm doctor` — never pulls
 * another tree's secrets into its process to answer a question about the glossary.
 */
export function readSteeringSnapshot(dir: string, tree: Tree): Map<string, string> {
  const steering = new Map<string, string>();
  for (const rel of STEERING_DIRS) {
    for (const name of steeringFilesIn(dir, rel, tree)) {
      const path = join(dir, rel, name);
      const isLink = tree === "app" && lstatSync(path).isSymbolicLink();
      steering.set(
        `${rel}/${name}`,
        isLink ? UNMIGRATED_LINK : createHash("sha256").update(readFileSync(path)).digest("hex"),
      );
    }
  }
  return steering;
}
