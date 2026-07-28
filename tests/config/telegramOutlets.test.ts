import { afterEach, describe, expect, it, vi } from "vitest";
import { loadTelegramChatIds } from "../../src/config";

const ENV_KEYS = ["TELEGRAM_CHAT_ID", "TELEGRAM_CHAT_ID_COMMUNITY", "TELEGRAM_CHAT_ID_DEV"];
function withEnv(values: Record<string, string | undefined>): void {
  for (const k of ENV_KEYS) delete process.env[k];
  for (const [k, v] of Object.entries(values)) if (v !== undefined) process.env[k] = v;
}
afterEach(() => {
  for (const k of ENV_KEYS) delete process.env[k];
  vi.restoreAllMocks();
});

describe("loadTelegramChatIds", () => {
  it("reads a chat id per outlet", () => {
    withEnv({ TELEGRAM_CHAT_ID_COMMUNITY: "-100111", TELEGRAM_CHAT_ID_DEV: "-100222" });
    expect(loadTelegramChatIds()).toEqual({ "tg-community": "-100111", "tg-dev": "-100222" });
  });

  it("falls back to legacy TELEGRAM_CHAT_ID for the primary room only, and warns", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    withEnv({ TELEGRAM_CHAT_ID: "-100999" });
    expect(loadTelegramChatIds()).toEqual({ "tg-community": "-100999" });
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0]?.[0]).toContain("TELEGRAM_CHAT_ID_COMMUNITY");
  });

  it("prefers the per-outlet variable over the legacy one and does not warn", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    withEnv({ TELEGRAM_CHAT_ID: "-100999", TELEGRAM_CHAT_ID_COMMUNITY: "-100111" });
    expect(loadTelegramChatIds()).toEqual({ "tg-community": "-100111" });
    expect(warn).not.toHaveBeenCalled();
  });

  it("returns an empty map when nothing is configured", () => {
    withEnv({});
    expect(loadTelegramChatIds()).toEqual({});
  });
});
