import { describe, it, expect } from "vitest";
import { ClaudeCodeAgent } from "../../../src/adapters/agent/ClaudeCodeAgent";
import { paths } from "../../../src/paths";

const ok = (stdout: string) => async () => ({ code: 0, stdout, stderr: "" });

const VALID_ENVELOPE = JSON.stringify({ is_error: false, permission_denials: [], result: "ok" });

describe("ClaudeCodeAgent", () => {
  it("asks for json output and never skips permissions", async () => {
    let seen: string[] = [];
    const agent = new ClaudeCodeAgent(async (_cmd, args) => {
      seen = args;
      return { code: 0, stdout: VALID_ENVELOPE, stderr: "" };
    });

    await agent.fill("output/translations/worksheets/batch-X.md", "translation");

    expect(seen).toContain("--output-format");
    expect(seen).toContain("json");
    expect(seen).not.toContain("--dangerously-skip-permissions");
    expect(seen).not.toContain("--approve");
  });

  it("never bypasses permissions under the other spelling either", async () => {
    let seen: string[] = [];
    const agent = new ClaudeCodeAgent(async (_cmd, args) => {
      seen = args;
      return { code: 0, stdout: VALID_ENVELOPE, stderr: "" };
    });

    await agent.fill("output/translations/worksheets/batch-X.md", "translation");

    // --permission-mode bypassPermissions grants the same capability as
    // --dangerously-skip-permissions under a different flag name.
    expect(seen).not.toContain("--permission-mode");
    expect(seen).not.toContain("bypassPermissions");
  });

  it("tells the model plainly, in the prompt itself, never to pass --approve", async () => {
    let seen: string[] = [];
    const agent = new ClaudeCodeAgent(async (_cmd, args) => {
      seen = args;
      return { code: 0, stdout: VALID_ENVELOPE, stderr: "" };
    });

    await agent.fill("output/translations/worksheets/batch-X.md", "translation");

    // Located by position, not content: "-p"'s value is always the prompt, unambiguously.
    const promptIndex = seen.indexOf("-p");
    expect(promptIndex).toBeGreaterThanOrEqual(0);
    const prompt = seen[promptIndex + 1];
    // The prohibitive phrasing itself, not just the substring "--approve" — a flipped instruction
    // like "Always pass `--approve`" also contains that substring and must not pass this test.
    expect(prompt).toContain("Never pass `--approve`");
  });

  it("scopes the Read/Edit rules to the real, absolute worksheets directory", async () => {
    let seen: string[] = [];
    const agent = new ClaudeCodeAgent(async (_cmd, args) => {
      seen = args;
      return { code: 0, stdout: VALID_ENVELOPE, stderr: "" };
    });

    await agent.fill(`${paths.translationsWorksheets}/batch-X.md`, "translation");

    // paths.translationsWorksheets is itself absolute (built from REPO_ROOT), so the rule needs
    // one extra leading "/" per Claude Code's "//path" absolute-path syntax.
    expect(seen).toContain(`Read(/${paths.translationsWorksheets}/**)`);
    expect(seen).toContain(`Edit(/${paths.translationsWorksheets}/**)`);
  });

  it("succeeds on a clean envelope: exit 0, is_error false, no permission denials", async () => {
    const agent = new ClaudeCodeAgent(ok(VALID_ENVELOPE));
    const result = await agent.fill("w.md", "translation");
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.stdout).toBe(VALID_ENVELOPE);
  });

  it("fails when is_error is true, even though the process exits 0", async () => {
    const stdout = JSON.stringify({ is_error: true, permission_denials: [], result: "hit a wall" });
    const agent = new ClaudeCodeAgent(ok(stdout));
    const result = await agent.fill("w.md", "translation");
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.detail).toContain("hit a wall");
  });

  it("fails when permission_denials is non-empty, and names the blocked tool", async () => {
    const stdout = JSON.stringify({
      is_error: false,
      permission_denials: [{ tool_name: "Bash" }],
      result: "ok",
    });
    const agent = new ClaudeCodeAgent(ok(stdout));
    const result = await agent.fill("w.md", "translation");
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.detail).toContain("Bash");
  });

  it("fails when the agent exits non-zero", async () => {
    const agent = new ClaudeCodeAgent(async () => ({ code: 1, stdout: "", stderr: "boom" }));
    const result = await agent.fill("w.md", "translation");
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.detail).toContain("boom");
  });

  it("fails on a zero exit with unparseable (invalid JSON) output", async () => {
    const agent = new ClaudeCodeAgent(ok("Killed"));
    const result = await agent.fill("w.md", "translation");
    expect(result.ok).toBe(false);
  });

  it("fails on a zero exit with well-formed JSON of the wrong shape", async () => {
    const agent = new ClaudeCodeAgent(ok(JSON.stringify({ hello: "world" })));
    const result = await agent.fill("w.md", "translation");
    expect(result.ok).toBe(false);
  });

  it("returns a failure instead of hanging when the child never responds", async () => {
    const agent = new ClaudeCodeAgent(() => new Promise(() => {}), 50);
    const start = Date.now();
    const result = await agent.fill("w.md", "translation");
    expect(Date.now() - start).toBeLessThan(2000);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.detail).toContain("50ms");
  });
});
