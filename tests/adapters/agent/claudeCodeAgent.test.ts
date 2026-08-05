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
    expect(seen).not.toContain("--approve");
  });

  it("tells the model plainly, in the prompt itself, never to pass --approve", async () => {
    let seen: string[] = [];
    const agent = new ClaudeCodeAgent(async (_cmd, args) => {
      seen = args;
      return { code: 0, stdout: '{"result":"saved 1"}', stderr: "" };
    });

    await agent.fill("output/translations/worksheets/batch-X.md", "translation");

    // Found by content, not position: "1차 검수" only ever appears in the prompt's approval-
    // boundary text, never in the fixed `--allowedTools`/`--disallowedTools` rule strings (one of
    // which also contains the substring "translate:save", so matching on that would be ambiguous).
    const prompt = seen.find((arg) => arg.includes("1차 검수"));
    expect(prompt).toBeDefined();
    expect(prompt).toContain("--approve");
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
