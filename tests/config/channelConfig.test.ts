import { describe, it, expect, afterEach } from "vitest";
import { loadSheetLinks, loadTelegramConfig, loadTypefullyConfig } from "../../src/config";

const saved = { ...process.env };
afterEach(() => {
  process.env = { ...saved };
});

describe("channel config loaders", () => {
  it("loadTelegramConfig returns the token, and throws only when it is missing", () => {
    process.env.TELEGRAM_BOT_TOKEN = "T";
    expect(loadTelegramConfig()).toEqual({ botToken: "T" });
    delete process.env.TELEGRAM_BOT_TOKEN;
    expect(() => loadTelegramConfig()).toThrow(/TELEGRAM_BOT_TOKEN/);
  });
  /**
   * The token is the whole of the Telegram *connection*; a room is not part of it. Carrying a chat
   * id here once made a per-room `.env` throw before a single room was read, and later made the
   * sender hold a default that could receive another room's copy.
   */
  it("loadTelegramConfig carries no chat id at all — rooms are configured per outlet", () => {
    process.env.TELEGRAM_BOT_TOKEN = "T";
    process.env.TELEGRAM_CHAT_ID = "-100"; // a stale legacy line in someone's .env
    process.env.TELEGRAM_CHAT_ID_COMMUNITY = "-100111";
    expect(Object.keys(loadTelegramConfig())).toEqual(["botToken"]);
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

describe("loadSheetLinks", () => {
  it("builds a spreadsheet URL per configured id", () => {
    process.env.GSHEET_ID = "AAA";
    process.env.GSHEET_QA_ID = "BBB";
    expect(loadSheetLinks()).toEqual({
      data: { url: "https://docs.google.com/spreadsheets/d/AAA/edit", title: "데이터 시트" },
      qa: { url: "https://docs.google.com/spreadsheets/d/BBB/edit", title: "QA 시트" },
    });
  });

  /** A blank id hides its header link; it must never render a URL with an empty id in it. */
  it("omits a link whose id is unset or blank", () => {
    process.env.GSHEET_ID = "AAA";
    process.env.GSHEET_QA_ID = "   ";
    expect(loadSheetLinks()).toEqual({
      data: { url: "https://docs.google.com/spreadsheets/d/AAA/edit", title: "데이터 시트" },
      qa: undefined,
    });
  });

  /** Header links are a convenience — an unconfigured sheet must not take the dashboard down. */
  it("never throws when nothing is configured", () => {
    delete process.env.GSHEET_ID;
    delete process.env.GSHEET_QA_ID;
    expect(loadSheetLinks()).toEqual({ data: undefined, qa: undefined });
  });
});
