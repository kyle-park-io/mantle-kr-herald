// `parseTranslateSince` lives beside the CLI that first needed it, and this imports it from there
// rather than growing a second parser: the floor `pnpm status` reports and the floor `pnpm watch`
// hands to `translate:prepare --since` have to be the same string, normalisation included, or the
// number printed here is not the number the scheduler selects with.
import { parseTranslateSince } from "../cli/translateSince";

/** The unit the floor's only real home is. Named once, because both the `systemctl` call
 *  (`src/cli/systemdShow.ts`) and every line printed below have to mean the same unit. */
export const WATCH_UNIT = "herald-watch.service";

/** The variable, spelled once — it appears in the systemd property text, in the shell's env, and in
 *  the lines below, and a typo in any one of them would silently report "no floor". */
export const FLOOR_VAR = "HERALD_TRANSLATE_SINCE";

/**
 * The seam. Returns the raw stdout of `systemctl --user show <unit> --property=…`, or `undefined`
 * when that call could not be made or did not succeed — see `src/cli/systemdShow.ts` for the real
 * one, and `tests/status/translateFloor.test.ts` for why every interesting case is a fake: a unit
 * that is not installed, a unit with no floor and a machine with no systemd at all are all states
 * production can be in and the test machine cannot.
 */
export type SystemdShow = () => string | undefined;

/**
 * What is known about the floor the *scheduler* will run with — deliberately five states, not a
 * `string | undefined`:
 *
 * - `configured`    — the loaded unit sets a floor, and `floor` is it, normalised.
 * - `none`          — the unit is loaded and sets no floor. **The alarming one.** It does not mean
 *                     "unconfigured", it means `translate:prepare` selects from the whole collected
 *                     backlog oldest first, which is the outcome the floor exists to prevent.
 * - `not-installed` — systemd has never heard of the unit. A dev machine; no claim about production.
 * - `unreadable`    — systemd could not be asked, or answered something unrecognisable. `detail`
 *                     says which.
 * - `invalid`       — the unit sets a value `parseTranslateSince` refuses. Also alarming: `watch.ts`
 *                     parses it before anything else, so every tick exits non-zero at startup.
 *
 * Collapsing any of these into "no floor known" is the mistake this type exists to prevent — the
 * whole change came from a number being reported as fact when nothing had actually been asked.
 */
export type TranslateFloorKind = "configured" | "none" | "not-installed" | "unreadable" | "invalid";

export interface TranslateFloorStatus {
  kind: TranslateFloorKind;
  /** Normalised ISO instant. Only ever set for `configured` — a floor nobody could read is not a floor. */
  floor?: string;
  /**
   * The invoking shell's own `HERALD_TRANSLATE_SINCE`, present ONLY when it disagrees with the
   * unit's. Never used as the floor: an exported value in one operator's terminal says nothing
   * about what the scheduler runs, and reading it as the answer is the bug this module fixes.
   */
  shellFloor?: string;
  /** Why `unreadable`/`invalid`, in the words of whatever refused — never a second wording of it. */
  detail?: string;
}

/** One `Key=Value` line out of `systemctl show` output. Absent key → undefined; present-but-empty
 *  key → "", and the two mean different things (`Environment=` is a unit that sets nothing). */
function property(show: string, key: string): string | undefined {
  const prefix = `${key}=`;
  const line = show.split(/\r?\n/).find((l) => l.startsWith(prefix));
  return line?.slice(prefix.length);
}

/**
 * The floor out of systemd's `Environment=` text, which is the unit's variables joined by spaces:
 *   `Environment=PATH=/usr/bin HERALD_OUTPUT_DIR=/home/kyle/.herald/output HERALD_TRANSLATE_SINCE=2026-…Z`
 *
 * Split on whitespace: systemd quotes any value containing a space, and an ISO instant never has
 * one, so the only value this can be handed is a single token. The quotes are stripped anyway
 * because systemd may quote a value that did not need it, and a floor printed as `"2026-…"` would
 * not match the string `translate:prepare` compares against.
 */
function floorFromEnvironment(environment: string): string | undefined {
  const token = environment.split(/\s+/).find((t) => t.replace(/^"/, "").startsWith(`${FLOOR_VAR}=`));
  if (token === undefined) return undefined;
  return token.replace(/^"/, "").replace(/"$/, "").slice(FLOOR_VAR.length + 1);
}

/** `parseTranslateSince` with its throw turned into a value: this module is read by a diagnostic
 *  that must print a pipeline table on any machine, so a bad value is something to report. */
function tryParse(raw: string | undefined): { ok: true; value?: string } | { ok: false; detail: string } {
  try {
    return { ok: true, value: parseTranslateSince(raw) };
  } catch (err) {
    return { ok: false, detail: err instanceof Error ? err.message : String(err) };
  }
}

/**
 * What the scheduler's floor is, from the systemd unit that holds it — never from `process.env`.
 *
 * `unitShow` is asked of *systemd*, not read from `deploy/herald-watch.service`, and that is the
 * point: a unit file edited without `systemctl --user daemon-reload` still runs with the values
 * loaded at the last reload, so the file answers "what we meant" and only the manager answers "what
 * will actually run". `shellValue` is the invoking shell's `HERALD_TRANSLATE_SINCE`, which is empty
 * in a hand-run and arbitrary in a shell someone exported it in; it is reported when it disagrees
 * and used for nothing.
 */
export function translateFloorStatus(input: { unitShow?: string; shellValue?: string }): TranslateFloorStatus {
  const status = fromUnit(input.unitShow);

  // Shown, never resolved. Normalised when it can be so it compares with the unit's on instants
  // rather than on spelling ("…25Z" and "…25.000Z" are the same moment); kept verbatim when it
  // cannot be, because an unparseable export is precisely the kind of thing worth seeing.
  const parsed = tryParse(input.shellValue);
  const shell = parsed.ok ? parsed.value : input.shellValue?.trim();
  if (shell && shell !== status.floor) status.shellFloor = shell;

  return status;
}

function fromUnit(show: string | undefined): TranslateFloorStatus {
  if (show === undefined) {
    return { kind: "unreadable", detail: `could not ask systemd about ${WATCH_UNIT}` };
  }

  // LoadState is what separates "no floor" from "no unit": `systemctl show` exits 0 for a unit it
  // has never heard of and prints a bare `Environment=` for it, identical to a loaded unit that
  // sets nothing. Guessing from the Environment line alone would report the most alarming state
  // there is for every machine that simply has no scheduler on it.
  const loadState = property(show, "LoadState");
  if (loadState === undefined) {
    return { kind: "unreadable", detail: `systemctl said nothing about ${WATCH_UNIT}'s LoadState` };
  }
  if (loadState === "not-found") return { kind: "not-installed" };
  if (loadState !== "loaded") {
    // masked, error, bad-setting: the unit exists in some form but will not run as written, so its
    // Environment= is not a promise about anything. Reporting it as the floor would state a cutoff
    // for a tick that never happens.
    return { kind: "unreadable", detail: `${WATCH_UNIT} is ${loadState}, not loaded` };
  }

  const raw = floorFromEnvironment(property(show, "Environment") ?? "");
  const parsed = tryParse(raw);
  if (!parsed.ok) return { kind: "invalid", detail: parsed.detail };
  if (parsed.value === undefined) return { kind: "none" };
  return { kind: "configured", floor: parsed.value };
}

/**
 * How much of the collected total the scheduler can ever select, and the floor that decides it.
 *
 * `total` and `inScope` travel together so the note below can state both without a caller having to
 * hand the same array to two functions and hope they agree.
 */
export interface CollectedScope {
  floor: TranslateFloorStatus;
  total: number;
  /** Items at or after the floor. Undefined when there is no floor to measure against — an unknown
   *  scope must read as unknown, not as zero and not as everything. */
  inScope?: number;
}

/**
 * `items` is every collected item, and the comparison is `createdAt >= floor` as *strings* — the
 * identical expression `PrepareTranslations.applySelector` filters with. Anything cleverer here
 * (parsing to Date, tolerating a missing timestamp) would report a scope the scheduler does not
 * have: an item with `createdAt: ""` (a thread `flattenXThreads` found no tweets for) sorts below
 * every floor, so it is never selected, so it is not in scope.
 */
export function collectedScope(items: { createdAt: string }[], floor: TranslateFloorStatus): CollectedScope {
  const since = floor.kind === "configured" ? floor.floor : undefined;
  return {
    floor,
    total: items.length,
    inScope: since === undefined ? undefined : items.filter((i) => i.createdAt >= since).length,
  };
}

/**
 * The note under the Collected total, and the reason this module reaches into the pipeline table at
 * all. A bare `Collected (X + Lark)  108` was read as a backlog of 108 and reported to a human as
 * one, when the floor put the older two thirds of it permanently out of the scheduler's reach.
 * Every state therefore says something — "scope unknown" included, because the alternative is the
 * bare total that caused the mistake.
 */
export function collectedScopeNote(scope: CollectedScope): string {
  if (scope.inScope !== undefined) {
    return `in scope ${scope.inScope} · below floor ${scope.total - scope.inScope}`;
  }
  if (scope.floor.kind === "none") return `in scope ${scope.total} · no floor set`;
  return "scope unknown · no floor could be read";
}

/**
 * The floor, printed with the pipeline table.
 *
 * Lines are indented two spaces to sit inside that table's block, and none of them may begin with a
 * capitalised stage word followed by a number: `WatchTick` and `ConvertTick` parse this command's
 * stdout for `Translated`/`Converted (variants)` totals with line-anchored patterns, and a second
 * match found ahead of the real stage line would fail every scheduled tick.
 * `tests/status/pipeline.test.ts` holds that to exactly one match per stage.
 *
 * ⚠ marks the two states an operator has to act on, the same way `formatSyncSummary` marks its own.
 * A missing floor gets it because "the unit sets no floor" is not a neutral fact — it is the
 * scheduler spending every tick on the oldest posts in the archive.
 */
export function formatTranslateFloor(status: TranslateFloorStatus): string[] {
  const lines = [`  ${headline(status)}`];
  if (status.shellFloor) {
    // Never merged into the line above. Someone who exported the variable by hand and reads this
    // command must not be told their own value is what production runs with — that mistake is the
    // same shape as the one that made a stale total look like a backlog.
    lines.push(
      `  ⚠ ${FLOOR_VAR} in this shell is ${status.shellFloor} — the shell's value is not what the scheduler uses`,
    );
  }
  return lines;
}

function headline(status: TranslateFloorStatus): string {
  switch (status.kind) {
    case "configured":
      return `translate floor ${status.floor} · ${WATCH_UNIT} — collected items older than it are never selected`;
    case "none":
      return (
        `⚠ translate floor NONE · ${WATCH_UNIT} is loaded but sets no ${FLOOR_VAR} — ` +
        `the whole collected backlog is in scope, oldest first`
      );
    case "not-installed":
      return `translate floor unknown · ${WATCH_UNIT} is not installed here — no scheduler on this machine to ask`;
    case "invalid":
      return `⚠ translate floor unusable · ${WATCH_UNIT}: ${status.detail} — every tick exits at startup on it`;
    case "unreadable":
      return `translate floor unknown · ${status.detail} — this says nothing about what the scheduler runs with`;
  }
}
