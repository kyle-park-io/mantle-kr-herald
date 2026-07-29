import { describe, expect, it } from "vitest";
import { CHANNEL_RENDERS_BOLD, emitAll } from "../../../src/domain/formatting/emitters";
import { ALL_CHANNELS } from "../../../src/domain/formatting/models";

/**
 * `CHANNEL_RENDERS_BOLD` is a hand-written constant that `FormatVariants` uses to decide whether a
 * channel's stored text keeps its `**` markers. Nothing in the type system ties it to what the
 * emitters do, so this runs them: if the constant ever disagrees with reality, either a kakao card
 * grows asterisks that can never render, or a Telegram 공지 quietly loses the bold on its title.
 */
describe("CHANNEL_RENDERS_BOLD", () => {
  it("matches what the channel's emitters actually do with bold", () => {
    for (const channel of ALL_CHANNELS) {
      const kept = Object.values(emitAll("**강조**", channel)).some((r) =>
        r.segments.some((s) => /<b>강조<\/b>|\*\*강조\*\*/.test(s.text)),
      );
      expect(CHANNEL_RENDERS_BOLD[channel], `bold on ${channel}`).toBe(kept);
    }
  });

  it("covers every channel, and no more", () => {
    expect(Object.keys(CHANNEL_RENDERS_BOLD).sort()).toEqual([...ALL_CHANNELS].sort());
  });

  /** The one channel that keeps it — pinned so a Telegram regression is named, not just counted. */
  it("keeps bold on telegram and drops it everywhere else", () => {
    expect(CHANNEL_RENDERS_BOLD.telegram).toBe(true);
    expect([CHANNEL_RENDERS_BOLD.x, CHANNEL_RENDERS_BOLD.kakao, CHANNEL_RENDERS_BOLD.pr_mail]).toEqual([false, false, false]);
  });
});
