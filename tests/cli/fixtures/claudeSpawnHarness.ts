// tests/cli/fixtures/claudeSpawnHarness.ts
//
// Not a test file itself — spawned directly via `tsx` by tests/cli/claudeSpawnKill.test.ts, never
// through `pnpm` and never through the full `watch.ts` pipeline (which can't reach the agent call
// at all without a real, reachable database returning real collected work). Exercises exactly the
// production wiring `watch.ts` uses — `ClaudeCodeAgent` constructed with `realClaudeSpawn`, the
// same named export both this file and `watch.ts` import — so a regression in either one shows up
// here.
//
// argv[2] is the (tiny, test-only) timeoutMs to pass to ClaudeCodeAgent.
import { ClaudeCodeAgent } from "../../../src/adapters/agent/ClaudeCodeAgent";
import { realClaudeSpawn } from "../../../src/cli/claudeSpawn";

const timeoutMs = Number(process.argv[2]);
const agent = new ClaudeCodeAgent(realClaudeSpawn, timeoutMs);

const result = await agent.fill("dummy-worksheet.md", "translation");
console.log(JSON.stringify(result));
