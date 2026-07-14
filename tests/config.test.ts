import { describe, it, expect, afterEach, beforeEach } from "vitest";
import { loadConfig, loadLarkConfig, loadGoogleDriveConfig, loadGoogleDriveInitConfig, loadLarkDriveConfig } from "../src/config";

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
  const keys = ["GOOGLE_SA_KEY_FILE", "GDRIVE_REVIEW_FOLDER_ID", "GDRIVE_APPROVED_FOLDER_ID"];
  const original: Record<string, string | undefined> = {};
  beforeEach(() => { for (const k of keys) original[k] = process.env[k]; });
  afterEach(() => { for (const k of keys) { if (original[k] === undefined) delete process.env[k]; else process.env[k] = original[k]; } });

  it("reads the three Google env vars", () => {
    process.env.GOOGLE_SA_KEY_FILE = "/k.json";
    process.env.GDRIVE_REVIEW_FOLDER_ID = "R";
    process.env.GDRIVE_APPROVED_FOLDER_ID = "A";
    expect(loadGoogleDriveConfig()).toEqual({ saKeyFile: "/k.json", reviewFolderId: "R", approvedFolderId: "A" });
  });

  it("throws when the key file var is missing", () => {
    delete process.env.GOOGLE_SA_KEY_FILE;
    process.env.GDRIVE_REVIEW_FOLDER_ID = "R";
    process.env.GDRIVE_APPROVED_FOLDER_ID = "A";
    expect(() => loadGoogleDriveConfig()).toThrow(/GOOGLE_SA_KEY_FILE/);
  });
});

describe("loadGoogleDriveInitConfig", () => {
  const keys = ["GOOGLE_SA_KEY_FILE", "GDRIVE_SHARE_EMAILS"];
  const original: Record<string, string | undefined> = {};
  beforeEach(() => { for (const k of keys) original[k] = process.env[k]; });
  afterEach(() => { for (const k of keys) { if (original[k] === undefined) delete process.env[k]; else process.env[k] = original[k]; } });

  it("parses the key file and comma-separated share emails (trimmed, empties filtered)", () => {
    process.env.GOOGLE_SA_KEY_FILE = "/k.json";
    process.env.GDRIVE_SHARE_EMAILS = "a@b.com, c@d.com,,  e@f.com  ";
    expect(loadGoogleDriveInitConfig()).toEqual({
      saKeyFile: "/k.json",
      shareEmails: ["a@b.com", "c@d.com", "e@f.com"],
    });
  });

  it("throws when the key file var is missing", () => {
    delete process.env.GOOGLE_SA_KEY_FILE;
    process.env.GDRIVE_SHARE_EMAILS = "a@b.com";
    expect(() => loadGoogleDriveInitConfig()).toThrow(/GOOGLE_SA_KEY_FILE/);
  });

  it("defaults shareEmails to an empty array when GDRIVE_SHARE_EMAILS is unset", () => {
    process.env.GOOGLE_SA_KEY_FILE = "/k.json";
    delete process.env.GDRIVE_SHARE_EMAILS;
    expect(loadGoogleDriveInitConfig()).toEqual({ saKeyFile: "/k.json", shareEmails: [] });
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
