// tests/cli/doctorWiring.test.ts
import { describe, it, expect } from "vitest";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { hashPassword } from "../../src/domain/auth/password";

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

function runDoctor(extraEnv: Record<string, string> = {}): Promise<{ stdout: string; exitCode: number }> {
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
      ...extraEnv,
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

  /**
   * The gap these two close: a setup could pass `doctor` with `0 fail` and still be one where
   * `pnpm serve` refuses to start on its first line. `serve.ts` calls `loadSessionConfig()` and
   * `loadAuthConfig()` before it binds anything, and `.env.example`'s profile table marks all
   * three variables `●` in every profile that runs a dashboard — the same marking `DATABASE_URL`
   * carries — so `doctor` has to grade them the same way it grades that one, as a fail.
   *
   * Each runs `doctor` twice, configured and not: one run alone cannot tell a real read of the
   * environment from a hardcoded line saying whatever this run expects.
   */
  it("fails when the dashboard has no account, and passes once one is configured", async () => {
    const unconfigured = await runDoctor();

    expect(unconfigured.stdout).toContain("Dashboard account");
    expect(unconfigured.stdout).toContain("No dashboard account configured");

    const configured = await runDoctor({
      HERALD_AUTH_USERNAME: "reviewer",
      HERALD_AUTH_PASSWORD_HASH: await hashPassword("correct-horse-battery"),
    });

    expect(configured.stdout).toContain("user: reviewer");
    expect(configured.stdout).not.toContain("No dashboard account configured");
  }, 60000);

  it("fails when the session secret is missing, and passes once one is set", async () => {
    const unconfigured = await runDoctor();

    expect(unconfigured.stdout).toContain("Session secret");
    expect(unconfigured.stdout).toContain("Missing required environment variable: HERALD_SESSION_SECRET");

    const configured = await runDoctor({ HERALD_SESSION_SECRET: "a".repeat(64) });

    expect(configured.stdout).not.toContain("Missing required environment variable: HERALD_SESSION_SECRET");
  }, 60000);

  /**
   * `deployEnvResult` is thoroughly tested as a function (`tests/doctor/deployEnv.test.ts`) and was
   * deletable from `doctor.ts` with that suite green — the same gap this file was written for. The
   * invariant it carries is that a credential rotated here without a deploy is reported at all,
   * and that rests on the wiring.
   *
   * `HERALD_DEPLOY_DIR` names a directory that does not exist, so the check resolves a tree and
   * then finds no `.env` in it — reached without depending on whether the machine running the
   * test has systemd, a deploy checkout, or `herald-watch.service` installed.
   */
  it("always reports whether this checkout's .env matches the one the timers read", async () => {
    const { stdout } = await runDoctor({ HERALD_DEPLOY_DIR: "/tmp/herald-doctor-wiring-no-such-tree" });

    expect(stdout).toContain(".env deploy sync");
  }, 30000);
});
