import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { realpathSync } from "node:fs";
import { diffEnv, isEmptyDiff, type NameDiff } from "../deploy/configFreeze";
import type { CheckResult } from "./report";
import type { DeployTree, DeployTreeSource } from "./deploySteering";

/**
 * `.env`'s half of the two-tree problem `Steering deploy sync` already reports for steering files.
 *
 * The scheduler does not read this checkout's `.env`. Its units set
 * `WorkingDirectory=%h/.herald/app`, so `pnpm <script>` reads the `.env` sitting *there*, and that
 * file is a copy `deploy/herald-deploy.sh` made at deploy time — not a symlink, deliberately, since
 * 2026-08-09. Rotate a credential here and skip the deploy and the timers keep authenticating with
 * the old value: nothing fails, nothing alerts, and the only way to notice is to compare the two
 * files. `deploy:freeze` prints the difference when a deploy runs; until then nobody was asking.
 *
 * Names, never values — `diffEnv` is the deploy gate's own function, so this check and that gate can
 * never disagree about what counts as changed, and neither of them ever holds a value long enough to
 * print one.
 */
export const DEPLOY_ENV_CHECK = ".env deploy sync";

export type DeployEnvKind =
  | "in-sync"
  | "drifted"
  /** Only the deploy tree has extra names. The next deploy sweeps them; nothing is stale *here*. */
  | "stale-in-deploy"
  | "same-tree"
  | "missing-here"
  | "missing-in-deploy"
  | "no-deploy-tree";

export interface DeployEnvStatus {
  kind: DeployEnvKind;
  here: string;
  deployDir?: string;
  source?: DeployTreeSource;
  /** `previous` is the deploy tree, so `added` reads "only in this checkout" and `removed` "only
   *  over there" — the orientation `deploy:freeze` prints, so `+`/`-` mean one thing in both. */
  diff?: NameDiff;
  /** How many assignments this checkout's `.env` holds. An empty diff between two empty files is
   *  agreement about nothing, and saying "0 compared" is the difference. */
  compared?: number;
  detail?: string;
}

const canonical = (dir: string): string => {
  try {
    return realpathSync(dir);
  } catch {
    return dir;
  }
};

const readEnv = (dir: string): string | undefined => {
  const path = join(dir, ".env");
  return existsSync(path) ? readFileSync(path, "utf8") : undefined;
};

export function deployEnvStatus(here: string, tree: DeployTree): DeployEnvStatus {
  if (!tree.known) return { kind: "no-deploy-tree", here, detail: tree.detail };

  const { dir, source } = tree;
  // Same guard, same reason as the steering check: one directory reached by two names would compare
  // itself and report a confident "in sync" for a comparison that never happened.
  if (canonical(here) === canonical(dir)) return { kind: "same-tree", here, deployDir: dir, source };

  const mine = readEnv(here);
  if (mine === undefined) return { kind: "missing-here", here, deployDir: dir, source };

  const theirs = readEnv(dir);
  if (theirs === undefined) return { kind: "missing-in-deploy", here, deployDir: dir, source };

  const diff = diffEnv(theirs, mine);
  const compared = diffEnv(undefined, mine).added.length;
  if (isEmptyDiff(diff)) return { kind: "in-sync", here, deployDir: dir, source, diff, compared };
  // `removed` alone is the deploy tree holding a name this checkout stopped setting. The next deploy
  // sweeps it, so it is not drift the operator has to act on — the same grading `stale-in-deploy`
  // gets in the steering check, and for the same reason: a warn on a self-resolving state is how a
  // report teaches people to stop reading it.
  const actionable = diff.added.length > 0 || diff.changed.length > 0;
  return { kind: actionable ? "drifted" : "stale-in-deploy", here, deployDir: dir, source, diff, compared };
}

const names = (diff: NameDiff): string =>
  [
    ...diff.added.map((n) => `+${n}`),
    ...diff.changed.map((n) => `~${n}`),
    ...diff.removed.map((n) => `-${n}`),
  ].join(", ");

export function deployEnvResult(s: DeployEnvStatus): CheckResult {
  const name = DEPLOY_ENV_CHECK;
  switch (s.kind) {
    case "no-deploy-tree":
      return { name, status: "ok", detail: `not applicable — ${s.detail ?? "no deploy checkout identified from here"}` };
    case "same-tree":
      return { name, status: "ok", detail: `not applicable — this checkout is the deploy tree (${s.deployDir})` };
    case "missing-here":
      // The Database/steering checks above already fail a checkout with no .env; saying it twice
      // would spend a line on a finding the reader has met.
      return { name, status: "ok", detail: "not checked — this checkout has no .env" };
    case "missing-in-deploy":
      return {
        name,
        status: "fail",
        detail: `${s.deployDir}/.env does not exist — every timer reads it, so the scheduler cannot run. Run bash deploy/herald-deploy.sh.`,
      };
    case "stale-in-deploy":
      return {
        name,
        status: "ok",
        detail: `${s.compared} in sync — ${names(s.diff!)} remain only in ${s.deployDir}, which the next deploy sweeps`,
      };
    case "drifted":
      return {
        name,
        status: "warn",
        detail:
          `${names(s.diff!)} — this checkout differs from ${s.deployDir}, which is what the timers actually read. ` +
          `Run bash deploy/herald-deploy.sh (+ only here, ~ different, - only there).`,
      };
    case "in-sync":
      return { name, status: "ok", detail: `${s.compared} variable(s) match ${s.deployDir}` };
  }
}
