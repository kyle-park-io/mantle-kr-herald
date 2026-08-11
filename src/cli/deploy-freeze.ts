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
import { readFileSync, existsSync, lstatSync, statSync, writeFileSync, chmodSync, renameSync, rmSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { diffEnv, diffFiles, isEmptyDiff, formatFreezeDiff, type NameDiff } from "../deploy/configFreeze";
// The file listing, the `db:export` carve-out, the symlink rules and the hashing all live in
// `src/deploy/steeringSnapshot.ts` — moved there so `pnpm doctor` can ask the same question this
// gate asks without importing a module that runs a deploy at import time. Nothing about them
// changed in the move; that file carries the reasoning this one used to.
import { STEERING_DIRS, steeringFilesIn, readSteeringSnapshot, type Tree } from "../deploy/steeringSnapshot";

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
  return {
    env: envStat?.isFile() ? readFileSync(envPath, "utf8") : undefined,
    steering: readSteeringSnapshot(dir, tree),
  };
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
    const wanted = steeringFilesIn(devDir, rel, "dev");
    if (wanted.length > 0) mkdirSync(join(appDir, rel), { recursive: true });
    for (const name of wanted) {
      writeFrozen(join(appDir, rel, name), readFileSync(join(devDir, rel, name)), modeFor(`${rel}/${name}`));
      console.log(`  freeze: ${rel}/${name}`);
    }
    // Only ever the git-ignored ones: the committed `*.example.*` files came from the clone, and
    // deleting them would leave the deploy checkout permanently dirty. Symlinks are in this listing
    // and copies are not exempt from it: `rmSync` on a link removes the link, never its target.
    // Unfiltered (see `steeringFilesIn`), so a `few-shot*.json` left by a pre-2026-08-11 freeze is
    // in this listing, never in `wanted`, and therefore removed here.
    for (const stale of steeringFilesIn(appDir, rel, "app")) {
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
