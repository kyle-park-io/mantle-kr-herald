import { describe, it, expect } from "vitest";
import { telegramMatchCandidates } from "../../src/app/telegramMatchCandidates";
import type { ChannelRendering } from "../../src/domain/formatting/models";

// `refined` and `createdAt` are required on ChannelRendering, and `status` is only
// "rendered" | "approved" — `pnpm typecheck` covers tests/, so the shape must be exact.
const rendering = (over: Partial<ChannelRendering>): ChannelRendering => ({
  itemId: "a",
  type: "announcement",
  channel: "telegram",
  text: "맨틀 공지",
  refined: false,
  createdAt: "2026-07-29T00:00:00.000Z",
  status: "approved",
  ...over,
});

describe("telegramMatchCandidates", () => {
  it("keeps approved Telegram-channel copy only", () => {
    const out = telegramMatchCandidates([
      rendering({ itemId: "a" }),
      rendering({ itemId: "b", type: "x", channel: "x", text: "mantle post" }),
      rendering({ itemId: "c", text: "초안", status: "rendered" }),
    ]);
    expect(out).toEqual([{ itemId: "a", text: "맨틀 공지" }]);
  });

  it("drops a rendering with empty text, which can never match", () => {
    expect(telegramMatchCandidates([rendering({ type: "kol", text: "" })])).toEqual([]);
  });

  it("returns [] for no renderings, so a July sweep still runs", () => {
    expect(telegramMatchCandidates([])).toEqual([]);
  });
});
