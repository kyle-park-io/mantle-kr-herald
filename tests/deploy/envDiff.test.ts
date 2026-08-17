import { describe, it, expect } from "vitest";
import { compareEnvNames, SHARED_WITH_DEPLOYMENT } from "../../src/deploy/envDiff";
import { MUST_BE_SET } from "../../src/deploy/requirements";

/**
 * What this compares, and what it deliberately does not.
 *
 * Not values. Vercel returns every variable it stored as sensitive — which is most of the
 * credentials — as the literal string `[SENSITIVE]`, so a value comparison would silently pass on
 * the twenty that matter. And the values that *can* be read are the ones the two sides are supposed
 * to disagree about: the operator machine runs `local` storage against a development database with
 * its own dashboard account, the deployment runs `cloud` against production with the team's. A
 * check that reported those as drift would be wrong on every run until someone switched it off.
 *
 * So: names, and only across the set both sides are supposed to hold. This is the shape of the one
 * failure that actually happened — `TWITTERAPI_IO_KEY` sat in the repo's `.env` and not in Vercel,
 * `deploy:check` had no opinion on it because it is in neither `MUST_BE_SET` nor `MUST_BE_ABSENT`,
 * and the only symptom was 링크 수집 quietly staying shut on the deployed board.
 */
describe("compareEnvNames", () => {
  const shared = ["GOOGLE_OAUTH_CLIENT_ID", "TELEGRAM_BOT_TOKEN"] as const;

  it("reports ok when both sides hold a shared credential", () => {
    const results = compareEnvNames({
      local: ["GOOGLE_OAUTH_CLIENT_ID", "TELEGRAM_BOT_TOKEN"],
      remote: ["GOOGLE_OAUTH_CLIENT_ID", "TELEGRAM_BOT_TOKEN"],
      shared,
    });

    expect(results.every((r) => r.status === "ok")).toBe(true);
  });

  it("warns about a credential this machine has and the deployment does not", () => {
    const results = compareEnvNames({
      local: ["GOOGLE_OAUTH_CLIENT_ID", "TELEGRAM_BOT_TOKEN"],
      remote: ["GOOGLE_OAUTH_CLIENT_ID"],
      shared,
    });

    const telegram = results.find((r) => r.name === "TELEGRAM_BOT_TOKEN");
    expect(telegram?.status).toBe("warn");
    expect(telegram?.detail).toContain("Vercel");
  });

  it("warns about a credential the deployment has and this machine does not", () => {
    const results = compareEnvNames({
      local: ["GOOGLE_OAUTH_CLIENT_ID"],
      remote: ["GOOGLE_OAUTH_CLIENT_ID", "TELEGRAM_BOT_TOKEN"],
      shared,
    });

    const telegram = results.find((r) => r.name === "TELEGRAM_BOT_TOKEN");
    expect(telegram?.status).toBe("warn");
    expect(telegram?.detail).toContain(".env");
  });

  it("says so once rather than twice when neither side has it", () => {
    const results = compareEnvNames({ local: [], remote: [], shared });

    const telegram = results.filter((r) => r.name === "TELEGRAM_BOT_TOKEN");
    expect(telegram).toHaveLength(1);
    expect(telegram[0].status).toBe("warn");
  });

  /**
   * The same restraint `checkEnvNames` documents: a name in neither list produces no result. Here
   * that covers both the operator-only values the deployment has no reader for
   * (`TELEGRAM_CHAT_ID_OPS`, `LARK_CHAT_IDS`) and the sixteen Neon injects into Vercel
   * (`PGHOST`, `POSTGRES_URL`, …). Reporting either as drift would bury the real findings.
   */
  it("has no opinion about names outside the shared set", () => {
    const results = compareEnvNames({
      local: ["TELEGRAM_CHAT_ID_OPS", "GOOGLE_OAUTH_CLIENT_ID", "TELEGRAM_BOT_TOKEN"],
      remote: ["PGHOST", "POSTGRES_URL", "GOOGLE_OAUTH_CLIENT_ID", "TELEGRAM_BOT_TOKEN"],
      shared,
    });

    expect(results.map((r) => r.name).sort()).toEqual(["GOOGLE_OAUTH_CLIENT_ID", "TELEGRAM_BOT_TOKEN"]);
  });
});

describe("SHARED_WITH_DEPLOYMENT", () => {
  /**
   * The list is hand-written rather than derived, so this pins it against the one it must not drift
   * from. Everything shared is something the deployment expects — except `TWITTERAPI_IO_KEY`, which
   * is deliberately absent from `MUST_BE_SET`: 링크 수집 is an opt-in capability
   * (`HERALD_INTAKE_ENABLED`), and a review-only deployment that never opens it is a legitimate
   * install, not one `deploy:check` should nag about forever. It still belongs here, because when
   * both sides are meant to collect, a machine holding the key while Vercel does not is exactly the
   * drift this command exists to surface.
   */
  it("names only credentials the deployment expects, plus the intake key", () => {
    const expected = new Set(MUST_BE_SET.map((e) => e.name));
    const extra = SHARED_WITH_DEPLOYMENT.filter((name) => !expected.has(name));

    expect(extra).toEqual(["TWITTERAPI_IO_KEY"]);
  });

  /**
   * The deployment-only half of `MUST_BE_SET` must never leak in: those are the values the two
   * sides are supposed to disagree about, and listing one here would report the correct setup as
   * broken on every run.
   */
  it("excludes everything the deployment alone owns", () => {
    const deploymentOnly = [
      "DATABASE_URL",
      "HERALD_DB_ENV",
      "HERALD_STORAGE_MODE",
      "HERALD_AUTH_USERNAME",
      "HERALD_AUTH_PASSWORD_HASH",
      "HERALD_SESSION_SECRET",
      "HERALD_TRUST_PROXY",
      "HERALD_DEPLOYMENT_ORIGIN",
    ];

    expect(SHARED_WITH_DEPLOYMENT.filter((n) => deploymentOnly.includes(n))).toEqual([]);
  });
});
