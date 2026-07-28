import { describe, it, expect, afterEach, vi } from "vitest";
import { resolveChannelTargets, createSenders } from "../../src/cli/channelSenders";
import { SendChannels } from "../../src/app/SendChannels";
import { loadTelegramChatIds } from "../../src/config";
import { outletsForChannel } from "../../src/domain/outlet/models";
import type { FormattingStore } from "../../src/ports/FormattingStore";
import type { DeliveryLedger } from "../../src/ports/DeliveryLedger";
import type { ChannelRendering } from "../../src/domain/formatting/models";
import type { DeliveryEntry } from "../../src/domain/delivery/models";
import { deliveryKey } from "../../src/domain/delivery/models";

describe("resolveChannelTargets", () => {
  it("defaults to all channels", () => {
    expect(resolveChannelTargets(undefined).sort()).toEqual(["telegram", "x"]);
  });
  it("expands 'both' to all channels", () => {
    expect(resolveChannelTargets("both").sort()).toEqual(["telegram", "x"]);
  });
  it("takes an explicit single channel", () => {
    expect(resolveChannelTargets("telegram")).toEqual(["telegram"]);
  });
  it("dedupes and rejects an unknown token", () => {
    expect(resolveChannelTargets("x,x")).toEqual(["x"]);
    expect(() => resolveChannelTargets("kakao")).toThrow(/Unknown channel target/);
  });
});

/**
 * The `.env` an operator gets from following `.env.example` today: a bot token plus one id per
 * room, and **no** legacy `TELEGRAM_CHAT_ID`. Building the sender used to require the legacy
 * variable, so that exact `.env` made `send:channels --target telegram` abort before reading a
 * single room id — every Telegram delivery lost.
 */
describe("createSenders — telegram on a per-room .env", () => {
  const saved = { ...process.env };
  afterEach(() => {
    process.env = { ...saved };
    vi.unstubAllGlobals();
  });

  const perRoomEnv = (): void => {
    process.env.TELEGRAM_BOT_TOKEN = "T";
    delete process.env.TELEGRAM_CHAT_ID;
    process.env.TELEGRAM_CHAT_ID_COMMUNITY = "-100111";
    process.env.TELEGRAM_CHAT_ID_DEV = "-100222";
  };

  it("builds the telegram sender with no legacy TELEGRAM_CHAT_ID set", () => {
    perRoomEnv();
    expect(createSenders(["telegram"]).telegram?.name).toBe("telegram");
  });

  it("still requires the bot token", () => {
    perRoomEnv();
    delete process.env.TELEGRAM_BOT_TOKEN;
    expect(() => createSenders(["telegram"])).toThrow(/TELEGRAM_BOT_TOKEN/);
  });

  it("posts to both rooms end to end — real sender, per-room ids, no legacy var", async () => {
    perRoomEnv();
    const calls: { url: string; body: Record<string, unknown> }[] = [];
    vi.stubGlobal("fetch", async (url: string, init: RequestInit) => {
      calls.push({ url: String(url), body: JSON.parse(String(init.body)) });
      return new Response(JSON.stringify({ result: { message_id: 7 } }), { status: 200 });
    });

    const rendering: ChannelRendering = {
      itemId: "x:1", type: "announcement", channel: "telegram", text: "본문", refined: false,
      createdAt: "2026-07-29T00:00:00Z", status: "approved",
    };
    const store: FormattingStore = { loadAll: async () => [rendering], upsert: async () => {}, listRenderedKeys: async () => new Set() };
    let rows: DeliveryEntry[] = [];
    const ledger: DeliveryLedger = {
      loadAll: async () => rows,
      loadKeys: async () => new Set(rows.map(deliveryKey)),
      add: async (e) => { rows = [...rows, e]; },
      remove: async () => {},
    };

    // The real CLI wiring: senders from `createSenders`, chat ids from `loadTelegramChatIds`.
    const res = await new SendChannels(
      store, createSenders(["telegram"]), ledger, undefined, undefined, () => "T", undefined, outletsForChannel, loadTelegramChatIds(),
    ).run({ targets: ["telegram"] });

    expect(res.sent).toBe(2);
    expect(res.failed).toBe(0);
    expect(calls.map((c) => c.body.chat_id)).toEqual(["-100111", "-100222"]);
    expect(calls.every((c) => c.url.startsWith("https://api.telegram.org/botT/"))).toBe(true);
  });
});
