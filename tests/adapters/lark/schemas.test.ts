import { describe, it, expect } from "vitest";
import { normalizeMessage, parseMessagesData } from "../../../src/adapters/lark/schemas";

const rawMessage = {
  message_id: "om_123",
  msg_type: "text",
  create_time: "1750000000000",
  chat_id: "oc_abc",
  thread_id: "th_1",
  parent_id: "",
  sender: { id: "ou_sender", id_type: "open_id", sender_type: "user", tenant_key: "t" },
  body: { content: '{"text":"hello"}' },
};

describe("normalizeMessage", () => {
  it("maps a raw Lark message to LarkMessage with ISO createdAt and extracted text", () => {
    const m = normalizeMessage(rawMessage);
    expect(m.messageId).toBe("om_123");
    expect(m.chatId).toBe("oc_abc");
    expect(m.msgType).toBe("text");
    expect(m.createdAt).toBe(new Date(1750000000000).toISOString());
    expect(m.senderId).toBe("ou_sender");
    expect(m.threadId).toBe("th_1");
    expect(m.text).toBe("hello");
    expect(m.rawContent).toBe('{"text":"hello"}');
  });

  it("throws when a required field is missing", () => {
    expect(() => normalizeMessage({ msg_type: "text" })).toThrow();
  });

  it("does not throw when create_time is non-numeric, and falls back to epoch 0", () => {
    const m = normalizeMessage({ ...rawMessage, create_time: "not-a-number" });
    expect(m.createdAt).toBe(new Date(0).toISOString());
  });
});

describe("parseMessagesData", () => {
  it("extracts items, pageToken, hasMore from a code:0 envelope", () => {
    const parsed = parseMessagesData({
      code: 0,
      msg: "success",
      data: { items: [rawMessage], page_token: "pt1", has_more: true },
    });
    expect(parsed.items).toHaveLength(1);
    expect(parsed.pageToken).toBe("pt1");
    expect(parsed.hasMore).toBe(true);
  });

  it("defaults missing pagination fields", () => {
    const parsed = parseMessagesData({ code: 0, msg: "ok", data: { items: [] } });
    expect(parsed.hasMore).toBe(false);
    expect(parsed.pageToken).toBe("");
  });

  it("throws when code is non-zero", () => {
    expect(() => parseMessagesData({ code: 99991663, msg: "invalid token", data: {} })).toThrow(
      /99991663|invalid token/,
    );
  });
});
