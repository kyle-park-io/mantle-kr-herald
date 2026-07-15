import { describe, it, expect, afterEach, beforeEach } from "vitest";
import {
  loadConfig,
  loadLarkConfig,
  loadGoogleDriveConfig,
  loadGoogleDriveInitConfig,
  loadLarkDriveConfig,
  loadGoogleAuthConfig,
  loadGoogleSheetConfig,
} from "../src/config";

const original = process.env.TWITTERAPI_IO_KEY;
afterEach(() => {
  if (original === undefined) delete process.env.TWITTERAPI_IO_KEY;
  else process.env.TWITTERAPI_IO_KEY = original;
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
