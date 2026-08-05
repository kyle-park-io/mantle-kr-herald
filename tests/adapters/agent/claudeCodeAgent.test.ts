import { describe, it, expect } from "vitest";
import { ClaudeCodeAgent } from "../../../src/adapters/agent/ClaudeCodeAgent";

const ok = (stdout: string) => async () => ({ code: 0, stdout, stderr: "" });

describe("ClaudeCodeAgent", () => {
  it("asks for json output and never skips permissions", async () => {
    let seen: string[] = [];
    const agent = new ClaudeCodeAgent(async (_cmd, args) => {
      seen = args;
      return { code: 0, stdout: '{"result":"saved 1"}', stderr: "" };
    });

    await agent.fill("output/translations/worksheets/batch-X.md", "translation");

    expect(seen).toContain("--output-format");
    expect(seen).toContain("json");
    expect(seen).not.toContain("--dangerously-skip-permissions");
    expect(seen.join(" ")).not.toContain("--approve");
  });

  it("fails when the agent exits non-zero", async () => {
    const agent = new ClaudeCodeAgent(async () => ({ code: 1, stdout: "", stderr: "boom" }));
    const result = await agent.fill("w.md", "translation");
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.detail).toContain("boom");
  });

  it("fails on a zero exit with unparseable output", async () => {
    const agent = new ClaudeCodeAgent(ok("Killed"));
    const result = await agent.fill("w.md", "translation");
    expect(result.ok).toBe(false);
  });
});
