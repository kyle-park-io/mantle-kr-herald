import { spawn } from "node:child_process";
import { REPO_ROOT } from "../../paths";

export type SpawnCaptureResult = { code: number; stdout: string; stderr: string };

/**
 * The one place a real OS process gets spawned for this feature. Both `runStage.ts` (the `pnpm
 * <script>` stages) and `src/cli/watch.ts`'s wiring of `ClaudeCodeAgent` (the `claude -p`
 * subprocess) go through this, so the two rules below live in exactly one place instead of two
 * copies that could quietly drift apart.
 *
 * 1. **Argv array, never a shell.** `child_process.spawn` is called without `shell: true` and
 *    without joining `args` into a command string. `ClaudeCodeAgent`'s permission-rule arguments
 *    contain unquoted `*` (e.g. `Bash(pnpm translate:save --id * --file *)`) that a shell would
 *    glob-expand against this process's cwd before `claude` ever saw them, silently corrupting the
 *    permission rules it was told to enforce.
 * 2. **`signal`, when given, is handed straight to `spawn`'s own `signal` option.** Confirmed
 *    experimentally (not just from docs — see task-4-report.md) that this actually SIGTERMs the
 *    child the moment the `AbortController` backing it fires, not merely stops this function from
 *    waiting on it. Without this, `ClaudeCodeAgent`'s 10-minute timeout is decorative: `fill()`
 *    itself still returns on schedule (it races an independent timer), but a wedged `claude`
 *    process keeps running in the background, and systemd sees the unit as still active and skips
 *    every later scheduled fire — a silently dead scheduler.
 *
 * `cwd` is always the repo root, never inherited from the caller: `pnpm translate:save` (the one
 * Bash command `claude` is allowed to run) needs it to resolve the script, and a systemd unit's own
 * `WorkingDirectory=` should not be the only thing standing between this and a wrong cwd.
 *
 * `stdio` fixes the child's stdin to `"ignore"` rather than the default `"pipe"`. With the
 * default, this function never writes to or closes `child.stdin`, so the pipe's write end stays
 * open in this process indefinitely — a child that reads stdin to EOF before doing anything else
 * (plausible for `claude -p` when it isn't attached to a TTY) would hang forever waiting for a
 * close that never comes, until the outer `ClaudeCodeAgent` timeout eventually fires. `"ignore"`
 * gives the child immediate EOF instead, removing that failure class rather than relying on the
 * timeout to paper over it on every single call.
 *
 * stdout/stderr are decoded with `setEncoding("utf8")` rather than concatenating raw `Buffer`
 * chunks: a chunk boundary can land inside a multi-byte UTF-8 character (this repo's own stage
 * output is full of them — `—`, `→`, `·` — so this isn't a hypothetical), and decoding each chunk
 * independently corrupts the character at that boundary. `setEncoding` uses Node's `StringDecoder`
 * internally, which buffers a split sequence across chunks instead. `src/cli/deploy-check.ts` hits
 * the same class of problem with `spawnSync`'s `encoding: "utf8"` option; this is the streaming
 * equivalent.
 */
export function spawnCapture(
  cmd: string,
  args: string[],
  opts: { signal?: AbortSignal } = {},
): Promise<SpawnCaptureResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { cwd: REPO_ROOT, signal: opts.signal, stdio: ["ignore", "pipe", "pipe"] });

    let stdout = "";
    let stderr = "";
    child.stdout?.setEncoding("utf8");
    child.stderr?.setEncoding("utf8");
    child.stdout?.on("data", (chunk: string) => {
      stdout += chunk;
    });
    child.stderr?.on("data", (chunk: string) => {
      stderr += chunk;
    });

    child.on("error", reject);
    child.on("close", (code) => {
      resolve({ code: code ?? 1, stdout, stderr });
    });
  });
}
