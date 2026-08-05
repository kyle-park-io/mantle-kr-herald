import "./registerErrorHandler";
import { WatchTick } from "../app/WatchTick";
import { ClaudeCodeAgent } from "../adapters/agent/ClaudeCodeAgent";
import { runStage } from "../adapters/agent/runStage";
import { realClaudeSpawn } from "./claudeSpawn";
import { watchOutcome } from "./watchSummary";

// No database connection here, deliberately: each stage `runStage` spawns (`collect`,
// `translate:prepare`, `translate:align`) opens and closes its own. Holding one open here would
// keep it open for the whole tick, including the minutes `claude` is thinking.
const agent = new ClaudeCodeAgent(realClaudeSpawn);

const report = await new WatchTick(runStage, agent).run();
const { line, exitCode } = watchOutcome(report);

console.log(line);
process.exitCode = exitCode;
