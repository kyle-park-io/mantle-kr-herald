import { describe, it, expect, afterEach } from "vitest";
import { existsSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { spawnCapture } from "../../../src/adapters/agent/spawnCapture";
import { REPO_ROOT } from "../../../src/paths";

const markers: string[] = [];

afterEach(() => {
  while (markers.length > 0) {
    const marker = markers.pop();
    if (marker && existsSync(marker)) rmSync(marker, { force: true });
  }
});

describe("spawnCapture", () => {
  it("always spawns with the repo root as cwd, never the caller's own cwd", async () => {
    const originalCwd = process.cwd();
    process.chdir(tmpdir());
    try {
      const result = await spawnCapture("node", ["-e", "process.stdout.write(process.cwd())"]);
      expect(result.stdout).toBe(REPO_ROOT);
    } finally {
      process.chdir(originalCwd);
    }
  });

  it("does not use a shell — args survive as literal argv, not glob-expanded or split on spaces", async () => {
    // `node -e <script> <extra args...>` puts the extra args at process.argv[1..], not [2..] —
    // there is no "[eval]" placeholder the way there is for a real script file.
    const result = await spawnCapture("node", [
      "-e",
      "process.stdout.write(JSON.stringify(process.argv.slice(1)))",
      "*",
      "a b c",
    ]);
    // A shell (shell: true, or a joined command string) would glob-expand the unquoted "*" against
    // this process's cwd — the exact corruption `ClaudeCodeAgent`'s permission-rule args are at risk
    // of — and/or split "a b c" on its spaces into three argv entries.
    expect(JSON.parse(result.stdout)).toEqual(["*", "a b c"]);
  });

  it("resolves with the real exit code, stdout and stderr on a normal run", async () => {
    const result = await spawnCapture("node", ["-e", "console.log('hi'); console.error('bye'); process.exit(3)"]);
    expect(result.code).toBe(3);
    expect(result.stdout.trim()).toBe("hi");
    expect(result.stderr.trim()).toBe("bye");
  });

  it("actually kills the child process when the signal aborts, not just this function's own wait", async () => {
    const marker = join(tmpdir(), `spawn-capture-kill-test-${Date.now()}-${Math.random()}.txt`);
    markers.push(marker);
    const controller = new AbortController();

    // The child writes `marker` 400ms after starting, UNLESS it is killed first. If the abort
    // signal only stopped this function from waiting (rather than actually terminating the OS
    // process), the child would run to completion in the background and the marker would still
    // appear.
    const promise = spawnCapture(
      "node",
      ["-e", `setTimeout(() => require("fs").writeFileSync(${JSON.stringify(marker)}, "done"), 400)`],
      { signal: controller.signal },
    );
    setTimeout(() => controller.abort(), 50);

    await promise.catch(() => {
      // Rejecting on abort is fine — this test only cares whether the OS process actually died.
    });

    await new Promise((resolve) => setTimeout(resolve, 650));
    expect(existsSync(marker)).toBe(false);
  });
});
