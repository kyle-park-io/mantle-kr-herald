/**
 * Moves the deploy checkout's configuration to match the development checkout's, visibly.
 *
 * Registered without `--env-file-if-exists`, alongside `auth:hash` and `config:init`: this command
 * does not read configuration, it moves it — and loading the development `.env` into its own
 * process would be a way to leak one into an error message.
 *
 * Two phases so `deploy/herald-deploy.sh` can gate before it does anything destructive. `--check`
 * is read-only and decides; `--apply` writes. Splitting them is what keeps a refused config change
 * from leaving the deploy checkout's code already moved to origin/main — that script's header calls
 * a half-finished deploy worse than none.
 */
import { readFileSync, readdirSync, existsSync, lstatSync, statSync, writeFileSync, chmodSync, renameSync, rmSync, mkdirSync } from "node:fs";
import { createHash } from "node:crypto";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { diffEnv, diffFiles, isEmptyDiff, formatFreezeDiff, type NameDiff } from "../deploy/configFreeze";

/** The same three the old `link_ignored_config` walked, in the same order. */
export const STEERING_DIRS = ["translation", "conversion", "keys"] as const;

/**
 * Which of the two trees a path is being examined in. **This is not one predicate wearing a
 * parameter — the two trees are asked opposite questions and must get opposite symlink semantics.**
 * Collapsing them back into a single "is it a file?" test is the bug this type exists to prevent:
 * the first version of this command did exactly that, and one `isFile()` produced three separate
 * silent failures at once — one per call site below. They are pinned in `deployFreeze.test.ts` under
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

function flag(name: string): boolean {
  return process.argv.includes(`--${name}`);
}

function option(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i === -1 ? undefined : process.argv[i + 1];
}

function fail(message: string, code: number): never {
  console.error(message);
  process.exit(code);
}

/**
 * Derived, never hardcoded: any git-ignored file in a checkout's steering directory is config, and
 * a steering file added later needs no edit here. `check-ignore` exits 1 when it matches nothing,
 * which is not an error — it means the directory holds only committed examples.
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

export interface Snapshot {
  env: string | undefined;
  steering: Map<string, string>;
}

/**
 * The `.env` gate is `lstat` on the deploy side and `stat` on the development side, and both halves
 * are load-bearing (again: see `Tree`). On the deploy side, following the link would diff the
 * development `.env` against itself and report "unchanged" for what is actually the first snapshot
 * ever taken. On the development side, *not* following it reads no variables at all and reports
 * every variable the deploy checkout already holds as removed — a diff `--apply` cannot resolve,
 * because it writes the same bytes and the next `--check` prints it again.
 */
export function readSnapshot(dir: string, tree: Tree): Snapshot {
  const envPath = join(dir, ".env");
  const envStat = tree === "dev"
    ? statSync(envPath, { throwIfNoEntry: false })
    : lstatSync(envPath, { throwIfNoEntry: false });
  const steering = new Map<string, string>();
  for (const rel of STEERING_DIRS) {
    for (const name of ignoredFilesIn(dir, rel, tree)) {
      const path = join(dir, rel, name);
      const isLink = tree === "app" && lstatSync(path).isSymbolicLink();
      steering.set(
        `${rel}/${name}`,
        isLink ? UNMIGRATED_LINK : createHash("sha256").update(readFileSync(path)).digest("hex"),
      );
    }
  }
  return { env: envStat?.isFile() ? readFileSync(envPath, "utf8") : undefined, steering };
}

/**
 * Written to a temp name in the destination directory and renamed, so an interrupted deploy leaves
 * each file either wholly old or wholly new. `chmod` before the rename, not after: the window where
 * a credential exists at the wrong mode should not exist at all.
 *
 * Both the `{ mode }` passed to `writeFileSync` and the following `chmodSync` are required, and
 * neither is redundant. `writeFileSync`'s `mode` option only applies to a file it creates — the temp
 * name is new on a clean run, so this closes the window where the freshly written bytes are briefly
 * world-readable at the umask-derived default. But if a previous run was interrupted after this
 * write and before its rename, the temp name from that run still exists on disk at the wrong mode;
 * `writeFileSync`'s `mode` option is silently ignored for a file that already exists, so only the
 * explicit `chmodSync` corrects it before this run's rename.
 */
function writeFrozen(dest: string, data: Buffer, mode: number): void {
  const tmp = `${dest}.freeze-${process.pid}`;
  writeFileSync(tmp, data, { mode });
  chmodSync(tmp, mode);
  renameSync(tmp, dest);
}

/** `.env` and the service-account key are secrets; a glossary is a team document. */
function modeFor(relPath: string): number {
  return relPath === ".env" || relPath.startsWith("keys/") ? 0o600 : 0o644;
}

function apply(devDir: string, appDir: string): void {
  writeFrozen(join(appDir, ".env"), readFileSync(join(devDir, ".env")), modeFor(".env"));
  console.log("  freeze: .env");

  for (const rel of STEERING_DIRS) {
    const wanted = ignoredFilesIn(devDir, rel, "dev");
    if (wanted.length > 0) mkdirSync(join(appDir, rel), { recursive: true });
    for (const name of wanted) {
      writeFrozen(join(appDir, rel, name), readFileSync(join(devDir, rel, name)), modeFor(`${rel}/${name}`));
      console.log(`  freeze: ${rel}/${name}`);
    }
    // Only ever the git-ignored ones: the committed `*.example.*` files came from the clone, and
    // deleting them would leave the deploy checkout permanently dirty. Symlinks are in this listing
    // and copies are not exempt from it: `rmSync` on a link removes the link, never its target.
    for (const stale of ignoredFilesIn(appDir, rel, "app")) {
      if (wanted.includes(stale)) continue;
      rmSync(join(appDir, rel, stale));
      console.log(`  remove: ${rel}/${stale}`);
    }
  }
}

function main(): void {
  const devDir = option("dev");
  const appDir = option("app");
  if (!devDir || !appDir) fail("Usage: deploy:freeze --check|--apply --dev <dir> --app <dir> [--yes]", 1);
  if (!existsSync(join(devDir, ".env"))) {
    fail(`No .env in the development checkout (${devDir}). Production configuration is copied from it — restore it before deploying.`, 1);
  }

  const next = readSnapshot(devDir, "dev");
  const previous = readSnapshot(appDir, "app");
  const envDiff: NameDiff = diffEnv(previous.env, next.env ?? "");
  const steeringDiff: NameDiff = diffFiles(previous.steering, next.steering);

  console.log(formatFreezeDiff("env", envDiff));
  console.log(formatFreezeDiff("steering", steeringDiff));

  if (flag("check")) {
    if (isEmptyDiff(envDiff) && isEmptyDiff(steeringDiff)) process.exit(0);
    if (flag("yes")) process.exit(0);
    fail("  config: changes above are not applied. Re-run with --yes once they are what you intend.", 2);
  }

  if (flag("apply")) {
    apply(devDir, appDir);
    process.exit(0);
  }

  fail("Nothing to do: pass --check or --apply.", 1);
}

main();
