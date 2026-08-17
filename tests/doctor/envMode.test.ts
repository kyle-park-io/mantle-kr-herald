import { describe, it, expect } from "vitest";
import { envModeResult, ENV_MODE_CHECK } from "../../src/doctor/checks";

/**
 * `src/cli/deploy-freeze.ts` already states this repo's position in code: `modeFor` writes the
 * frozen `.env` and everything under `keys/` at `0o600`, "a glossary is a team document" and these
 * are not. The deploy tree therefore gets it right no matter what — the gap was the development
 * checkout, where `.env` is born of `cp .env.example .env` and inherits a tracked file's `644`.
 * Nothing set it, nothing documented it, and nothing looked.
 *
 * Warn, never fail. The exposure is to other local users of the same machine, which on a
 * single-account laptop is nobody; a `fail` would stop a `doctor && …` chain over something that
 * has never broken a pipeline run. It is still worth a line, because the file holds every
 * credential the operator machine has and one `chmod` closes it.
 */
describe("envModeResult", () => {
  it("passes a file only its owner can read", () => {
    const result = envModeResult(0o600);

    expect(result.name).toBe(ENV_MODE_CHECK);
    expect(result.status).toBe("ok");
  });

  it("passes a stricter mode too", () => {
    expect(envModeResult(0o400).status).toBe("ok");
  });

  it.each([
    ["group-readable", 0o640],
    ["world-readable", 0o604],
    ["the mode cp .env.example .env produces", 0o644],
  ])("warns about a %s .env, and names the remedy", (_label, mode) => {
    const result = envModeResult(mode);

    expect(result.status).toBe("warn");
    expect(result.detail).toContain("chmod 600 .env");
  });

  it("prints the offending mode in octal, the way an operator would type it", () => {
    expect(envModeResult(0o644).detail).toContain("644");
  });

  /**
   * `--env-file-if-exists` is the whole point of that flag: a checkout with no `.env` is a valid
   * state (every value can come from the environment instead), and doctor's other lines already
   * report what is actually missing because of it.
   */
  it("says nothing when there is no .env to grade", () => {
    expect(envModeResult(undefined).status).toBe("ok");
  });
});
