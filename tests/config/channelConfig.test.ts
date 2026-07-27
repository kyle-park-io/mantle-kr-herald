import { describe, it, expect, afterEach } from "vitest";
import { loadTelegramConfig, loadTypefullyConfig } from "../../src/config";

const saved = { ...process.env };
afterEach(() => {
  process.env = { ...saved };
});

describe("channel config loaders", () => {
  it("loadTelegramConfig returns the token + chat id, throws when either is missing", () => {
    process.env.TELEGRAM_BOT_TOKEN = "T";
    process.env.TELEGRAM_CHAT_ID = "-100";
    expect(loadTelegramConfig()).toEqual({ botToken: "T", chatId: "-100" });
    delete process.env.TELEGRAM_BOT_TOKEN;
    expect(() => loadTelegramConfig()).toThrow(/TELEGRAM_BOT_TOKEN/);
  });
  it("loadTelegramConfig throws on the chat id branch when only the chat id is missing", () => {
    process.env.TELEGRAM_BOT_TOKEN = "T";
    delete process.env.TELEGRAM_CHAT_ID;
    expect(() => loadTelegramConfig()).toThrow(/TELEGRAM_CHAT_ID/);
  });
  it("loadTypefullyConfig returns key + social set, throws when either is missing", () => {
    process.env.TYPEFULLY_API_KEY = "K";
    process.env.TYPEFULLY_SOCIAL_SET_ID = "42";
    expect(loadTypefullyConfig()).toEqual({ apiKey: "K", socialSetId: "42" });
    delete process.env.TYPEFULLY_SOCIAL_SET_ID;
    expect(() => loadTypefullyConfig()).toThrow(/TYPEFULLY_SOCIAL_SET_ID/);
  });
  it("loadTypefullyConfig throws on the api key branch when only the api key is missing", () => {
    process.env.TYPEFULLY_SOCIAL_SET_ID = "42";
    delete process.env.TYPEFULLY_API_KEY;
    expect(() => loadTypefullyConfig()).toThrow(/TYPEFULLY_API_KEY/);
  });
});
