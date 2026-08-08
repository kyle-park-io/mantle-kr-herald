import "./registerErrorHandler";
import { WatchTick } from "../app/WatchTick";
import { ClaudeCodeAgent } from "../adapters/agent/ClaudeCodeAgent";
import { runStage } from "../adapters/agent/runStage";
import { realClaudeSpawn } from "./claudeSpawn";
import { watchOutcome } from "./watchSummary";
import { watchStartupLine } from "./watchStartup";
import { loadDbConfig } from "../config";
import { createDb } from "../adapters/db/createDb";
import { PgTranslateFloorReport } from "../adapters/store/PgTranslateFloorReport";
import type { TranslateFloorReport } from "../status/translateFloor";
import { parseTranslateSince } from "./translateSince";
import { parseWatchBatch } from "./watchBatch";
import { refuseCollectMaxPagesOverride } from "./collectMaxPages";
import { OUTPUT_DIR } from "../paths";

// Before the startup line, and before any stage runs: a typo'd cutoff must stop the tick here,
// not reach `translate:prepare --since` as garbage and quietly translate nothing for as long as
// nobody reads a journal. registerErrorHandler turns the throw into a non-zero exit, which is
// what herald-watch.service's OnFailure= hook is watching for.
const translateSince = parseTranslateSince(process.env.HERALD_TRANSLATE_SINCE);

// Same reasoning, same place: a typo'd batch size must stop the tick here, not reach
// `translate:prepare --limit`/`translate:align --limit` as garbage.
const batch = parseWatchBatch(process.env.HERALD_WATCH_BATCH);

// And the same place again, for the one variable a tick must never carry at all. Every document
// that mentions HERALD_COLLECT_MAX_PAGES claims the scheduler's unit does not set it; this is what
// makes that true rather than hopeful. A stray value left in the repo's .env after a backfill would
// reach every stage (each is spawned as `pnpm <script>`, which reads .env), truncate every collect,
// and lose the older tail on every tick — see the function's own comment.
refuseCollectMaxPagesOverride(process.env.HERALD_COLLECT_MAX_PAGES);

// Printed before any stage runs, so a run against the wrong output root or the wrong database —
// the exact mistake that once advanced the collect watermark 39 threads past what production had
// seen (src/paths.ts's OUTPUT_DIR doc comment) — is visible in every tick's
// `journalctl --user -u herald-watch`, not only when someone happens to run `pnpm doctor` first.
// batch and translateSince are already computed above, so this line also names the two values an
// operator can change without a deploy — the tick's inputs, not just its eventual outcome.
//
// `dbConfig` is bound rather than inlined because `recordTranslateFloor` below needs the same one:
// the row this tick writes has to land in the database this tick's own stages read and write, and
// two independent `loadDbConfig()` calls is one more place for a startup line to name a target the
// work does not use.
const dbConfig = loadDbConfig();
console.log(watchStartupLine(OUTPUT_DIR, process.env.HERALD_OUTPUT_DIR, dbConfig, { batch, translateSince }));

// No database connection held open across the tick, deliberately: each stage `runStage` spawns
// (`collect`, `translate:prepare`, `translate:align`) opens and closes its own, and one kept open
// here would stay open for the whole tick, including the minutes `claude` is thinking.
// `loadDbConfig()` above only reads and validates DATABASE_URL/HERALD_DB_ENV from the environment
// for the startup line — it never opens a connection.
//
// `recordTranslateFloor` below is the one exception, and it keeps to the same rule the other way
// round: it opens a pool, writes one row, and closes it, all inside a single call at the start of
// the tick. Nothing is held while the agent runs.
const agent = new ClaudeCodeAgent(realClaudeSpawn);

/**
 * Writes down the floor this tick is running with, so a reader that cannot ask systemd can still
 * see it. The hosted dashboard is a Vercel function — no systemd, no timer, no unit — so before
 * this its 수집 card could only say "cannot be read from here".
 *
 * This is a *report*, not a second home for the value: `herald-watch.service`'s
 * `HERALD_TRANSLATE_SINCE=` is still the only place the floor is set, `translateSince` above is
 * parsed straight out of it, and nothing ever reads this row back to decide what to translate.
 * Copying the floor into a second configured place (a Vercel env var was the obvious alternative)
 * would give one content decision two homes, free to drift apart silently.
 *
 * Errors are the caller's to absorb, not this function's: `WatchTick.recordFloor` wraps the call so
 * a database that is briefly unreachable warns into the journal and the tick carries on. Which is
 * also why the pool is closed in `finally` — a failed write must not leak a pool into the minutes
 * of agent work that follow it.
 */
const recordTranslateFloor = async (floorReport: TranslateFloorReport): Promise<void> => {
  const db = createDb(dbConfig);
  try {
    await new PgTranslateFloorReport(db).write(floorReport);
  } finally {
    await db.close();
  }
};

const report = await new WatchTick(runStage, agent, {
  translateSince,
  batch,
  reportFloor: recordTranslateFloor,
}).run();
const { line, exitCode, notes } = watchOutcome(report);

// `WatchTick` reports no notes today, so this loop prints nothing — it is here so that the day it
// does, they reach the journal rather than being dropped by the one entry point that never learned
// about them. Before the outcome line, so that line stays last for herald-notify-failure.sh's tail.
for (const note of notes) console.log(note);
console.log(line);
process.exitCode = exitCode;
