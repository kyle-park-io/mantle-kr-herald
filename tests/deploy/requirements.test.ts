import { describe, it, expect } from "vitest";
import { checkEnvNames, MUST_BE_SET, MUST_BE_ABSENT } from "../../src/deploy/requirements";

/** Every name the hosted deployment refuses to start without, plus DATABASE_URL from Neon. */
const COMPLETE = [
  "DATABASE_URL", "HERALD_DB_ENV", "HERALD_STORAGE_MODE",
  "HERALD_AUTH_USERNAME", "HERALD_AUTH_PASSWORD_HASH", "HERALD_SESSION_SECRET",
  "HERALD_TRUST_PROXY", "HERALD_DEPLOYMENT_ORIGIN",
  "GOOGLE_AUTH_MODE", "GOOGLE_OAUTH_CLIENT_ID", "GOOGLE_OAUTH_CLIENT_SECRET",
  "GOOGLE_OAUTH_REFRESH_TOKEN", "GDRIVE_REVIEW_FOLDER_ID", "GDRIVE_APPROVED_FOLDER_ID",
  "GDRIVE_SENT_FOLDER_ID", "LARK_APP_ID", "LARK_APP_SECRET", "LARK_WORKSPACE_URL",
  "LARK_DRIVE_REVIEW_FOLDER_TOKEN", "LARK_DRIVE_APPROVED_FOLDER_TOKEN",
  "LARK_DRIVE_SENT_FOLDER_TOKEN", "TELEGRAM_BOT_TOKEN", "TELEGRAM_CHAT_ID_COMMUNITY",
  "TELEGRAM_CHAT_ID_DEV", "TYPEFULLY_API_KEY", "TYPEFULLY_SOCIAL_SET_ID",
  "X_PREMIUM", "GSHEET_ID", "GSHEET_QA_ID",
];

const statusOf = (results: ReturnType<typeof checkEnvNames>, needle: string) =>
  results.find((r) => r.name.includes(needle))?.status;

describe("checkEnvNames", () => {
  it("passes a complete production environment", () => {
    const results = checkEnvNames(COMPLETE);
    expect(results.filter((r) => r.status === "fail")).toEqual([]);
    expect(results.filter((r) => r.status === "warn")).toEqual([]);
  });

  // The eight that make the function refuse to start. Each is a fail, not a warning.
  it.each([
    "DATABASE_URL", "HERALD_DB_ENV", "HERALD_STORAGE_MODE", "HERALD_AUTH_USERNAME",
    "HERALD_AUTH_PASSWORD_HASH", "HERALD_SESSION_SECRET", "HERALD_TRUST_PROXY",
    "HERALD_DEPLOYMENT_ORIGIN",
  ])("fails when %s is missing", (name) => {
    const results = checkEnvNames(COMPLETE.filter((n) => n !== name));
    expect(statusOf(results, name)).toBe("fail");
  });

  // The ones that degrade in silence — a Telegram-only install is legitimate, so these warn.
  it.each(["GOOGLE_OAUTH_REFRESH_TOKEN", "GDRIVE_REVIEW_FOLDER_ID", "X_PREMIUM", "LARK_APP_ID"])(
    "warns rather than fails when %s is missing",
    (name) => {
      const results = checkEnvNames(COMPLETE.filter((n) => n !== name));
      expect(statusOf(results, name)).toBe("warn");
    },
  );

  it("names what stops working, not just that something is missing", () => {
    const results = checkEnvNames(COMPLETE.filter((n) => n !== "X_PREMIUM"));
    expect(results.find((r) => r.name.includes("X_PREMIUM"))?.detail).toMatch(/280/);
  });

  // A local path; the function has no such file. Present is a mistake, not a preference.
  it("fails when GOOGLE_SA_KEY_FILE is present", () => {
    expect(statusOf(checkEnvNames([...COMPLETE, "GOOGLE_SA_KEY_FILE"]), "GOOGLE_SA_KEY_FILE")).toBe("fail");
  });

  // The hosted board ships with sends closed; opening them is step 6, deliberately later.
  it("warns when HERALD_SENDS_ENABLED is already set", () => {
    expect(statusOf(checkEnvNames([...COMPLETE, "HERALD_SENDS_ENABLED"]), "HERALD_SENDS_ENABLED")).toBe("warn");
  });

  it("ignores the other variables Neon injects", () => {
    const results = checkEnvNames([...COMPLETE, "PGHOST", "POSTGRES_URL", "NEON_PROJECT_ID"]);
    expect(results.filter((r) => r.status !== "ok")).toEqual([]);
  });

  it("keeps the two lists disjoint", () => {
    const set = new Set(MUST_BE_SET.map((e) => e.name));
    expect(MUST_BE_ABSENT.filter((e) => set.has(e.name))).toEqual([]);
  });
});
