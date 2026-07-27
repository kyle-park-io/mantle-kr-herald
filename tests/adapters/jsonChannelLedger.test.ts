import { describe, it, expect } from "vitest";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { JsonChannelLedger } from "../../src/adapters/store/JsonChannelLedger";
import type { ChannelSentEntry } from "../../src/domain/send/channels";

const entry = (overrides: Partial<ChannelSentEntry> = {}): ChannelSentEntry => ({
  itemId: "x:1", type: "announcement", channel: "telegram", postId: "11", url: "u", senderName: "telegram", sentAt: "2026-07-27T00:00:00Z", ...overrides,
});

describe("JsonChannelLedger", () => {
  it("records a sent key and reports it, upserting by (itemId,type,channel)", async () => {
    const dir = await mkdtemp(join(tmpdir(), "chled-"));
    const ledger = new JsonChannelLedger(dir);
    expect(await ledger.loadKeys()).toEqual(new Set());
    await ledger.add(entry());
    await ledger.add(entry({ postId: "22" })); // same key → upsert, not a second row
    const keys = await ledger.loadKeys();
    expect(keys.has("x:1:announcement:telegram")).toBe(true);
    expect(keys.size).toBe(1);
    await ledger.add(entry({ channel: "x" }));
    expect((await ledger.loadKeys()).size).toBe(2);
  });
});
