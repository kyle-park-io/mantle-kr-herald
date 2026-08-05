// tests/cli/doctorWiring.test.ts
import { describe, it, expect } from "vitest";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const TSX_BIN = join(REPO_ROOT, "node_modules", ".bin", "tsx");
const DOCTOR_ENTRY = join(REPO_ROOT, "src", "cli", "doctor.ts");

/**
 * `outputRootResult` and `telegramOpsChatResult` are thoroughly tested as functions
 * (`tests/doctor/checks.test.ts`), and both were still deletable from `doctor.ts` with the whole
 * suite green: nothing anywhere asserted that `doctor` actually *runs* them. The invariant they
 * carry — `src/paths.ts`'s "a non-default root is never silent", and "the watch scheduler's
 * failure hook never sends silently for want of a chat id" — rests entirely on that wiring, not
 * on the functions.
 *
 * `doctor.ts` is a top-level script whose checks run as import-time side effects, so the only way
 * to observe the wiring is to run it, the way `tests/cli/serveStartupOrder.test.ts` runs
 * `serve.ts`. Deliberately not through `pnpm doctor` (`tsx --env-file-if-exists=.env …`): that
 * would load the real `.env` — Kyle's own credentials — into this process and make what the
 * report says depend on his machine. `tsx` is invoked directly with an explicit, minimal
 * environment instead.
 *
 * `DATABASE_URL` points at 127.0.0.1:1, where nothing listens, so the one non-optional network
 * check fails near-instantly with `ECONNREFUSED` rather than hanging. The report still prints
 * every check; `doctor` exiting non-zero over that failure is expected and not what is asserted.
 */
const OUTPUT_ROOT = "/tmp/herald-doctor-wiring-test-output";

function runDoctor(): Promise<{ stdout: string; exitCode: number }> {
  const child = spawn(TSX_BIN, [DOCTOR_ENTRY], {
    cwd: REPO_ROOT,
    env: {
      PATH: process.env.PATH ?? "",
      DATABASE_URL: "postgres://user:pass@127.0.0.1:1/nonexistent",
      HERALD_DB_ENV: "development",
      HERALD_STORAGE_MODE: "local",
      HERALD_OUTPUT_DIR: OUTPUT_ROOT,
      TELEGRAM_BOT_TOKEN: "test-token",
      TELEGRAM_CHAT_ID_OPS: "-1001234567890",
    },
  });

  let stdout = "";
  child.stdout.on("data", (chunk: Buffer) => {
    stdout += chunk.toString();
  });
  child.stderr.resume(); // drain, unused

  return new Promise((resolve, reject) => {
    child.on("error", reject);
    child.on("exit", (code) => resolve({ stdout, exitCode: code ?? -1 }));
  });
}

describe("pnpm doctor's report", () => {
  it("always names the output root in effect, and names it from the environment", async () => {
    const { stdout } = await runDoctor();

    // Both halves matter: the check has to be in the report at all, and the value has to come
    // from this process's own HERALD_OUTPUT_DIR rather than from a canned line — the whole point
    // is that an override is never silent.
    expect(stdout).toContain("Output root");
    expect(stdout).toContain(`${OUTPUT_ROOT} (HERALD_OUTPUT_DIR override)`);
  }, 30000);

  it("always reports whether the watch scheduler's failure hook can reach Telegram", async () => {
    const { stdout } = await runDoctor();

    expect(stdout).toContain("Telegram ops chat (watch failures)");
    // Reads the two variables this run actually set — a hardcoded warn line would say the
    // opposite here, and a hardcoded ok line would be wrong on every machine that hasn't set
    // them.
    expect(stdout).toContain("configured — deploy/herald-notify-failure.sh will post here");
  }, 30000);
});
