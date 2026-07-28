import { describe, expect, it } from "vitest";
import { textFor } from "../../../src/domain/outlet/override";
import type { ChannelRendering } from "../../../src/domain/formatting/models";

const rendering: ChannelRendering = {
  itemId: "x:1", type: "announcement", channel: "telegram", text: "공통 원고",
  refined: false, createdAt: "T", status: "approved", approvedAt: "T2",
};

describe("textFor", () => {
  it("uses the group text when the room has no override", () => {
    expect(textFor(rendering, undefined)).toEqual({ text: "공통 원고", status: "approved", forked: false });
  });

  it("uses the room's own text and its own status when forked", () => {
    const override = { itemId: "x:1", type: "announcement", outletId: "tg-blockchain", text: "이 방 전용", status: "rendered" as const, createdAt: "T3" };
    expect(textFor(rendering, override)).toEqual({ text: "이 방 전용", status: "rendered", forked: true });
  });

  it("does not inherit the group's approval — a forked room starts unapproved", () => {
    const override = { itemId: "x:1", type: "announcement", outletId: "tg-blockchain", text: "이 방 전용", status: "rendered" as const, createdAt: "T3" };
    expect(rendering.status).toBe("approved");
    expect(textFor(rendering, override).status).toBe("rendered");
  });
});
