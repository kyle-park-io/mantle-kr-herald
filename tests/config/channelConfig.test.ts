import { describe, it, expect, afterEach } from "vitest";
import { loadTelegramConfig, loadTypefullyConfig } from "../../src/config";

const saved = { ...process.env };
afterEach(() => {
  process.env = { ...saved };
});

describe("channel config loaders", () => {
  it("loadTelegramConfig returns the token + legacy chat id, throws only when the token is missing", () => {
    process.env.TELEGRAM_BOT_TOKEN = "T";
    process.env.TELEGRAM_CHAT_ID = "-100";
    expect(loadTelegramConfig()).toEqual({ botToken: "T", chatId: "-100" });
    delete process.env.TELEGRAM_BOT_TOKEN;
    expect(() => loadTelegramConfig()).toThrow(/TELEGRAM_BOT_TOKEN/);
  });
  it("loadTelegramConfig does not require the legacy chat id — rooms are configured per outlet", () => {
    // The per-room `.env` that `.env.example` documents has no TELEGRAM_CHAT_ID at all. Requiring
    // it here threw before a single room id was ever read, so every Telegram send died.
    process.env.TELEGRAM_BOT_TOKEN = "T";
    delete process.env.TELEGRAM_CHAT_ID;
    process.env.TELEGRAM_CHAT_ID_COMMUNITY = "-100111";
    expect(loadTelegramConfig()).toEqual({ botToken: "T", chatId: undefined });
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
