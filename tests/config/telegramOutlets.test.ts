import { afterEach, describe, expect, it, vi } from "vitest";
import { loadTelegramChatIds } from "../../src/config";
import { ALL_OUTLETS, type Outlet } from "../../src/domain/outlet/models";

// Derived from ALL_OUTLETS (the single source of truth for outlet -> env var), not hand-listed,
// so a newly added auto-Telegram outlet is picked up here automatically.
const OUTLETS_WITH_CHAT_ID_ENV = ALL_OUTLETS.filter(
  (o): o is Outlet & { chatIdEnv: string } => Boolean(o.chatIdEnv),
);
const ENV_KEYS = ["TELEGRAM_CHAT_ID", ...OUTLETS_WITH_CHAT_ID_ENV.map((o) => o.chatIdEnv)];
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

  it("resolves a chat id for every outlet that declares a chatIdEnv (derived from ALL_OUTLETS)", () => {
    // Regression guard: this must not hardcode outlet ids. If a later task adds a third
    // auto-Telegram outlet with a chatIdEnv, this test picks it up via OUTLETS_WITH_CHAT_ID_ENV
    // and fails if that outlet's env var is set but never resolved into the returned map —
    // exactly the bug class of a second, hand-maintained outlet -> env mapping.
    expect(OUTLETS_WITH_CHAT_ID_ENV.length).toBeGreaterThan(0);
    const env: Record<string, string> = {};
    for (const outlet of OUTLETS_WITH_CHAT_ID_ENV) env[outlet.chatIdEnv] = `test-${outlet.id}`;
    withEnv(env);

    const result = loadTelegramChatIds();
    for (const outlet of OUTLETS_WITH_CHAT_ID_ENV) {
      expect(result[outlet.id], `expected outlet "${outlet.id}" (${outlet.chatIdEnv}) to resolve`).toBe(
        `test-${outlet.id}`,
      );
    }
  });
});
