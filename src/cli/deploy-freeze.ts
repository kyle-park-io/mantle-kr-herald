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
import { readFileSync, readdirSync, existsSync, lstatSync, writeFileSync, chmodSync, renameSync, rmSync, mkdirSync } from "node:fs";
import { createHash } from "node:crypto";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { diffEnv, diffFiles, isEmptyDiff, formatFreezeDiff, type NameDiff } from "../deploy/configFreeze";

/** The same three the old `link_ignored_config` walked, in the same order. */
export const STEERING_DIRS = ["translation", "conversion", "keys"] as const;

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
 * Derived, never hardcoded: any git-ignored file in the development checkout's steering directory
 * is config, and a steering file added later needs no edit here. `check-ignore` exits 1 when it
 * matches nothing, which is not an error — it means the directory holds only committed examples.
 */
export function ignoredFilesIn(devDir: string, rel: string): string[] {
  const dir = join(devDir, rel);
  if (!existsSync(dir)) return [];
  const names = readdirSync(dir, { withFileTypes: true }).filter((e) => e.isFile()).map((e) => e.name);
  if (names.length === 0) return [];
  const res = spawnSync("git", ["-C", devDir, "check-ignore", ...names.map((n) => join(dir, n))], {
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
 * `lstat` and not `stat`: until the first freeze, `<app>/.env` is a symlink into the development
 * checkout, and following it would diff that file against itself and report "unchanged" for what is
 * actually the first snapshot ever taken.
 */
export function readSnapshot(dir: string): Snapshot {
  const envPath = join(dir, ".env");
  const isRealFile = existsSync(envPath) && lstatSync(envPath).isFile();
  const steering = new Map<string, string>();
  for (const rel of STEERING_DIRS) {
    for (const name of ignoredFilesIn(dir, rel)) {
      steering.set(`${rel}/${name}`, createHash("sha256").update(readFileSync(join(dir, rel, name))).digest("hex"));
    }
  }
  return { env: isRealFile ? readFileSync(envPath, "utf8") : undefined, steering };
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
    const wanted = ignoredFilesIn(devDir, rel);
    if (wanted.length > 0) mkdirSync(join(appDir, rel), { recursive: true });
    for (const name of wanted) {
      writeFrozen(join(appDir, rel, name), readFileSync(join(devDir, rel, name)), modeFor(`${rel}/${name}`));
      console.log(`  freeze: ${rel}/${name}`);
    }
    // Only ever the git-ignored ones: the committed `*.example.*` files came from the clone, and
    // deleting them would leave the deploy checkout permanently dirty.
    for (const stale of ignoredFilesIn(appDir, rel)) {
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

  const next = readSnapshot(devDir);
  const previous = readSnapshot(appDir);
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
