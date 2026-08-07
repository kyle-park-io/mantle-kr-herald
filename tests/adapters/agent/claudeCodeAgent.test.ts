import { describe, it, expect } from "vitest";
import { ClaudeCodeAgent } from "../../../src/adapters/agent/ClaudeCodeAgent";
import type { WorksheetKind } from "../../../src/ports/WorksheetAgent";
import { ALL_TYPES, typeLabel } from "../../../src/domain/conversion/models";
import { paths } from "../../../src/paths";

const ok = (stdout: string) => async () => ({ code: 0, stdout, stderr: "" });

const VALID_ENVELOPE = JSON.stringify({ is_error: false, permission_denials: [], result: "ok" });

/** Every worksheet kind, because every one of them is a `claude -p` call running unattended against
 *  the production database with a save command in reach. Anything asserted about one has to hold for
 *  all of them, or the newest kind becomes the unguarded door: a prompt test that only ever called
 *  fill(..., "translation") stayed green when buildPrompt was changed to omit APPROVAL_BOUNDARY for
 *  `kind === "alignment"`. */
const KINDS: WorksheetKind[] = ["translation", "alignment", "conversion"];

/** Which directory each kind's worksheets live in, and therefore the only one it may address. */
const WORKSHEETS_DIR: Record<WorksheetKind, string> = {
  translation: paths.translationsWorksheets,
  alignment: paths.translationsWorksheets,
  conversion: paths.variantsWorksheets,
};

/** The one `Bash(...)` rule each kind is given. `translate:save` and `convert:save` take different
 *  flags, and a conversion pass handed the translation rule cannot save anything at all. */
const SAVE_RULE: Record<WorksheetKind, string> = {
  translation: "Bash(pnpm translate:save --id * --file *)",
  alignment: "Bash(pnpm translate:save --id * --file *)",
  conversion: "Bash(pnpm convert:save --id * --type * --file *)",
};

/** The phrase naming the human gate each kind must not step over: a draft translation waits for
 *  1차 검수, a converted variant is already past that and waits for 2차 검수. */
const REVIEW_GATE: Record<WorksheetKind, string> = {
  translation: "A human performs 1차 검수",
  alignment: "A human performs 1차 검수",
  conversion: "2차 검수 (second-pass review)",
};

/** Each kind's own task text, so "all kinds are covered" can never be true in the trivial sense of
 *  three kinds sharing one prompt. */
const TASK_MARKER: Record<WorksheetKind, string> = {
  translation: "translation worksheet",
  alignment: "alignment worksheet",
  conversion: "conversion worksheet",
};

/** The argv `fill()` handed to `claude`. */
async function argvFor(kind: WorksheetKind): Promise<string[]> {
  let seen: string[] = [];
  const agent = new ClaudeCodeAgent(async (_cmd, args) => {
    seen = args;
    return { code: 0, stdout: VALID_ENVELOPE, stderr: "" };
  });
  await agent.fill(`${WORKSHEETS_DIR[kind]}/batch-X.md`, kind);
  return seen;
}

/** The prompt `fill()` built, located by position: "-p"'s value is always the prompt. */
function promptOf(args: string[]): string {
  const at = args.indexOf("-p");
  expect(at).toBeGreaterThanOrEqual(0);
  return args[at + 1];
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

  it.each(KINDS)("tells the model plainly, in the %s prompt itself, never to pass --approve", async (kind) => {
    const prompt = promptOf(await argvFor(kind));

    // The prohibitive phrasing itself, not just the substring "--approve" — a flipped instruction
    // like "Always pass `--approve`" also contains that substring and must not pass this test.
    expect(prompt).toContain("Never pass `--approve`");
    // The rest of the boundary, so deleting all but the first sentence is caught too: the whole
    // point of that block is that it argues with the `[--approve]` hint the model will see in a
    // prepare stage's own output, rather than just forbidding the flag once. Which human gate it
    // names differs per kind — a draft translation waits for 1차 검수, a variant for 2차 검수 — so
    // asserting one phrase for all three would only prove they share a prompt.
    expect(prompt).toContain(REVIEW_GATE[kind]);
    // Guard against the kinds silently collapsing into one prompt.
    expect(prompt).toContain(TASK_MARKER[kind]);
  });

  // The deny rules are the only controls in this file that are not instructions the model may
  // decide to ignore — a deny beats every allow rule regardless of specificity, and they are what
  // structurally stops an `--approve`, or a second command behind a `;`, appended after
  // `--file <path>`, which the allow rule's own trailing `*` would otherwise match. Deleting the
  // list from the argv left the whole suite green.
  it.each(KINDS)("denies --approve and every send/publish command, on the %s pass", async (kind) => {
    const denied = valuesOf(await argvFor(kind), "--disallowedTools");

    // The exact list, not "contains something": a rule that no longer names `--approve` (or one
    // appended after a broader rule that never matches) is the mutation this has to catch, and both
    // are invisible to a containment check on the flag alone. The three `pnpm` entries are every way
    // this repo has of putting text in front of an audience; no worksheet pass may reach any of
    // them, and the conversion pass in particular exists to stop at `converted` and wait for 2차 검수.
    expect(denied).toEqual([
      "Bash(*--approve*)",
      "Bash(*pnpm send:*)",
      "Bash(*pnpm lark:send*)",
      "Bash(*pnpm drive:publish*)",
    ]);
  });

  // Untested in both directions before this: deleting the Bash rule (after which nothing can ever
  // save, and every tick fails) was green, and widening it to `Bash(*)` — arbitrary shell for an
  // unattended agent attached to the production database — was equally green.
  it.each(KINDS)("allows exactly one shape of Bash command, on the %s pass", async (kind) => {
    const allowed = valuesOf(await argvFor(kind), "--allowedTools");
    const bashRules = allowed.filter((rule) => rule.startsWith("Bash("));

    // Equality on the Bash rules, so both directions fail: removing the rule empties this list,
    // and widening it — `Bash(*)`, `Bash(pnpm *)`, or an extra rule alongside this one — changes
    // it. The command, every flag and the order they must appear in are all pinned, because the
    // rule is what confines the agent to that one save command.
    expect(bashRules).toEqual([SAVE_RULE[kind]]);
    // Said once more as a statement about capability rather than about a string, since this is the
    // consequence that matters: no rule here may grant shell beyond that one command.
    expect(allowed.some((rule) => /^Bash\(\*+\)$/.test(rule))).toBe(false);
  });

  it.each(KINDS)("scopes the %s pass's Read/Edit rules to its own absolute worksheets directory", async (kind) => {
    const seen = await argvFor(kind);
    const dir = WORKSHEETS_DIR[kind];

    // paths.* are themselves absolute (built from OUTPUT_DIR), so the rule needs one extra leading
    // "/" per Claude Code's "//path" absolute-path syntax.
    expect(seen).toContain(`Read(/${dir}/**)`);
    expect(seen).toContain(`Edit(/${dir}/**)`);
  });

  it.each(KINDS)("widens the workspace to the %s pass's worksheets directory with --add-dir", async (kind) => {
    const seen = await argvFor(kind);

    // Required in addition to (not instead of) the Read/Edit rules: once HERALD_OUTPUT_DIR moves
    // the worksheets directory outside the spawned process's cwd (REPO_ROOT), an allow rule alone
    // cannot reach it — --add-dir is the flag that widens the addressable workspace itself. Plain
    // path, no "//" prefix: that rule-syntax quirk doesn't apply to a directory argument.
    const addDirIndex = seen.indexOf("--add-dir");
    expect(addDirIndex).toBeGreaterThanOrEqual(0);
    expect(seen[addDirIndex + 1]).toBe(WORKSHEETS_DIR[kind]);
  });

  it("gives the conversion pass no reach into the translation worksheets, and vice versa", async () => {
    // The two directories hold different stages' work under different review gates. A conversion
    // pass that could edit `output/translations/worksheets/` would be able to rewrite a draft a
    // human is about to review in 1차 검수, and a translation pass that could reach
    // `output/variants/` could rewrite a variant already approved in 2차 검수. Nothing enforced this
    // while both kinds shared one module-level constant.
    const conversion = (await argvFor("conversion")).join(" ");
    const translation = (await argvFor("translation")).join(" ");

    expect(conversion).not.toContain(paths.translationsWorksheets);
    expect(translation).not.toContain(paths.variantsWorksheets);
  });

  it("tells the conversion pass how the worksheet's Korean type labels map to --type", async () => {
    // The one thing an unattended pass cannot infer: the worksheet says `## 유형: 공지`, and
    // `convert:save --type` takes `announcement`. Getting it wrong is not a soft failure —
    // `convert:save` refuses an unknown --type outright, so the whole batch fails and the tick
    // reports an agent that saved nothing. Asserted through `typeLabel`/`ALL_TYPES` rather than
    // against a hand-written list, so a type added or relabelled later fails here instead of
    // leaving the prompt describing a set that no longer exists.
    const prompt = promptOf(await argvFor("conversion"));

    for (const type of ALL_TYPES) {
      expect(prompt, type).toContain(`${typeLabel(type)} → ${type}`);
    }
  });

  it("tells the conversion pass to save every (item, type) pair, not one file per item", async () => {
    // A variant's identity is (itemId, type), so one item across four sections is four saves into
    // four scratch files. A pass that reused one filename per item would silently overwrite each
    // section's text with the next one's and save the same copy under four different types.
    const prompt = promptOf(await argvFor("conversion"));

    expect(prompt).toContain("x-123.announcement.ko.txt");
    expect(prompt).toContain("--type <type>");
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
