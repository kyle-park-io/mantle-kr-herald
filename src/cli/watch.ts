import "./registerErrorHandler";
import { WatchTick } from "../app/WatchTick";
import { ClaudeCodeAgent } from "../adapters/agent/ClaudeCodeAgent";
import { runStage } from "../adapters/agent/runStage";
import { realClaudeSpawn } from "./claudeSpawn";
import { watchOutcome } from "./watchSummary";
import { watchStartupLine } from "./watchStartup";
import { loadDbConfig } from "../config";
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
console.log(watchStartupLine(OUTPUT_DIR, process.env.HERALD_OUTPUT_DIR, loadDbConfig(), { batch, translateSince }));

// No database connection here, deliberately: each stage `runStage` spawns (`collect`,
// `translate:prepare`, `translate:align`) opens and closes its own. Holding one open here would
// keep it open for the whole tick, including the minutes `claude` is thinking. `loadDbConfig()`
// above only reads and validates DATABASE_URL/HERALD_DB_ENV from the environment for the startup
// line — it never opens a connection.
const agent = new ClaudeCodeAgent(realClaudeSpawn);

const report = await new WatchTick(runStage, agent, { translateSince, batch }).run();
const { line, exitCode } = watchOutcome(report);

console.log(line);
process.exitCode = exitCode;
