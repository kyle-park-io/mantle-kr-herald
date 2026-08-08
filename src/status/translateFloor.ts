// `parseTranslateSince` lives beside the CLI that first needed it, and this imports it from there
// rather than growing a second parser: the floor `pnpm status` reports and the floor `pnpm watch`
// hands to `translate:prepare --since` have to be the same string, normalisation included, or the
// number printed here is not the number the scheduler selects with.
import { parseTranslateSince } from "../cli/translateSince";
// The measurement, not a re-derivation of it: `XThreadIntake` is what `xThreadIntake` counts beside
// the filter that does the dropping. A shape declared locally here would be a second place the two
// numbers are defined, and the note below would eventually describe something the pipeline stopped
// doing. Type-only — nothing in this module runs adapter code.
import type { XThreadIntake } from "../adapters/content/XContentSource";

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
  /**
   * What X collection handed the pipeline before the reply filter, when the caller could count it.
   * Optional, and every note state below still prints without it: only `pnpm status` has the
   * `x_threads` rows in hand, and the dashboard, `WatchTick`'s fixtures and every test build a scope
   * without ever reading that table. A required field here would make them fabricate one.
   */
  intake?: XThreadIntake;
}

/**
 * `items` is every collected item, and the comparison is `createdAt >= floor` as *strings* — the
 * identical expression `PrepareTranslations.applySelector` filters with. Anything cleverer here
 * (parsing to Date, tolerating a missing timestamp) would report a scope the scheduler does not
 * have: an item with `createdAt: ""` (a thread `flattenXThreads` found no tweets for) sorts below
 * every floor, so it is never selected, so it is not in scope.
 *
 * `intake` is carried through untouched rather than derived from `items`: by the time an item exists
 * the dropped threads are gone, so nothing here can recover them — they have to be counted where the
 * rows still are (`xThreadIntake`), and travel beside the total they must reconcile with.
 */
export function collectedScope(
  items: { createdAt: string }[],
  floor: TranslateFloorStatus,
  intake?: XThreadIntake,
): CollectedScope {
  const since = floor.kind === "configured" ? floor.floor : undefined;
  return {
    floor,
    total: items.length,
    inScope: since === undefined ? undefined : items.filter((i) => i.createdAt >= since).length,
    intake,
  };
}

/**
 * One term of the intake funnel, as arithmetic rather than as words: `kind` names which number it
 * is, `op` says how it enters the sum, and each reader supplies its own label. `pnpm status` prints
 * `223 X threads - 92 replies dropped + 3 Lark`; the dashboard's hover card prints those same three
 * terms in Korean.
 *
 * Sharing the finished *string* would have put English on a Korean screen; sharing nothing would
 * have put the arithmetic — which terms appear, in which order, with which sign — in two places free
 * to disagree. This is the seam between the two: the sum is decided once, the wording twice.
 */
export interface IntakeTerm {
  kind: "threads" | "replies-dropped" | "lark";
  /** How this term enters the sum. Absent on the first term, which starts it. */
  op?: "-" | "+";
  count: number;
}

/**
 * How much of the collected total the scheduler can still reach — `TranslateFloorKind`'s five states
 * reduced to the three a reader has to tell apart, which is exactly the three branches `floorNote`
 * has always printed:
 *
 * - `measured` — a floor is set and both sides of it were counted.
 * - `no-floor` — the unit is loaded and sets none. **The alarming one**, and emphatically not the
 *                same as `unknown`: it means the scheduler is draining the whole collected backlog
 *                oldest first.
 * - `unknown`  — nothing here could read the floor (`not-installed`, `unreadable`, `invalid`). The
 *                hosted dashboard is always this and always will be: a Vercel function has no
 *                systemd to ask. It says nothing whatever about whether a floor is set.
 *
 * The reduction lives here rather than in each reader because the distinction it has to preserve is
 * the whole point of the module: `no-floor` and `unknown` are opposite facts, and a UI that
 * collapses them any further is back to reporting a number as though it had been checked.
 *
 * `detail` carries the refusal's own words so `invalid`'s parse error is not lost in the collapse.
 */
export interface CollectedReach {
  kind: "measured" | "no-floor" | "unknown";
  /** Items the scheduler can select. Set for `measured`, and for `no-floor` where it is all of them. */
  inScope?: number;
  /** Items below the floor, which are never selected. Only `measured`. */
  belowFloor?: number;
  /** The floor itself, normalised ISO. Only `measured`, and only when a `configured` floor produced
   *  it — a hand-built scope can state an `inScope` without naming what it was measured against. */
  floor?: string;
  /** Why nothing could be read, in the words of whatever refused. Only `unknown`, and not always. */
  detail?: string;
}

/**
 * Everything behind a Collected total, computed once for both readers: `pnpm status` renders it as
 * one line of text (`collectedScopeNote` below), the dashboard renders it as a hover card
 * (`web/src/collectedBreakdown.ts`). The CLI's line is literally formatted from this value, so "the
 * header says something `pnpm status` does not" stops being a state the two can be in — which is
 * the split that already happened once, when the CLI learned about the terminal `posted` status and
 * the header did not.
 */
export interface CollectedBreakdown {
  /** The funnel's terms, in print order. Absent where there is no honest funnel to draw — see
   *  `intakeTerms`. */
  intake?: IntakeTerm[];
  /** The collected total the terms above add up to. */
  total: number;
  reach: CollectedReach;
}

/** The scope, reduced to what a reader is actually told. Both readers start here. */
export function collectedBreakdown(scope: CollectedScope): CollectedBreakdown {
  return {
    intake: scope.intake && intakeTerms(scope.intake, scope.total),
    total: scope.total,
    reach: collectedReach(scope),
  };
}

function collectedReach(scope: CollectedScope): CollectedReach {
  // `inScope !== undefined` rather than `floor.kind === "configured"`, carried over unchanged from
  // the note this replaced: a caller that measured a scope has one to report, whatever the floor's
  // provenance, and changing the predicate here would change `pnpm status`'s output.
  if (scope.inScope !== undefined) {
    return {
      kind: "measured",
      inScope: scope.inScope,
      belowFloor: scope.total - scope.inScope,
      floor: scope.floor.floor,
    };
  }
  if (scope.floor.kind === "none") return { kind: "no-floor", inScope: scope.total };
  return { kind: "unknown", detail: scope.floor.detail };
}

/** The English label per term, for the one-line CLI form below. The dashboard keeps its own, in
 *  Korean (`web/src/collectedBreakdown.ts`) — which is why the shared value carries a `kind` and not
 *  a label. */
const INTAKE_TERM_LABEL: Record<IntakeTerm["kind"], string> = {
  threads: "X threads",
  "replies-dropped": "replies dropped",
  lark: "Lark",
};

/**
 * The note beside the Collected total, and the reason this module reaches into the pipeline table at
 * all. A bare `Collected (X + Lark)  108` was read as a backlog of 108 and reported to a human as
 * one, when the floor put the older two thirds of it permanently out of the scheduler's reach.
 * Every state therefore says something — "scope unknown" included, because the alternative is the
 * bare total that caused the mistake.
 *
 * The intake funnel goes in front of that, never in place of it: same line, left to right, from what
 * collection found to what the scheduler can still reach.
 *
 * Formatted from `collectedBreakdown` rather than computing its own numbers, so this line and the
 * dashboard card cannot report different arithmetic for the same scope.
 */
export function collectedScopeNote(scope: CollectedScope): string {
  const { intake, reach } = collectedBreakdown(scope);
  const funnel = intake
    ?.map((t) => `${t.op ? `${t.op} ` : ""}${t.count} ${INTAKE_TERM_LABEL[t.kind]}`)
    .join(" ");
  return funnel ? `${funnel} · ${floorNote(reach)}` : floorNote(reach);
}

function floorNote(reach: CollectedReach): string {
  switch (reach.kind) {
    case "measured":
      return `in scope ${reach.inScope} · below floor ${reach.belowFloor}`;
    case "no-floor":
      return `in scope ${reach.inScope} · no floor set`;
    case "unknown":
      return "scope unknown · no floor could be read";
  }
}

/**
 * How the collected total was arrived at: `223 X threads - 92 replies dropped + 3 Lark`, as terms
 * of a sum that ends on the number beside it.
 *
 * **Why the Lark term is here at all.** `threads - repliesDropped` is the X item count, 131 — but
 * the headline says 134, because three Lark items are in the total and are not threads. Left
 * unnamed, a reader who subtracts comes up 3 short and concludes the pipeline lost items: the same
 * shape of mistake as reading the bare total as a backlog, which is what put this funnel on the line
 * in the first place. So the third term is named, and the whole segment reads as a sum.
 *
 * **Why it is derived, not counted.** The remainder is `total - (threads - repliesDropped)`, never a
 * separate count of Lark items. Derived, the printed line reconciles by construction and there is no
 * arrangement of the numbers that leaves a silent gap. Counted, the two could disagree and the line
 * would show a funnel that visibly fails to reach its own total — reporting a defect that does not
 * exist. The label is "Lark" because the stage this sits on is `Collected (X + Lark)`: those are the
 * two sources, and a third would rename the stage first.
 *
 * The disagreement is still possible in one direction — the threads and the items are two reads of
 * the same database, so a `collect` landing between them can imply more X items than there are
 * collected items at all. That is the one case that prints no funnel: a negative term is nonsense,
 * and the floor note still says everything it said before.
 *
 * Zero terms are omitted rather than printed. `- 0 replies dropped` sends a reader looking for
 * something that did not happen, and dropping a zero term changes no arithmetic.
 *
 * The omission rules live here, once, for the same reason the derivation does: a card that dropped
 * a different set of terms than the CLI line would be a second funnel, and the two would eventually
 * disagree about a total they are both supposed to reach.
 */
function intakeTerms(intake: XThreadIntake, total: number): IntakeTerm[] | undefined {
  // Nothing came from X: `0 X threads + 3 Lark` is not a funnel, it is noise in front of the number
  // that matters. A deployment with no X collection reads exactly as it did before.
  if (intake.threads === 0) return undefined;
  const xItems = intake.threads - intake.repliesDropped;
  const rest = total - xItems;
  if (xItems < 0 || rest < 0) return undefined;
  const terms: IntakeTerm[] = [{ kind: "threads", count: intake.threads }];
  if (intake.repliesDropped > 0) terms.push({ kind: "replies-dropped", op: "-", count: intake.repliesDropped });
  if (rest > 0) terms.push({ kind: "lark", op: "+", count: rest });
  return terms;
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
