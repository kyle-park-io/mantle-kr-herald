/**
 * Is the steering config the *scheduler* runs with the same one this checkout holds?
 *
 * On the machine that runs the timers the config exists twice: the development checkout, which is
 * the record of truth (`docs/ko/setup/steering.md` §4), and `deploy/herald-deploy.sh`'s deploy
 * checkout, which every systemd unit sets as its `WorkingDirectory`. Step 3 of that script copies
 * the first into the second. Nothing else does. So `pnpm glossary add` followed by no deploy leaves
 * the scheduler translating against the old glossary — with no error, no warning and no wrong output
 * that looks wrong, because a term that was never applied simply is not there.
 *
 * The gate in `deploy:freeze --check` already computes this exact diff, but only while a deploy is
 * running, which is the one moment it cannot help: by then someone has already decided to deploy.
 * This asks the same question from the other end, at the moment the edit's author is most likely to
 * be looking at a terminal.
 *
 * **Names only, never values** — the same rule `src/deploy/configFreeze.ts` follows, and for the
 * same reason: this configuration is git-ignored precisely because it is not public. Everything
 * below flows from `NameDiff`, and the snapshots it is built from are sha-256 hashes.
 *
 * **No path to either tree is written down here.** The deploy path is machine-specific by design
 * (`herald-deploy.sh`'s own header says so, next to the `DEV_DIR` it hardcodes for a script that
 * runs on exactly one box); `src/` runs on laptops, on CI and in a Vercel function, and a constant
 * here would be wrong on all three. See `resolveDeployTree` for the two ways it is learned instead.
 *
 * ── Why the @0xMantleKR reference corpus is deliberately NOT compared here ────────────────────────
 *
 * It was considered when `deploy/herald-copy-corpus.sh` shipped (2026-08-12), because a corpus the
 * deploy failed to carry degrades every `glossary:mine` candidate to tier B in silence — exactly this
 * check's class of failure. Three things decided it out, and the third is the one that matters:
 *
 * 1. **Different root.** Steering files are REPO_ROOT-relative, so one `dir` locates both sides. The
 *    corpus is OUTPUT_DIR-relative and lives at `%h/.herald/output/x/reference`, outside the deploy
 *    checkout entirely — `tree.dir` cannot find it, and a second resolution (the unit's
 *    `Environment=HERALD_OUTPUT_DIR`) inside one check would make `deployDir` mean two things.
 * 2. **A difference here does not mean the same thing.** `drifted` says the scheduler is steering
 *    with something the record of truth does not say. Two corpora that differ are not right and
 *    wrong, they are newer and older — a `collect:reference` run on Tuesday and deployed on Friday is
 *    ordinary, and a warn on it would be the crying-wolf `stale-in-deploy` exists to avoid.
 * 3. **A hash comparison is the weaker evidence.** What actually harms grading is the corpus's AGE,
 *    and two identical trees hash equal while both being three months stale. `gradeCorpus`
 *    (glossaryMining.ts) reads the real answer out of the run ledger the corpus carries, and
 *    `glossary:mine` already reports it on stdout, in the review file and in the ops alert.
 *
 * What that leaves uncovered is absence — the corpus never arriving, which is what happened on
 * 2026-08-11 — and absence is reported by the deploy step itself ("corpus: none at …") and by the
 * miner's own `참조 코퍼스 없음`. If that turns out to be too late too often, the answer is a check of
 * its own with its own vocabulary, not another file list inside this one.
 */
import { existsSync, realpathSync } from "node:fs";
import { resolve } from "node:path";
import { readSteeringSnapshot } from "../deploy/steeringSnapshot";
import { diffFiles, isEmptyDiff, type NameDiff } from "../deploy/configFreeze";
import { WATCH_UNIT, unitProperty } from "../status/translateFloor";
import type { CheckResult } from "./report";

/** The row's name in `pnpm doctor`'s report, spelled once so the test and the report cannot drift. */
export const DEPLOY_STEERING_CHECK = "Steering deploy sync";

/** The override, named once — it appears in `.env.example`, in `doctor.ts` and in the two "not
 *  applicable" sentences below, and a typo in any of them tells an operator to set the wrong name. */
export const DEPLOY_DIR_VAR = "HERALD_DEPLOY_DIR";

/**
 * Where the scheduler's checkout is, and **how that was learned** — the source travels with the path
 * rather than being dropped, because the two are believed for different reasons and a reader who
 * disagrees with the verdict needs to know which one to go and correct.
 */
export type DeployTreeSource = "env" | "unit";

export type DeployTree =
  | { known: true; dir: string; source: DeployTreeSource }
  /** Not "there is no deploy checkout" — "none is identified from here". `detail` says why. */
  | { known: false; detail: string };

/**
 * The two ways doctor can learn about the other tree, in precedence order.
 *
 * 1. **`HERALD_DEPLOY_DIR`** — an operator stating a fact about this machine. It wins, for the same
 *    reason `HERALD_OUTPUT_DIR` wins over the default root: an explicit setting that something else
 *    could silently override is not a setting. Resolved to an absolute path, again like
 *    `HERALD_OUTPUT_DIR` (`src/paths.ts`) — a relative one would land under whatever directory the
 *    process happened to start in and compare two trees nobody meant.
 * 2. **`herald-watch.service`'s `WorkingDirectory`**, asked of the running systemd manager. This is
 *    the zero-configuration path and the reason the check is useful at all: a diagnostic for a silent
 *    failure that only runs once somebody remembers to configure the diagnostic would be silent in
 *    exactly the case it exists for. The unit is authoritative rather than convenient — a user unit
 *    runs `pnpm <script>` out of its `WorkingDirectory`, so that directory *is* what production runs.
 *    Asked of the manager and not read from `deploy/herald-watch.service`, for the reason
 *    `src/cli/systemdShow.ts` gives: a unit file edited without `daemon-reload` is not what runs.
 *
 * Everything else is `known: false`, and each refusal keeps its own words. "systemd was never asked"
 * (a laptop, CI, a container), "the unit is not installed here" and "the unit is loaded but names no
 * WorkingDirectory" are three different situations, and only the last is anybody's mistake.
 */
export function resolveDeployTree(input: { override?: string; unitShow?: string }): DeployTree {
  const override = input.override?.trim();
  if (override) return { known: true, dir: resolve(override), source: "env" };

  if (input.unitShow === undefined) {
    return { known: false, detail: `no systemd on this machine to ask about ${WATCH_UNIT}` };
  }
  // The same `LoadState` distinction `translateFloorStatus` draws, and it matters more here: for a
  // unit it has never heard of, `systemctl show` exits 0 and prints a bare `WorkingDirectory=`,
  // which is byte-identical to a loaded unit that sets none. Without this, every machine with no
  // scheduler on it would fall into the "misconfigured unit" branch below.
  const loadState = unitProperty(input.unitShow, "LoadState");
  if (loadState === undefined) {
    return { known: false, detail: `systemctl said nothing about ${WATCH_UNIT}'s LoadState` };
  }
  if (loadState === "not-found") return { known: false, detail: `${WATCH_UNIT} is not installed here` };
  if (loadState !== "loaded") {
    // masked, error, bad-setting: the unit exists in some form but will not run as written, so its
    // WorkingDirectory is not a claim about what any timer will do.
    return { known: false, detail: `${WATCH_UNIT} is ${loadState}, not loaded` };
  }

  const dir = unitProperty(input.unitShow, "WorkingDirectory")?.trim();
  if (!dir) return { known: false, detail: `${WATCH_UNIT} is loaded but names no WorkingDirectory` };
  return { known: true, dir, source: "unit" };
}

/**
 * Five states, for the reason `TranslateFloorKind` has five: the honest answers to this question are
 * not two, and collapsing any of them into "differs" or into "ok" is how a diagnostic starts lying.
 *
 * - `in-sync`        — both trees hold the same steering files, byte for byte.
 * - `drifted`        — this checkout holds steering config the deploy tree does not, or holds it
 *                      differently. **The one this check exists for**: the scheduler is steering with
 *                      something other than what the record of truth says.
 * - `stale-in-deploy`— the difference is *only* the other way round: files the deploy tree still
 *                      holds and this checkout no longer syncs. Nothing the scheduler reads is
 *                      wrong; the next deploy sweeps them. **Not the same finding as `drifted`, and
 *                      the reason this state exists** — since 2026-08-11 `steeringFilesIn` filters
 *                      the `db:export` few-shot artifacts out of the development listing but not out
 *                      of the deploy one (deliberately: that asymmetry is how already-frozen copies
 *                      get swept), so every machine deployed before that change reports seven
 *                      removals until its next deploy. Graded `drifted`, that would be a standing ⚠
 *                      about seven files nothing reads — a diagnostic that cries wolf on its first
 *                      run is one nobody reads on its second.
 * - `same-tree`      — doctor was invoked *inside* the deploy checkout. Nothing to compare, and
 *                      nothing that could be: the development tree it is copied from is known to
 *                      `herald-deploy.sh` and to nothing in `src/`.
 * - `nothing-here`   — this checkout holds no steering config at all, so it is nobody's source. A
 *                      fresh clone and a git worktree are both in this state, and on the machine
 *                      that has a deploy tree they would otherwise report every deployed file as
 *                      drift and name an empty worktree the record of truth.
 * - `no-deploy-tree` — no second checkout is identified from here. The ordinary case for everyone who
 *                      is not this one production machine — a fresh clone, CI, an open-source user.
 *                      Not a finding, and emphatically not evidence that the trees agree.
 * - `unreadable`     — a tree was named and could not be read. Somebody's mistake, unlike the above.
 */
export type DeploySteeringKind =
  | "in-sync"
  | "drifted"
  | "stale-in-deploy"
  | "same-tree"
  | "nothing-here"
  | "no-deploy-tree"
  | "unreadable";

export interface DeploySteeringStatus {
  kind: DeploySteeringKind;
  /**
   * The checkout doctor is running from, which `src/paths.ts` derives from the running module's own
   * location. Carried on every state and printed on every one that names the other tree: this check
   * is a comparison between two directories, and which of them is which flips depending on where the
   * command was typed. "differs" alone would leave a reader guessing which side is stale.
   */
  here: string;
  /** Only when a deploy tree was identified — `resolveDeployTree` said so. */
  deployDir?: string;
  source?: DeployTreeSource;
  /** `in-sync`/`drifted` only. Names, never values. `previous` is the deploy tree, so `added` reads
   *  as "only in this checkout" and `removed` as "only over there" — the same orientation the deploy
   *  gate prints, so `+` and `-` mean the same thing in both places. */
  diff?: NameDiff;
  /** How many files were compared. Distinguishes "both trees hold the same 19 files" from the
   *  vacuous agreement of two trees that hold none — an empty diff is not evidence on its own. */
  compared?: number;
  /** Why `no-deploy-tree`/`unreadable`, in the words of whatever refused. */
  detail?: string;
}

/**
 * `here` is the checkout doctor is running from, `tree` whatever `resolveDeployTree` found.
 *
 * Reads both trees with `readSteeringSnapshot` — the deploy gate's own function, with the gate's own
 * semantics on each side, and **that includes both of its asymmetries**:
 *
 * - Symlinks. `"dev"` follows them (a linked glossary is what a reader would get); `"app"` does not
 *   (a link there is the pre-2026-08-09 layout, not a snapshot, and reports as drift because it is).
 * - `db:export` artifacts. Filtered out of the development listing, left in the deploy one, so a
 *   few-shot copy an earlier deploy froze is visible here exactly as it is visible to the gate.
 *
 * Sharing the derivation is the point, so inheriting what it decides is not a compromise: a doctor
 * that answered "identical" where `deploy:freeze --check` stops the deploy over seven files would be
 * the second, disagreeing answer this module was written to prevent. What doctor may legitimately do
 * differently is *grade* the result — hence `stale-in-deploy`.
 */
export function deploySteeringStatus(here: string, tree: DeployTree): DeploySteeringStatus {
  if (!tree.known) return { kind: "no-deploy-tree", here, detail: tree.detail };

  const { dir, source } = tree;
  // Symlinks are how one directory acquires two names — `%h/.herald/app` resolved by systemd, a
  // hand-typed path through a linked home — and comparing a tree with itself under its other name
  // would report a confident "in-sync" for a comparison that never happened.
  if (canonical(here) === canonical(dir)) return { kind: "same-tree", here, deployDir: dir, source };
  if (!existsSync(dir)) {
    return { kind: "unreadable", here, deployDir: dir, source, detail: "no such directory" };
  }

  const mine = readSteeringSnapshot(here, "dev");
  // A checkout with no steering config of its own cannot be the source of anybody's — and the check
  // directly above this one in `doctor.ts` already fails on exactly that, by name and by count.
  // Without this branch a git worktree (which never receives the git-ignored files) reports every
  // deployed file as drift and calls itself the record of truth, which is the wrong tree and the
  // wrong finding. `skeletonSteeringFiles` stays silent on a missing file for the same reason: one
  // cause, reported once, by the check whose job it is.
  if (mine.size === 0) return { kind: "nothing-here", here, deployDir: dir, source };

  const deployed = readSteeringSnapshot(dir, "app");
  const diff = diffFiles(deployed, mine);
  return {
    // Graded by *direction*, not by whether the diff is empty. `added`/`changed` mean the scheduler
    // is missing config or running different config — the failure this check exists for. `removed`
    // alone means it is carrying something extra, which is never what makes a translation wrong.
    kind: isEmptyDiff(diff)
      ? "in-sync"
      : diff.added.length + diff.changed.length > 0
        ? "drifted"
        : "stale-in-deploy",
    here,
    deployDir: dir,
    source,
    diff,
    compared: new Set([...deployed.keys(), ...mine.keys()]).size,
  };
}

/**
 * The status as doctor's one line.
 *
 * **`drifted` is a warn, not a fail.** Between a `pnpm glossary add` and the next deploy the trees
 * are *supposed* to disagree, and that window is minutes of ordinary work — a `fail` would exit
 * non-zero on a healthy repo doing the intended thing, which is how a check gets switched off. What
 * makes drift worth saying at all is that nothing else says it, and that it stops being minutes the
 * moment somebody forgets.
 *
 * **`stale-in-deploy` is `ok`, and worded so it does not read as a fault**, because it is not one:
 * the deploy tree is carrying files this checkout stopped syncing, the scheduler reads none of them,
 * and the next ordinary deploy sweeps them. It still gets a line rather than being folded into
 * `in-sync` — the trees genuinely are not identical, `deploy:freeze --check` will list the same
 * names, and a reader who sees them there should have been told here first.
 *
 * **`no-deploy-tree`, `same-tree` and `nothing-here` are `ok`, and each says "not applicable" in its
 * own words.** None of them is a finding: they state that the question cannot be answered from here,
 * and the three reasons are different enough that a reader has to be told which one applies.
 * `outputRootResult` (`checks.ts`) sets the precedent — always `ok`, because it states a fact rather
 * than grading one — and a `warn` would be worse than useless, since every open-source user and
 * every CI run would carry it forever and learn to scroll past it.
 */
export function deploySteeringResult(s: DeploySteeringStatus): CheckResult {
  const name = DEPLOY_STEERING_CHECK;
  const where = s.deployDir === undefined ? "" : `${s.deployDir} (${sourceLabel(s.source)})`;

  switch (s.kind) {
    case "no-deploy-tree":
      return {
        name,
        status: "ok",
        detail: `not applicable — ${s.detail}; set ${DEPLOY_DIR_VAR} if this machine has a deploy checkout`,
      };
    case "same-tree":
      // Deliberately not "in sync". This IS the deployed tree, and the development checkout it is
      // copied from is not identified from inside it, so agreement was never established.
      return {
        name,
        status: "ok",
        detail: `not applicable — this checkout IS the deploy tree (${s.here}, per ${sourceLabel(s.source)}); run pnpm doctor in the development checkout to compare them`,
      };
    case "nothing-here":
      return {
        name,
        status: "ok",
        detail: `not applicable — this checkout holds no steering config to compare against ${where}; the check above is where that is graded`,
      };
    case "unreadable":
      return { name, status: "warn", detail: `deploy tree ${where} could not be read — ${s.detail}` };
    case "in-sync":
      return {
        name,
        status: "ok",
        detail: `${s.compared} file(s) identical in the deploy tree ${where}`,
      };
    case "stale-in-deploy":
      return {
        name,
        status: "ok",
        detail:
          `every steering file this checkout syncs is identical in the deploy tree ${where}; ` +
          `it also still holds ${s.diff?.removed.length} file(s) this checkout no longer syncs ` +
          `(${names(s.diff?.removed ?? [])}) — nothing the schedulers read, and the next ` +
          `bash deploy/herald-deploy.sh sweeps them`,
      };
    case "drifted":
      return {
        name,
        status: "warn",
        detail:
          `${changedCount(s.diff)} of ${s.compared} steering file(s) differ · ${groups(s.diff)} · ` +
          `this checkout (${s.here}) is the record of truth, ${where} is what the schedulers run — ` +
          `run bash deploy/herald-deploy.sh`,
      };
  }
}

function sourceLabel(source: DeployTreeSource | undefined): string {
  return source === "env" ? DEPLOY_DIR_VAR : `${WATCH_UNIT} WorkingDirectory`;
}

function changedCount(diff: NameDiff | undefined): number {
  return diff === undefined ? 0 : diff.added.length + diff.changed.length + diff.removed.length;
}

/**
 * The three ways two trees disagree, each labelled by *direction* rather than by a `+`/`~`/`-` glyph.
 * The deploy gate can afford the glyphs — it prints a legend's worth of context around them — but
 * this is one line in a report of unrelated lines, and "+ translation/glossary.json" does not say
 * which of the two directories is missing it.
 */
function groups(diff: NameDiff | undefined): string {
  if (diff === undefined) return "";
  return [
    diff.added.length > 0 ? `only here: ${names(diff.added)}` : "",
    diff.changed.length > 0 ? `differing: ${names(diff.changed)}` : "",
    // "swept" rather than "missing here": in this direction the deploy tree is carrying something
    // extra, which the deploy resolves by deletion and which is nobody's mistake — see
    // `stale-in-deploy`, the state a difference made only of these gets on its own.
    diff.removed.length > 0 ? `only in the deploy tree, to be swept: ${names(diff.removed)}` : "",
  ]
    .filter(Boolean)
    .join(" · ");
}

/**
 * Names, capped. A real drift is one or two files; the uncapped case is a tree that was never
 * deployed at all, where nineteen paths would push the sentence that says what to do off the far
 * right of the terminal. The count above the list is the part that is always true, so the tail is
 * what gets dropped.
 */
function names(list: string[], limit = 4): string {
  return list.length <= limit
    ? list.join(", ")
    : `${list.slice(0, limit).join(", ")} +${list.length - limit} more`;
}

/** `realpath` where the path exists, plain resolution where it does not — a deploy directory that is
 *  gone still has to compare unequal to this one rather than throw. */
function canonical(path: string): string {
  try {
    return realpathSync(path);
  } catch {
    return resolve(path);
  }
}
