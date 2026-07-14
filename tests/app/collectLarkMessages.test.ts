import { describe, it, expect } from "vitest";
import { CollectLarkMessages } from "../../src/app/CollectLarkMessages";
import type { LarkSourceGateway } from "../../src/ports/LarkSourceGateway";
import type { LarkRepository } from "../../src/ports/LarkRepository";
import type { WatermarkStore } from "../../src/shared/store/WatermarkStore";
import type { LarkMessage } from "../../src/domain/larkMessage";

function msg(id: string, chatId: string, createdAt: string): LarkMessage {
  return { messageId: id, chatId, msgType: "text", createdAt, text: `t${id}`, rawContent: "{}" };
}

class FakeGateway implements LarkSourceGateway {
  public sinceByChat = new Map<string, string | undefined>();
  constructor(private readonly byChat: Record<string, LarkMessage[]>) {}
  async *fetchMessages(chatId: string, sinceTime?: string): AsyncGenerator<LarkMessage> {
    this.sinceByChat.set(chatId, sinceTime);
    for (const m of this.byChat[chatId] ?? []) yield m;
  }
}

class InMemoryRepo implements LarkRepository {
  public saved: LarkMessage[] = [];
  async loadAll() {
    return this.saved;
  }
  async upsert(messages: LarkMessage[]) {
    this.saved.push(...messages);
  }
}

class InMemoryWatermark implements WatermarkStore {
  public marks = new Map<string, string>();
  async get(key: string) {
    return this.marks.get(key);
  }
  async set(key: string, time: string) {
    this.marks.set(key, time);
  }
}

describe("CollectLarkMessages", () => {
  it("collects each chat, saves, and advances per-chat watermark to max createdAt", async () => {
    const gw = new FakeGateway({
      oc_a: [msg("om_1", "oc_a", "2026-01-01T00:01:00.000Z"), msg("om_2", "oc_a", "2026-01-01T00:03:00.000Z")],
      oc_b: [msg("om_3", "oc_b", "2026-01-01T00:02:00.000Z")],
    });
    const repo = new InMemoryRepo();
    const wm = new InMemoryWatermark();
    const usecase = new CollectLarkMessages(gw, repo, wm);

    const result = await usecase.run(["oc_a", "oc_b"]);

    expect(result.collected).toBe(3);
    expect(repo.saved).toHaveLength(3);
    expect(wm.marks.get("oc_a")).toBe("2026-01-01T00:03:00.000Z");
    expect(wm.marks.get("oc_b")).toBe("2026-01-01T00:02:00.000Z");
  });

  it("passes the stored per-chat watermark as sinceTime", async () => {
    const gw = new FakeGateway({ oc_a: [] });
    const wm = new InMemoryWatermark();
    wm.marks.set("oc_a", "2026-05-05T00:00:00.000Z");
    const usecase = new CollectLarkMessages(gw, new InMemoryRepo(), wm);
    await usecase.run(["oc_a"]);
    expect(gw.sinceByChat.get("oc_a")).toBe("2026-05-05T00:00:00.000Z");
  });

  it("does not advance a chat's watermark when it collects nothing", async () => {
    const gw = new FakeGateway({ oc_a: [] });
    const wm = new InMemoryWatermark();
    wm.marks.set("oc_a", "2026-05-05T00:00:00.000Z");
    await new CollectLarkMessages(gw, new InMemoryRepo(), wm).run(["oc_a"]);
    expect(wm.marks.get("oc_a")).toBe("2026-05-05T00:00:00.000Z");
  });
});
