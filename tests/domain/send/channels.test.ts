import { describe, it, expect } from "vitest";
import { DELIVERY_DESTINATION, sentKey } from "../../../src/domain/send/channels";

describe("send domain", () => {
  it("maps each sendable channel to its API destination", () => {
    expect(DELIVERY_DESTINATION.telegram).toBe("telegram_bot");
    expect(DELIVERY_DESTINATION.x).toBe("x_typefully");
  });
  it("keys a sent entry by itemId:type:channel", () => {
    expect(sentKey({ itemId: "x:1", type: "announcement", channel: "telegram" })).toBe("x:1:announcement:telegram");
  });
});
