import { describe, it, expect } from "vitest";
import { ClaudeCodeAgent } from "../../../src/adapters/agent/ClaudeCodeAgent";
import type { WorksheetKind } from "../../../src/ports/WorksheetAgent";
import { paths } from "../../../src/paths";

const ok = (stdout: string) => async () => ({ code: 0, stdout, stderr: "" });

const VALID_ENVELOPE = JSON.stringify({ is_error: false, permission_denials: [], result: "ok" });

/** Both worksheet kinds are the same thing from a permissions standpoint: a second `claude -p`
 *  call, running the same `SAVE_STEPS`, with the same ability to reach `translate:save`. Anything
 *  asserted about one has to hold for the other, or the alignment pass becomes an unguarded second
 *  door to an approved translation. */
const KINDS: WorksheetKind[] = ["translation", "alignment"];

/** The argv `fill()` handed to `claude`. */
async function argvFor(kind: WorksheetKind): Promise<string[]> {
  let seen: string[] = [];
  const agent = new ClaudeCodeAgent(async (_cmd, args) => {
    seen = args;
    return { code: 0, stdout: VALID_ENVELOPE, stderr: "" };
  });
  await agent.fill(`${paths.translationsWorksheets}/batch-X.md`, kind);
  return seen;
}

/**
 * The values `claude` would attach to a multi-value flag: everything from just after the flag up
 * to the next one. Reading `--allowedTools`/`--disallowedTools` this way, rather than asking
 * whether some string appears anywhere in argv, is what makes the assertions below able to tell
 * "this rule is in the allow list" from "this rule is in the deny list" — the two lists share the
 * `Bash(...)` syntax and are only distinguishable by position.
 */
function valuesOf(args: string[], flag: string): string[] {
  const start = args.indexOf(flag);
  if (start === -1) return [];
  const values: string[] = [];
  for (let i = start + 1; i < args.length && !args[i].startsWith("--"); i++) values.push(args[i]);
  return values;
}

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

  // Both kinds, not just translation: the alignment pass is a second `claude -p` call running the
  // same SAVE_STEPS against the same `translate:save`, so it is an equal path to an approved
  // translation. A prompt test that only ever called fill(..., "translation") stayed green when
  // buildPrompt was changed to omit APPROVAL_BOUNDARY for `kind === "alignment"`.
  it.each(KINDS)("tells the model plainly, in the %s prompt itself, never to pass --approve", async (kind) => {
    const seen = await argvFor(kind);

    // Located by position, not content: "-p"'s value is always the prompt, unambiguously.
    const promptIndex = seen.indexOf("-p");
    expect(promptIndex).toBeGreaterThanOrEqual(0);
    const prompt = seen[promptIndex + 1];
    // The prohibitive phrasing itself, not just the substring "--approve" — a flipped instruction
    // like "Always pass `--approve`" also contains that substring and must not pass this test.
    expect(prompt).toContain("Never pass `--approve`");
    // The rest of the boundary, so deleting all but the first sentence is caught too: the whole
    // point of this block is that it argues with the `[--approve]` hint the model will see in
    // `translate:prepare`'s own output, rather than just forbidding the flag once.
    expect(prompt).toContain("A human performs 1차 검수");
    // Guard against the two kinds silently collapsing into one prompt: each must still carry its
    // own task text, or "both kinds are covered" would be true only in the trivial sense.
    expect(prompt).toContain(kind === "translation" ? "translation worksheet" : "alignment worksheet");
  });

  // The deny rule is the only control in this file that is not an instruction the model may
  // decide to ignore — a deny beats every allow rule regardless of specificity, and it is what
  // structurally stops an `--approve` appended after `--file <path>`, which the allow rule's own
  // trailing `*` would otherwise match. Deleting it from the argv left the whole suite green.
  it.each(KINDS)("passes a --disallowedTools rule that denies --approve, on the %s pass", async (kind) => {
    const denied = valuesOf(await argvFor(kind), "--disallowedTools");

    // The exact list, not "contains something": a rule that no longer names `--approve` (or one
    // appended after a broader rule that never matches) is the mutation this has to catch, and
    // both are invisible to a containment check on the flag alone.
    expect(denied).toEqual(["Bash(*--approve*)"]);
  });

  // Untested in both directions before this: deleting the Bash rule (after which nothing can ever
  // save, and every tick fails) was green, and widening it to `Bash(*)` — arbitrary shell for an
  // unattended agent attached to the production database — was equally green.
  it.each(KINDS)("allows exactly one shape of Bash command, on the %s pass", async (kind) => {
    const allowed = valuesOf(await argvFor(kind), "--allowedTools");
    const bashRules = allowed.filter((rule) => rule.startsWith("Bash("));

    // Equality on the Bash rules, so both directions fail: removing the rule empties this list,
    // and widening it — `Bash(*)`, `Bash(pnpm *)`, or an extra rule alongside this one — changes
    // it. The command, both flags and the order they must appear in are all pinned, because the
    // rule is what confines the agent to `translate:save`.
    expect(bashRules).toEqual(["Bash(pnpm translate:save --id * --file *)"]);
    // Said once more as a statement about capability rather than about a string, since this is the
    // consequence that matters: no rule here may grant shell beyond that one command.
    expect(allowed.some((rule) => /^Bash\(\*+\)$/.test(rule))).toBe(false);
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

  it("widens the workspace to the worksheets directory with --add-dir", async () => {
    let seen: string[] = [];
    const agent = new ClaudeCodeAgent(async (_cmd, args) => {
      seen = args;
      return { code: 0, stdout: VALID_ENVELOPE, stderr: "" };
    });

    await agent.fill(`${paths.translationsWorksheets}/batch-X.md`, "translation");

    // Required in addition to (not instead of) the Read/Edit rules: once HERALD_OUTPUT_DIR moves
    // the worksheets directory outside the spawned process's cwd (REPO_ROOT), an allow rule alone
    // cannot reach it — --add-dir is the flag that widens the addressable workspace itself. Plain
    // path, no "//" prefix: that rule-syntax quirk doesn't apply to a directory argument.
    const addDirIndex = seen.indexOf("--add-dir");
    expect(addDirIndex).toBeGreaterThanOrEqual(0);
    expect(seen[addDirIndex + 1]).toBe(paths.translationsWorksheets);
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
    // performance.now(), not Date.now(): this machine's wall clock steps by ~31s periodically
    // (see src/storage/sweep.ts's IN_PROGRESS_MS comment) — a step straddling the measurement
    // can produce a spurious ~31s failure or, worse, a spurious PASS via a negative elapsed
    // value. performance.now() is monotonic and immune to wall-clock steps.
    const start = performance.now();
    const result = await agent.fill("w.md", "translation");
    expect(performance.now() - start).toBeLessThan(2000);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.detail).toContain("50ms");
  });
});
