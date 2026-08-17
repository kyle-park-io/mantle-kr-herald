import { describe, it, expect, afterEach, beforeEach } from "vitest";
import { readFile } from "node:fs/promises";
import {
  loadConfig,
  loadLarkAppConfig,
  loadLarkConfig,
  loadGoogleDriveConfig,
  loadGoogleDriveInitConfig,
  loadLarkDriveConfig,
  loadGoogleAuthConfig,
  loadGoogleSheetConfig,
  loadClientIpConfig,
} from "../src/config";

/**
 * Every loader in `src/config.ts` reads `process.env` directly, and several return an object whose
 * OPTIONAL fields are simply absent when their variable is unset. A `toEqual` in this file therefore
 * asserts against the ambient environment as much as against what the test itself set: a key the test
 * never mentions still lands in the result if the machine happens to have it.
 *
 * That is not hypothetical. `pnpm deploy:check` runs as `tsx --env-file-if-exists=.env` and spawns
 * `pnpm test` as a child, so the suite inherits a fully populated `.env` — and on 2026-08-05 two tests
 * here failed for exactly this reason (`GDRIVE_SENT_FOLDER_ID`, `LARK_DRIVE_SENT_FOLDER_TOKEN`,
 * `LARK_WORKSPACE_URL`). The gate built to guard the deploy failed on every machine able to perform
 * one, for a reason that had nothing to do with the deploy. A bare `vitest run` passed, which is what
 * made it invisible.
 *
 * So the whole file runs from a cleared environment: a test sees exactly what it set, and nothing
 * else. The per-`describe` save/restore blocks below stay — they are what each block documents about
 * the keys it cares about — but they are no longer what makes the assertions correct.
 */
const CONFIG_ENV_KEYS = [
  "DATABASE_URL",
  "GDRIVE_APPROVED_FOLDER_ID",
  "GDRIVE_CONFIG_FOLDER_ID",
  "GDRIVE_PARENT_FOLDER_NAME",
  "GDRIVE_REVIEW_FOLDER_ID",
  "GDRIVE_SENT_FOLDER_ID",
  "GDRIVE_SHARE_EMAILS",
  "GDRIVE_STATE_FOLDER_ID",
  "GOOGLE_AUTH_MODE",
  "GOOGLE_OAUTH_CLIENT_ID",
  "GOOGLE_OAUTH_CLIENT_SECRET",
  "GOOGLE_OAUTH_REFRESH_TOKEN",
  "GOOGLE_SA_KEY_FILE",
  "GSHEET_ID",
  "GSHEET_QA_ID",
  "HERALD_AUTH_PASSWORD_HASH",
  "HERALD_AUTH_USERNAME",
  "HERALD_DB_ENV",
  "HERALD_DEPLOYMENT_ORIGIN",
  "HERALD_INTAKE_ENABLED",
  "HERALD_SENDS_ENABLED",
  "HERALD_SESSION_SECRET",
  "HERALD_STORAGE_MODE",
  "HERALD_TRUST_PROXY",
  "HERALD_TRUST_PROXY_HOPS",
  "LARK_APP_ID",
  "LARK_APP_SECRET",
  "LARK_BASE_URL",
  "LARK_CHAT_IDS",
  "LARK_DRIVE_APPROVED_FOLDER_TOKEN",
  "LARK_DRIVE_REVIEW_FOLDER_TOKEN",
  "LARK_DRIVE_SENT_FOLDER_TOKEN",
  "LARK_WORKSPACE_URL",
  "TELEGRAM_BOT_TOKEN",
  "TWITTERAPI_IO_KEY",
  "TYPEFULLY_API_KEY",
  "TYPEFULLY_SOCIAL_SET_ID",
  "X_PREMIUM",
] as const;

/**
 * `loadClientIpConfig`'s sibling reads its variable by computed name (`process.env[outlet.chatIdEnv]`,
 * `src/config.ts:192`), so no fixed list can name those. They all share this prefix.
 */
const DYNAMIC_PREFIX = "TELEGRAM_CHAT_ID_";

const savedEnv: Record<string, string | undefined> = {};
beforeEach(() => {
  for (const k of Object.keys(process.env)) {
    if (!(CONFIG_ENV_KEYS as readonly string[]).includes(k) && !k.startsWith(DYNAMIC_PREFIX)) continue;
    savedEnv[k] = process.env[k];
    delete process.env[k];
  }
});
afterEach(() => {
  for (const [k, v] of Object.entries(savedEnv)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
    delete savedEnv[k];
  }
});

/**
 * Keeps `CONFIG_ENV_KEYS` from rotting. A loader that starts reading a new variable without adding it
 * here would reintroduce exactly the leak above — silently, and only under `deploy:check`.
 */
it("clears every variable src/config.ts reads by name", async () => {
  const source = await readFile(new URL("../src/config.ts", import.meta.url), "utf8");
  const read = new Set([...source.matchAll(/process\.env\.([A-Z0-9_]+)/g)].map((m) => m[1]));
  expect([...read].sort()).toEqual([...CONFIG_ENV_KEYS].sort());
});

describe("loadConfig", () => {
  it("returns the apiKey from env", () => {
    process.env.TWITTERAPI_IO_KEY = "abc";
    expect(loadConfig()).toEqual({ apiKey: "abc" });
  });

  it("throws a clear error when the key is missing", () => {
    delete process.env.TWITTERAPI_IO_KEY;
    expect(() => loadConfig()).toThrow(/TWITTERAPI_IO_KEY/);
  });
});

describe("loadLarkAppConfig", () => {
  const keys = ["LARK_APP_ID", "LARK_APP_SECRET", "LARK_BASE_URL"];
  const original: Record<string, string | undefined> = {};
  beforeEach(() => {
    for (const k of keys) original[k] = process.env[k];
  });
  afterEach(() => {
    for (const k of keys) {
      if (original[k] === undefined) delete process.env[k];
      else process.env[k] = original[k];
    }
  });

  it("returns app credentials and defaults base url when LARK_CHAT_IDS is unset", () => {
    process.env.LARK_APP_ID = "cli_x";
    process.env.LARK_APP_SECRET = "sec";
    delete process.env.LARK_BASE_URL;
    expect(loadLarkAppConfig()).toEqual({
      appId: "cli_x",
      appSecret: "sec",
      baseUrl: "https://open.larksuite.com",
    });
  });

  it("throws when app id or secret is missing", () => {
    delete process.env.LARK_APP_ID;
    process.env.LARK_APP_SECRET = "sec";
    expect(() => loadLarkAppConfig()).toThrow(/LARK_APP_ID/);
  });
});

describe("loadLarkConfig", () => {
  const keys = ["LARK_APP_ID", "LARK_APP_SECRET", "LARK_CHAT_IDS", "LARK_BASE_URL"];
  const original: Record<string, string | undefined> = {};
  beforeEach(() => {
    for (const k of keys) original[k] = process.env[k];
  });
  afterEach(() => {
    for (const k of keys) {
      if (original[k] === undefined) delete process.env[k];
      else process.env[k] = original[k];
    }
  });

  it("parses app id/secret, comma-separated chat ids, and defaults the base url", () => {
    process.env.LARK_APP_ID = "cli_x";
    process.env.LARK_APP_SECRET = "sec";
    process.env.LARK_CHAT_IDS = "oc_a, oc_b";
    delete process.env.LARK_BASE_URL;
    expect(loadLarkConfig()).toEqual({
      appId: "cli_x",
      appSecret: "sec",
      chatIds: ["oc_a", "oc_b"],
      baseUrl: "https://open.larksuite.com",
    });
  });

  it("throws when app id or secret is missing", () => {
    delete process.env.LARK_APP_ID;
    process.env.LARK_APP_SECRET = "sec";
    process.env.LARK_CHAT_IDS = "oc_a";
    expect(() => loadLarkConfig()).toThrow(/LARK_APP_ID/);
  });

  it("throws when no chat ids are configured", () => {
    process.env.LARK_APP_ID = "cli_x";
    process.env.LARK_APP_SECRET = "sec";
    process.env.LARK_CHAT_IDS = "";
    expect(() => loadLarkConfig()).toThrow(/LARK_CHAT_IDS/);
  });
});

describe("loadGoogleDriveConfig", () => {
  const keys = ["GDRIVE_REVIEW_FOLDER_ID", "GDRIVE_APPROVED_FOLDER_ID"];
  const original: Record<string, string | undefined> = {};
  beforeEach(() => { for (const k of keys) original[k] = process.env[k]; });
  afterEach(() => { for (const k of keys) { if (original[k] === undefined) delete process.env[k]; else process.env[k] = original[k]; } });

  it("reads the folder id env vars", () => {
    process.env.GDRIVE_REVIEW_FOLDER_ID = "R";
    process.env.GDRIVE_APPROVED_FOLDER_ID = "A";
    expect(loadGoogleDriveConfig()).toEqual({ reviewFolderId: "R", approvedFolderId: "A" });
  });

  it("throws when a folder id var is missing", () => {
    delete process.env.GDRIVE_REVIEW_FOLDER_ID;
    process.env.GDRIVE_APPROVED_FOLDER_ID = "A";
    expect(() => loadGoogleDriveConfig()).toThrow(/GDRIVE_REVIEW_FOLDER_ID/);
  });
});

describe("loadGoogleDriveInitConfig", () => {
  const keys = ["GDRIVE_SHARE_EMAILS", "GDRIVE_PARENT_FOLDER_NAME"];
  const original: Record<string, string | undefined> = {};
  beforeEach(() => { for (const k of keys) original[k] = process.env[k]; });
  afterEach(() => { for (const k of keys) { if (original[k] === undefined) delete process.env[k]; else process.env[k] = original[k]; } });

  it("parses comma-separated share emails (trimmed, empties filtered)", () => {
    process.env.GDRIVE_SHARE_EMAILS = "a@b.com, c@d.com,,  e@f.com  ";
    delete process.env.GDRIVE_PARENT_FOLDER_NAME;
    expect(loadGoogleDriveInitConfig()).toEqual({
      shareEmails: ["a@b.com", "c@d.com", "e@f.com"],
      parentFolderName: "Mantle KR Herald",
    });
  });

  it("defaults shareEmails to an empty array when GDRIVE_SHARE_EMAILS is unset", () => {
    delete process.env.GDRIVE_SHARE_EMAILS;
    delete process.env.GDRIVE_PARENT_FOLDER_NAME;
    expect(loadGoogleDriveInitConfig()).toEqual({
      shareEmails: [],
      parentFolderName: "Mantle KR Herald",
    });
  });

  it("uses a trimmed GDRIVE_PARENT_FOLDER_NAME when set", () => {
    process.env.GDRIVE_PARENT_FOLDER_NAME = "  Custom Parent  ";
    expect(loadGoogleDriveInitConfig().parentFolderName).toBe("Custom Parent");
  });

  it("falls back to the default parentFolderName when GDRIVE_PARENT_FOLDER_NAME is blank", () => {
    process.env.GDRIVE_PARENT_FOLDER_NAME = "   ";
    expect(loadGoogleDriveInitConfig().parentFolderName).toBe("Mantle KR Herald");
  });
});

describe("loadGoogleAuthConfig", () => {
  const keys = [
    "GOOGLE_AUTH_MODE",
    "GOOGLE_OAUTH_CLIENT_ID",
    "GOOGLE_OAUTH_CLIENT_SECRET",
    "GOOGLE_OAUTH_REFRESH_TOKEN",
    "GOOGLE_SA_KEY_FILE",
  ];
  const original: Record<string, string | undefined> = {};
  beforeEach(() => {
    for (const k of keys) {
      original[k] = process.env[k];
      delete process.env[k];
    }
  });
  afterEach(() => { for (const k of keys) { if (original[k] === undefined) delete process.env[k]; else process.env[k] = original[k]; } });

  it("infers oauth mode when a refresh token is present (no explicit mode)", () => {
    process.env.GOOGLE_OAUTH_CLIENT_ID = "cid";
    process.env.GOOGLE_OAUTH_CLIENT_SECRET = "csecret";
    process.env.GOOGLE_OAUTH_REFRESH_TOKEN = "rt";
    expect(loadGoogleAuthConfig()).toEqual({
      mode: "oauth",
      clientId: "cid",
      clientSecret: "csecret",
      refreshToken: "rt",
    });
  });

  it("throws when oauth mode is missing GOOGLE_OAUTH_CLIENT_ID", () => {
    process.env.GOOGLE_OAUTH_CLIENT_SECRET = "csecret";
    process.env.GOOGLE_OAUTH_REFRESH_TOKEN = "rt";
    expect(() => loadGoogleAuthConfig()).toThrow(/GOOGLE_OAUTH_CLIENT_ID/);
  });

  it("infers service_account mode when only GOOGLE_SA_KEY_FILE is present", () => {
    process.env.GOOGLE_SA_KEY_FILE = "/k.json";
    expect(loadGoogleAuthConfig()).toEqual({ mode: "service_account", saKeyFile: "/k.json" });
  });

  it("throws when GOOGLE_AUTH_MODE=service_account but GOOGLE_SA_KEY_FILE is missing", () => {
    process.env.GOOGLE_AUTH_MODE = "service_account";
    expect(() => loadGoogleAuthConfig()).toThrow(/GOOGLE_SA_KEY_FILE/);
  });

  it("explicit GOOGLE_AUTH_MODE=service_account wins even when a refresh token is present", () => {
    process.env.GOOGLE_AUTH_MODE = "service_account";
    process.env.GOOGLE_OAUTH_REFRESH_TOKEN = "rt";
    process.env.GOOGLE_SA_KEY_FILE = "/k.json";
    expect(loadGoogleAuthConfig()).toEqual({ mode: "service_account", saKeyFile: "/k.json" });
  });

  it("explicit GOOGLE_AUTH_MODE=oauth wins even when a service-account key is present", () => {
    process.env.GOOGLE_AUTH_MODE = "oauth";
    process.env.GOOGLE_SA_KEY_FILE = "/k.json";
    process.env.GOOGLE_OAUTH_CLIENT_ID = "cid";
    process.env.GOOGLE_OAUTH_CLIENT_SECRET = "csecret";
    process.env.GOOGLE_OAUTH_REFRESH_TOKEN = "rt";
    expect(loadGoogleAuthConfig()).toEqual({ mode: "oauth", clientId: "cid", clientSecret: "csecret", refreshToken: "rt" });
  });

  it("throws on an invalid GOOGLE_AUTH_MODE", () => {
    process.env.GOOGLE_AUTH_MODE = "bogus";
    expect(() => loadGoogleAuthConfig()).toThrow(/Invalid GOOGLE_AUTH_MODE/);
  });

  it("throws when nothing is configured", () => {
    expect(() => loadGoogleAuthConfig()).toThrow(/No Google auth configured/);
  });
});

describe("loadLarkDriveConfig", () => {
  const keys = ["LARK_APP_ID", "LARK_APP_SECRET", "LARK_BASE_URL", "LARK_DRIVE_REVIEW_FOLDER_TOKEN", "LARK_DRIVE_APPROVED_FOLDER_TOKEN"];
  const original: Record<string, string | undefined> = {};
  beforeEach(() => { for (const k of keys) original[k] = process.env[k]; });
  afterEach(() => { for (const k of keys) { if (original[k] === undefined) delete process.env[k]; else process.env[k] = original[k]; } });

  it("reads app creds + folder tokens and defaults baseUrl", () => {
    process.env.LARK_APP_ID = "cli_x";
    process.env.LARK_APP_SECRET = "sec";
    delete process.env.LARK_BASE_URL;
    process.env.LARK_DRIVE_REVIEW_FOLDER_TOKEN = "R";
    process.env.LARK_DRIVE_APPROVED_FOLDER_TOKEN = "A";
    expect(loadLarkDriveConfig()).toEqual({
      appId: "cli_x", appSecret: "sec", baseUrl: "https://open.larksuite.com",
      reviewFolderToken: "R", approvedFolderToken: "A",
    });
  });

  it("throws when a folder token is missing", () => {
    process.env.LARK_APP_ID = "cli_x";
    process.env.LARK_APP_SECRET = "sec";
    process.env.LARK_DRIVE_REVIEW_FOLDER_TOKEN = "R";
    delete process.env.LARK_DRIVE_APPROVED_FOLDER_TOKEN;
    expect(() => loadLarkDriveConfig()).toThrow(/LARK_DRIVE_APPROVED_FOLDER_TOKEN/);
  });
});

describe("loadGoogleSheetConfig", () => {
  const original = process.env.GSHEET_ID;
  afterEach(() => {
    if (original === undefined) delete process.env.GSHEET_ID;
    else process.env.GSHEET_ID = original;
  });

  it("reads GSHEET_ID (trimmed)", () => {
    process.env.GSHEET_ID = "  sheet_abc  ";
    expect(loadGoogleSheetConfig()).toEqual({ spreadsheetId: "sheet_abc" });
  });

  it("throws when GSHEET_ID is missing", () => {
    delete process.env.GSHEET_ID;
    expect(() => loadGoogleSheetConfig()).toThrow(/GSHEET_ID/);
  });
});

describe("loadDbConfig", () => {
  const clear = () => { delete process.env.DATABASE_URL; delete process.env.HERALD_DB_ENV; };
  beforeEach(clear);
  afterEach(clear);

  it("refuses when DATABASE_URL is absent", async () => {
    const { loadDbConfig } = await import("../src/config");
    process.env.HERALD_DB_ENV = "development";
    expect(() => loadDbConfig()).toThrow(/DATABASE_URL/);
  });

  it("refuses when HERALD_DB_ENV is absent — it is never inferred from the URL", async () => {
    const { loadDbConfig } = await import("../src/config");
    process.env.DATABASE_URL = "postgres://localhost/herald";
    expect(() => loadDbConfig()).toThrow(/HERALD_DB_ENV/);
  });

  it("refuses an HERALD_DB_ENV that is neither production nor development", async () => {
    const { loadDbConfig } = await import("../src/config");
    process.env.DATABASE_URL = "postgres://localhost/herald";
    process.env.HERALD_DB_ENV = "staging";
    expect(() => loadDbConfig()).toThrow(/production/);
  });

  it("returns both when both are stated", async () => {
    const { loadDbConfig } = await import("../src/config");
    process.env.DATABASE_URL = "postgres://localhost/herald";
    process.env.HERALD_DB_ENV = "production";
    expect(loadDbConfig()).toEqual({ url: "postgres://localhost/herald", env: "production" });
  });
});

describe("loadSessionConfig", () => {
  const clear = () => { delete process.env.HERALD_SESSION_SECRET; };
  beforeEach(clear);
  afterEach(clear);

  it("refuses when HERALD_SESSION_SECRET is absent", async () => {
    const { loadSessionConfig } = await import("../src/config");
    expect(() => loadSessionConfig()).toThrow(/HERALD_SESSION_SECRET/);
  });

  it("refuses a secret shorter than 32 characters", async () => {
    const { loadSessionConfig } = await import("../src/config");
    process.env.HERALD_SESSION_SECRET = "a".repeat(31);
    expect(() => loadSessionConfig()).toThrow(/too short/);
  });

  it("returns the secret and the session lifetime", async () => {
    const { loadSessionConfig } = await import("../src/config");
    const { SESSION_TTL_MS } = await import("../src/domain/auth/session");
    process.env.HERALD_SESSION_SECRET = "a".repeat(32);
    expect(loadSessionConfig()).toEqual({ secret: "a".repeat(32), ttlMs: SESSION_TTL_MS });
  });
});

describe("loadDeploymentOrigin", () => {
  const clear = () => { delete process.env.HERALD_DEPLOYMENT_ORIGIN; };
  beforeEach(clear);
  afterEach(clear);

  it("refuses when unset — no safe default to guess at", async () => {
    const { loadDeploymentOrigin } = await import("../src/config");
    expect(() => loadDeploymentOrigin()).toThrow(/HERALD_DEPLOYMENT_ORIGIN/);
  });

  it("refuses a value that is not a URL at all", async () => {
    const { loadDeploymentOrigin } = await import("../src/config");
    process.env.HERALD_DEPLOYMENT_ORIGIN = "not a url";
    expect(() => loadDeploymentOrigin()).toThrow(/not a URL/);
  });

  it("refuses a non-https origin", async () => {
    const { loadDeploymentOrigin } = await import("../src/config");
    process.env.HERALD_DEPLOYMENT_ORIGIN = "http://herald-review.vercel.app";
    expect(() => loadDeploymentOrigin()).toThrow(/https/);
  });

  it.each([
    ["a path", "https://herald-review.vercel.app/api"],
    ["a query string", "https://herald-review.vercel.app/?x=1"],
    ["a fragment", "https://herald-review.vercel.app/#top"],
  ])("refuses an origin carrying %s", async (_label, value) => {
    const { loadDeploymentOrigin } = await import("../src/config");
    process.env.HERALD_DEPLOYMENT_ORIGIN = value;
    expect(() => loadDeploymentOrigin()).toThrow(/origin only/);
  });

  it("normalizes to scheme + host, dropping a trailing slash", async () => {
    const { loadDeploymentOrigin } = await import("../src/config");
    process.env.HERALD_DEPLOYMENT_ORIGIN = "https://herald-review.vercel.app/";
    expect(loadDeploymentOrigin()).toBe("https://herald-review.vercel.app");
  });

  it("returns an already-bare origin unchanged", async () => {
    const { loadDeploymentOrigin } = await import("../src/config");
    process.env.HERALD_DEPLOYMENT_ORIGIN = "https://herald-review.vercel.app";
    expect(loadDeploymentOrigin()).toBe("https://herald-review.vercel.app");
  });
});

describe("loadClientIpConfig", () => {
  const keys = ["HERALD_TRUST_PROXY", "HERALD_TRUST_PROXY_HOPS"];
  const original: Record<string, string | undefined> = {};
  beforeEach(() => {
    for (const k of keys) {
      original[k] = process.env[k];
      delete process.env[k];
    }
  });
  afterEach(() => {
    for (const k of keys) {
      if (original[k] === undefined) delete process.env[k];
      else process.env[k] = original[k];
    }
  });

  it("defaults to not trusting the proxy header, at 1 hop", () => {
    expect(loadClientIpConfig()).toEqual({ trustProxy: false, trustedHopsFromEnd: 1 });
  });

  it("stays untrusted for anything other than the literal string 'true'", () => {
    process.env.HERALD_TRUST_PROXY = "1";
    expect(loadClientIpConfig().trustProxy).toBe(false);
    process.env.HERALD_TRUST_PROXY = "TRUE";
    expect(loadClientIpConfig().trustProxy).toBe(true); // case-insensitive is fine — only the value matters
  });

  it("trusts the proxy header only when explicitly set to true", () => {
    process.env.HERALD_TRUST_PROXY = "true";
    expect(loadClientIpConfig().trustProxy).toBe(true);
  });

  it("reads a custom hop count", () => {
    process.env.HERALD_TRUST_PROXY = "true";
    process.env.HERALD_TRUST_PROXY_HOPS = "3";
    expect(loadClientIpConfig()).toEqual({ trustProxy: true, trustedHopsFromEnd: 3 });
  });

  it("refuses a non-positive-integer hop count", () => {
    process.env.HERALD_TRUST_PROXY_HOPS = "0";
    expect(() => loadClientIpConfig()).toThrow(/HERALD_TRUST_PROXY_HOPS/);
    process.env.HERALD_TRUST_PROXY_HOPS = "-1";
    expect(() => loadClientIpConfig()).toThrow(/HERALD_TRUST_PROXY_HOPS/);
    process.env.HERALD_TRUST_PROXY_HOPS = "1.5";
    expect(() => loadClientIpConfig()).toThrow(/HERALD_TRUST_PROXY_HOPS/);
    process.env.HERALD_TRUST_PROXY_HOPS = "nope";
    expect(() => loadClientIpConfig()).toThrow(/HERALD_TRUST_PROXY_HOPS/);
  });
});
