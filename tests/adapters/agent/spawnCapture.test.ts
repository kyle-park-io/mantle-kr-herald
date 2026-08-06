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

  it(
    "does not leave the child's stdin open — a child waiting for EOF must not hang",
    async () => {
      // Default `child_process.spawn` stdio leaves `child.stdin`'s pipe write end open in THIS
      // process, since nothing here ever writes to or closes it. A child that reads its own stdin
      // to EOF before doing anything else (plausible for `claude -p` off a TTY) would then hang
      // forever waiting for a close that never arrives — exactly the failure class `stdio:
      // ["ignore", ...]` exists to remove. A short, explicit timeout (well under the correct,
      // near-instant real duration) turns a regression here into a fast, clear failure instead of
      // waiting out vitest's full default test timeout.
      // performance.now(), not Date.now(): this machine's wall clock steps by ~31s periodically
      // (see src/storage/sweep.ts's IN_PROGRESS_MS comment) — a step straddling the measurement
      // can produce a spurious ~31s failure or, worse, a spurious PASS via a negative elapsed
      // value. performance.now() is monotonic and immune to wall-clock steps.
      const start = performance.now();
      const result = await spawnCapture("node", [
        "-e",
        "process.stdin.on('end', () => { console.log('eof'); process.exit(0); }); process.stdin.resume();",
      ]);
      expect(result.stdout.trim()).toBe("eof");
      expect(performance.now() - start).toBeLessThan(2000);
    },
    3000,
  );

  it("does not corrupt a multi-byte UTF-8 character split across a chunk boundary", async () => {
    // `—` and `→` are exactly the multi-byte characters WatchTick's own stdout parsers key off
    // (see src/app/WatchTick.ts), so this isn't a hypothetical. Force two separate writes with a
    // real delay between them (reliably two separate `data` events on the reading side) split
    // strictly inside the first multi-byte character's byte sequence.
    const text = "번역 — 완료 → 검수";
    const splitAt = 1; // one byte into "번" (a 3-byte UTF-8 character) — inside, not on, a boundary
    const script = [
      `const fullBuf = Buffer.from(${JSON.stringify(text)}, "utf8");`,
      `process.stdout.write(fullBuf.subarray(0, ${splitAt}));`,
      `setTimeout(() => process.stdout.write(fullBuf.subarray(${splitAt})), 50);`,
    ].join("\n");

    const result = await spawnCapture("node", ["-e", script]);
    expect(result.stdout).toBe(text);
  });
});
