// tests/cli/claudeSpawnKill.test.ts
import { describe, it, expect, afterEach } from "vitest";
import { spawn } from "node:child_process";
import { writeFileSync, chmodSync, mkdtempSync, existsSync, rmSync } from "node:fs";
import { join, dirname } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const TSX_BIN = join(REPO_ROOT, "node_modules", ".bin", "tsx");
const HARNESS_ENTRY = join(REPO_ROOT, "tests", "cli", "fixtures", "claudeSpawnHarness.ts");

/**
 * Closes the gap `tests/adapters/agent/spawnCapture.test.ts` cannot: that file proves
 * `spawnCapture` itself honours an `AbortSignal`, but nothing proved that `src/cli/claudeSpawn.ts`
 * (the exact wiring `watch.ts` hands to `ClaudeCodeAgent`) actually forwards one through. A prior
 * review round mutated that line to `(cmd, args) => spawnCapture(cmd, args)` — dropping the
 * signal — and the full suite, including spawnCapture's own tests, stayed green, because nothing
 * exercised `realClaudeSpawn` itself.
 *
 * Deliberately does not go through `pnpm watch` or the full `WatchTick` pipeline: reaching the
 * agent call for real needs `collect`/`translate:prepare` to report actual new work, which needs a
 * real, reachable database — not appropriate for a unit test, and explicitly off limits for this
 * fix round. Instead this spawns `tests/cli/fixtures/claudeSpawnHarness.ts` directly via `tsx`
 * (the same "no `pnpm`, controlled env" shape as `tests/cli/serveStartupOrder.test.ts`), which
 * constructs a real `ClaudeCodeAgent` from the real, imported `realClaudeSpawn` and calls
 * `fill()` with a tiny timeout — exercising the production wiring itself, not a reimplementation
 * of it.
 *
 * The stub `claude` on `PATH` is a single Node process (shebang `#!/usr/bin/env node`), not a
 * shell script wrapping `sleep`+`touch`: an earlier draft of this test used a shell script, and it
 * reliably took ~2s to return even when the child WAS correctly killed — a shell's forked `sleep`
 * grandchild can outlive a killed parent shell while still holding the inherited stdio pipe open,
 * which stalls the parent's stream-close/exit machinery for unrelated reasons. A plain Node
 * process has no such fork, and terminates immediately on the default-disposition SIGTERM a
 * correct kill sends — confirmed manually: ~0.3s wall time when the wiring is correct.
 */
describe("realClaudeSpawn (src/cli/claudeSpawn.ts)", () => {
  let stubDir: string | undefined;

  afterEach(() => {
    if (stubDir && existsSync(stubDir)) rmSync(stubDir, { recursive: true, force: true });
    stubDir = undefined;
  });

  it("kills the stub claude process when ClaudeCodeAgent's timeout fires", async () => {
    stubDir = mkdtempSync(join(tmpdir(), "claude-stub-"));
    const marker = join(stubDir, "survived.marker");
    const stubPath = join(stubDir, "claude");
    writeFileSync(
      stubPath,
      [
        "#!/usr/bin/env node",
        "const fs = require('fs');",
        "setTimeout(() => fs.writeFileSync(process.env.CLAUDE_STUB_MARKER, 'done'), 2000);",
        "",
      ].join("\n"),
    );
    chmodSync(stubPath, 0o755);

    const child = spawn(TSX_BIN, [HARNESS_ENTRY, "150"], {
      cwd: REPO_ROOT,
      env: {
        PATH: `${stubDir}${process.platform === "win32" ? ";" : ":"}${process.env.PATH ?? ""}`,
        CLAUDE_STUB_MARKER: marker,
      },
    });

    let stdout = "";
    child.stdout.on("data", (chunk: Buffer) => {
      stdout += chunk;
    });
    child.stderr.resume();

    // Monotonic, deliberately not `Date.now()`: this machine's wall clock steps by roughly 31s
    // periodically (`dmesg` shows repeated `systemd-journald: Time jumped backwards, rotating.`,
    // independent of load — the same clock-step hazard `src/storage/sweep.ts`'s `IN_PROGRESS_MS`
    // comment documents for mtime-based checks). `Date.now() - start` straddling a step either
    // produces a spurious ~31s "failure" or, worse, a spurious PASS when the step lands as a
    // backward jump and the subtraction goes negative — trivially satisfying `toBeLessThan(1500)`
    // while proving nothing about whether the kill actually happened fast. `performance.now()` is
    // immune to wall-clock steps, matching the convention already used for a timing assertion in
    // `tests/domain/auth/credentials.test.ts`. Do not "simplify" this back to `Date.now()`.
    const start = performance.now();
    const exitCode = await new Promise<number>((resolve, reject) => {
      child.on("error", reject);
      child.on("exit", (code) => resolve(code ?? -1));
    });
    const elapsed = performance.now() - start;

    expect(exitCode).toBe(0);
    // The stub sleeps 2000ms before writing its marker; if `realClaudeSpawn` genuinely killed it
    // around the 150ms timeout, the harness returns in well under a second. Correct behavior
    // measured manually at ~0.3s — 1500ms leaves ample margin without being able to pass by
    // accident if the wiring silently fell back to waiting out the full 2000ms sleep.
    expect(elapsed).toBeLessThan(1500);

    const result = JSON.parse(stdout);
    expect(result.ok).toBe(false);
    expect(result.detail).toContain("150ms");

    // The decisive, OS-level check: if `realClaudeSpawn` dropped the signal, the stub keeps
    // running in the background regardless of what the harness process itself reported, and
    // writes its marker ~2s after starting.
    await new Promise((resolve) => setTimeout(resolve, 2200));
    expect(existsSync(marker)).toBe(false);
  }, 20000);
});
