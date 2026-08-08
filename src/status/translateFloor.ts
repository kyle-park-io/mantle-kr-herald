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
 * What the *scheduler itself* recorded about the floor it ran with, on the machine that owns it.
 *
 * The floor's only real home is the systemd unit, and nothing here changes that: this is an
 * observation of that unit made by the tick, not a second place the value is configured. It exists
 * because the hosted dashboard is a Vercel function — no systemd to ask, ever — and the honest
 * `unknown` it showed instead was useless to the people who mostly read that screen. Copying the
 * value into a Vercel env var was the obvious alternative and was rejected: a content decision
 * stored twice drifts silently, which is the exact hazard this whole area exists to remove.
 *
 * So it travels with `at`, always, and every reader is required to show it. This is an observation
 * with an age, not a setting — a scheduler that stopped ticking three weeks ago must read as a
 * three-week-old report, never as a confident current answer.
 */
export interface TranslateFloorReport {
  /**
   * The floor that tick handed `translate:prepare --since`, already normalised by
   * `parseTranslateSince`. Absent when the tick genuinely ran with none — the alarming state, and
   * why this is optional rather than the row simply being missing: "the scheduler reported no floor"
   * and "the scheduler has never reported" are different facts, the same way `none` and
   * `not-installed` are above.
   */
  floor?: string;
  /** When the tick read it. ISO, and never omitted — see this interface's own comment. */
  at: string;
}

/** A `TranslateFloorReport` plus the same measurement `CollectedScope.inScope` carries, taken
 *  against the *reported* floor rather than the one systemd named here. Both counts exist at once so
 *  a reader that has systemd AND a report can compare them instead of picking one blind. */
export interface ReportedScope extends TranslateFloorReport {
  /** Items at or after `floor` — all of them when the reporting tick ran with no floor. */
  inScope: number;
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
  /** Items at or after the floor **systemd named here**. Undefined when there is no floor to measure
   *  against — an unknown scope must read as unknown, not as zero and not as everything. */
  inScope?: number;
  /**
   * The scheduler's own last report, and the same count taken against it. Optional: a caller with no
   * database in hand (every test fixture, `WatchTick`'s own status parsing) builds a scope without
   * one, and absence here means "nothing has been reported", never "no floor".
   *
   * Carried even when systemd answered on this machine, deliberately — see `collectedReach` for the
   * precedence rule and why a disagreement between the two must be shown rather than resolved away.
   */
  reported?: ReportedScope;
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
  report?: TranslateFloorReport,
): CollectedScope {
  const since = floor.kind === "configured" ? floor.floor : undefined;
  return {
    floor,
    total: items.length,
    inScope: since === undefined ? undefined : items.filter((i) => i.createdAt >= since).length,
    // The report's floor is measured with the identical string comparison, over the identical
    // array — not a looser one, and not a second pass over a different query. The reported floor
    // came out of `parseTranslateSince` on the scheduler's side (`watch.ts` parses before anything
    // else runs), so it is already the same normalised shape `applySelector` compares with.
    reported: report && {
      ...report,
      inScope: report.floor === undefined ? items.length : countAtOrAfter(items, report.floor),
    },
    intake,
  };
}

function countAtOrAfter(items: { createdAt: string }[], floor: string): number {
  return items.filter((i) => i.createdAt >= floor).length;
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
 * plus the scheduler's own report, reduced to the four a reader has to tell apart:
 *
 * - `measured` — a floor was read **here**, from systemd, and both sides of it were counted.
 * - `no-floor` — the unit is loaded and sets none. **The alarming one**, and emphatically not the
 *                same as `unknown`: it means the scheduler is draining the whole collected backlog
 *                oldest first.
 * - `reported` — nothing could be read here, but the scheduler recorded what it last ran with. The
 *                numbers are real and the floor is real; what makes this its own state is that both
 *                are *as of* `reportedAt` rather than as of now. The hosted dashboard's normal
 *                state, and the reason this state exists at all.
 * - `unknown`  — nothing could be read here and nothing has been reported (or systemd answered with
 *                something unusable — see `collectedReach` for why that does not fall back). It says
 *                nothing whatever about whether a floor is set.
 *
 * The reduction lives here rather than in each reader because the distinction it has to preserve is
 * the whole point of the module: `no-floor` and `unknown` are opposite facts, `reported` is neither
 * of them, and a UI that collapses any two is back to reporting a number as though it had been
 * checked. `reported` in particular must never render as `measured`: one was verified against the
 * running manager a moment ago, the other is an observation that could be three weeks old.
 *
 * `detail` carries the refusal's own words so `invalid`'s parse error is not lost in the collapse.
 */
export interface CollectedReach {
  kind: "measured" | "no-floor" | "reported" | "unknown";
  /** Items the scheduler can select. Set for `measured`, for `no-floor` where it is all of them, and
   *  for `reported` where it is measured against the reported floor. */
  inScope?: number;
  /** Items below the floor, which are never selected. `measured` and `reported`. */
  belowFloor?: number;
  /** The floor read **here**, from systemd, normalised ISO. Only `measured`, and only when a
   *  `configured` floor produced it — a hand-built scope can state an `inScope` without naming what
   *  it was measured against. Never holds a reported value: the two have different provenance and a
   *  reader that cannot tell them apart is exactly what this type prevents. */
  floor?: string;
  /**
   * The floor the scheduler reported, normalised ISO — absent when the report says it ran with none.
   * Only meaningful alongside `reportedAt`, which is what says a report exists at all.
   */
  reportedFloor?: string;
  /**
   * When the scheduler read `reportedFloor`. Set on `reported` always; set on `measured`/`no-floor`
   * **only when the report disagrees with what systemd says here** — see `collectedReach`. So on
   * those two kinds its presence is itself the disagreement flag, and a reader must show it rather
   * than quietly preferring the fresher number.
   */
  reportedAt?: string;
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

/**
 * Floor kinds where **systemd itself answered** about the floor, whatever the answer was.
 *
 * `configured` and `none` are the two useful answers. `invalid` is here too, and that is the one
 * worth explaining: the unit sets a value `parseTranslateSince` refuses, so `watch.ts` throws before
 * any stage runs and *every tick exits at startup*. A stored report from before that edit would
 * therefore be a report from a scheduler that is now dead — falling back to it would paint a
 * confident floor over the exact failure an operator has to see. So `invalid` keeps its `unknown`,
 * with systemd's own parse error attached.
 *
 * `not-installed` and `unreadable` are the two that are NOT here: nothing was learned either way, so
 * there is nothing for a report to contradict.
 */
function answeredBySystemd(kind: TranslateFloorKind): boolean {
  return kind === "configured" || kind === "none" || kind === "invalid";
}

/**
 * **Precedence: systemd first, the report only as a fallback, and a disagreement is never hidden.**
 *
 * A `systemctl show` is current by construction — it asks the running manager what the next tick
 * will fire with. A stored report is what the *last* tick already fired with, which is the same
 * thing right up until someone edits the unit and reloads. So where the machine can ask, the answer
 * it gets wins; the report is what a reader with no systemd (the hosted dashboard, always) falls
 * back to instead of the bare "cannot be read here" it used to show.
 *
 * When both exist and they differ, neither is dropped: `reportedFloor`/`reportedAt` ride along on
 * the systemd-derived state so the reader can say "the unit now says X, the last tick ran with Y at
 * <time>". That gap is real information — either the scheduler has not ticked since the change, or
 * it has stopped — and resolving it silently in favour of the fresher value is how a dead scheduler
 * looks healthy.
 */
function collectedReach(scope: CollectedScope): CollectedReach {
  const reported = scope.reported;

  // `inScope !== undefined` rather than `floor.kind === "configured"`, carried over unchanged from
  // the note this replaced: a caller that measured a scope has one to report, whatever the floor's
  // provenance, and changing the predicate here would change `pnpm status`'s output.
  if (scope.inScope !== undefined) {
    return withDisagreement(
      {
        kind: "measured",
        inScope: scope.inScope,
        belowFloor: scope.total - scope.inScope,
        floor: scope.floor.floor,
      },
      scope.floor.floor,
      reported,
    );
  }
  if (scope.floor.kind === "none") {
    return withDisagreement({ kind: "no-floor", inScope: scope.total }, undefined, reported);
  }
  if (reported && !answeredBySystemd(scope.floor.kind)) {
    return {
      kind: "reported",
      inScope: reported.inScope,
      belowFloor: scope.total - reported.inScope,
      reportedFloor: reported.floor,
      reportedAt: reported.at,
    };
  }
  return { kind: "unknown", detail: scope.floor.detail };
}

/** Attaches the report to a systemd-derived reach **only when the two name different floors** — see
 *  `collectedReach`'s precedence comment. `undefined === undefined` (the unit sets none and the last
 *  tick ran with none) is agreement, and agreement is nothing to report. */
function withDisagreement(
  reach: CollectedReach,
  floorHere: string | undefined,
  reported: ReportedScope | undefined,
): CollectedReach {
  if (!reported || reported.floor === floorHere) return reach;
  return { ...reach, reportedFloor: reported.floor, reportedAt: reported.at };
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
      return `in scope ${reach.inScope} · below floor ${reach.belowFloor}${disagreementNote(reach)}`;
    case "no-floor":
      return `in scope ${reach.inScope} · no floor set${disagreementNote(reach)}`;
    case "reported":
      // Never worded like `measured`. This machine did not read a floor — it is repeating what the
      // scheduler wrote down, and the instant is part of the claim, not a decoration on it.
      return reach.reportedFloor === undefined
        ? `in scope ${reach.inScope} · ⚠ scheduler reported NO floor, at ${reach.reportedAt}`
        : `in scope ${reach.inScope} · below floor ${reach.belowFloor} · as the scheduler reported at ${reach.reportedAt}`;
    case "unknown":
      return "scope unknown · no floor could be read";
  }
}

/** The suffix a systemd-derived state carries when the scheduler's last report named a different
 *  floor — see `collectedReach`'s precedence comment for why this is printed rather than resolved.
 *  ⚠ because it has exactly two explanations and both need looking at: the unit was edited and the
 *  scheduler has not ticked since, or the scheduler has stopped ticking altogether. */
function disagreementNote(reach: CollectedReach): string {
  if (reach.reportedAt === undefined) return "";
  return ` · ⚠ last tick ran with ${reach.reportedFloor ?? "no floor"}, reported ${reach.reportedAt}`;
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
