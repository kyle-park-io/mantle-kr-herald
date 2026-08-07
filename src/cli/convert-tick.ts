import "./registerErrorHandler";
import { ConvertTick } from "../app/ConvertTick";
import { ClaudeCodeAgent } from "../adapters/agent/ClaudeCodeAgent";
import { runStage } from "../adapters/agent/runStage";
import { realClaudeSpawn } from "./claudeSpawn";
import { tickOutcome } from "./tickOutcome";
import { tickStartupLine } from "./tickStartup";
import { loadDbConfig } from "../config";
import { parseConvertBatch } from "./convertBatch";
import { OUTPUT_DIR } from "../paths";

// Before the startup line, and before any stage runs: a typo'd batch size must stop the tick here,
// not reach `convert:prepare --limit` as garbage and quietly convert nothing (or everything) for as
// long as nobody reads a journal. registerErrorHandler turns the throw into a non-zero exit, which
// is what herald-convert.service's OnFailure= hook is watching for.
const batch = parseConvertBatch(process.env.HERALD_CONVERT_BATCH);

// Printed before any stage runs, so a run against the wrong output root or the wrong database — the
// exact mistake that once advanced the collect watermark 39 threads past what production had seen
// (src/paths.ts's OUTPUT_DIR doc comment) — is visible in every tick's
// `journalctl --user -u herald-convert`, not only when someone happens to run `pnpm doctor` first.
// The output root matters as much here as it does for `pnpm watch`, and for a file of its own:
// `convert:prepare` writes output/variants/pending.json and `convert:save` reads it back for each
// variant's sourceKorean, so a tick attached to the wrong root prepares a batch the agent's own
// saves cannot find.
console.log(tickStartupLine("convert", OUTPUT_DIR, process.env.HERALD_OUTPUT_DIR, loadDbConfig(), [`batch ${batch}`]));

// No HERALD_COLLECT_MAX_PAGES refusal here, unlike `watch.ts`: that variable only ever reaches
// `collect`, and no stage this tick runs collects anything.
//
// No database connection here either, deliberately: each stage `runStage` spawns (`convert:prepare`,
// `status`) opens and closes its own. Holding one open here would keep it open for the whole tick,
// including the minutes `claude` is thinking — and this scheduler's whole cadence was sized around
// how long a Neon compute stays awake. `loadDbConfig()` above only reads and validates
// DATABASE_URL/HERALD_DB_ENV from the environment for the startup line; it never opens a connection.
const agent = new ClaudeCodeAgent(realClaudeSpawn);

const report = await new ConvertTick(runStage, agent, { batch }).run();
const { line, exitCode } = tickOutcome("convert", report);

console.log(line);
process.exitCode = exitCode;
