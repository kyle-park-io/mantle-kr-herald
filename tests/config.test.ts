import { describe, it, expect, afterEach, beforeEach } from "vitest";
import { loadConfig, loadLarkConfig } from "../src/config";

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
