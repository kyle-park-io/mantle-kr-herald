import "./registerErrorHandler";
import { WatchTick } from "../app/WatchTick";
import { ClaudeCodeAgent } from "../adapters/agent/ClaudeCodeAgent";
import { runStage } from "../adapters/agent/runStage";
import { realClaudeSpawn } from "./claudeSpawn";
import { watchOutcome } from "./watchSummary";
import { watchStartupLine } from "./watchStartup";
import { loadDbConfig } from "../config";
import { OUTPUT_DIR } from "../paths";

// Printed before any stage runs, so a run against the wrong output root or the wrong database —
// the exact mistake that once advanced the collect watermark 39 threads past what production had
// seen (src/paths.ts's OUTPUT_DIR doc comment) — is visible in every tick's
// `journalctl --user -u herald-watch`, not only when someone happens to run `pnpm doctor` first.
console.log(watchStartupLine(OUTPUT_DIR, process.env.HERALD_OUTPUT_DIR, loadDbConfig()));

// No database connection here, deliberately: each stage `runStage` spawns (`collect`,
// `translate:prepare`, `translate:align`) opens and closes its own. Holding one open here would
// keep it open for the whole tick, including the minutes `claude` is thinking. `loadDbConfig()`
// above only reads and validates DATABASE_URL/HERALD_DB_ENV from the environment for the startup
// line — it never opens a connection.
const agent = new ClaudeCodeAgent(realClaudeSpawn);

const report = await new WatchTick(runStage, agent).run();
const { line, exitCode } = watchOutcome(report);

console.log(line);
process.exitCode = exitCode;
