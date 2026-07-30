import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { parseChannelPreview, parseViewCount } from "../../../src/adapters/telegram/parseChannelPreview";
import type { ChannelPost } from "../../../src/domain/kol/models";

const fixture = (name: string) => readFileSync(join(__dirname, "fixtures", name), "utf8");
const find = (posts: ChannelPost[], id: number) => posts.find((p) => p.messageId === id);

describe("parseChannelPreview", () => {
  it("reads the post cross-checked against the sheet's July row for Marine", () => {
    // Sheet Jul. r12 recorded views 2800 / engagements 3 for this link.
    const post = find(parseChannelPreview(fixture("marshallog-before-22800.html"), "marshallog"), 22794);
    expect(post).toBeDefined();
    expect(post!.url).toBe("https://t.me/marshallog/22794");
    expect(post!.postedAt).toBe("2026-07-03T09:14:45.000Z");
    expect(post!.views).toBe(2930); // page served "2.93K"
    expect(post!.reactions).toEqual([
      { emoji: "👍", count: 2 },
      { emoji: "❤", count: 1 },
    ]);
    expect(post!.text).toContain("맨틀");
  });

  it("reads a single-reaction post", () => {
    const post = find(parseChannelPreview(fixture("enjoymyhobby-before-96565.html"), "enjoymyhobby"), 96560);
    expect(post!.views).toBe(3800); // "3.8K"
    expect(post!.reactions).toEqual([{ emoji: "❤", count: 7 }]);
  });

  it("gives an empty reaction list, not undefined, for a post with no reactions", () => {
    const post = find(parseChannelPreview(fixture("Raoni1-before-20920.html"), "Raoni1"), 20914);
    expect(post!.views).toBe(2100); // "2.1K"
    expect(post!.reactions).toEqual([]);
  });

  it("returns posts in document order with ascending message ids", () => {
    const posts = parseChannelPreview(fixture("marshallog-before-22800.html"), "marshallog");
    expect(posts.length).toBeGreaterThan(1);
    const ids = posts.map((p) => p.messageId);
    expect([...ids].sort((a, b) => a - b)).toEqual(ids);
  });

  it("only returns posts belonging to the requested handle", () => {
    const posts = parseChannelPreview(fixture("marshallog-before-22800.html"), "marshallog");
    expect(posts.every((p) => p.handle === "marshallog")).toBe(true);
    expect(posts.every((p) => p.url === `https://t.me/marshallog/${p.messageId}`)).toBe(true);
  });

  it("returns [] for markup with no messages instead of throwing", () => {
    expect(parseChannelPreview("<html><body>nope</body></html>", "marshallog")).toEqual([]);
    expect(parseChannelPreview("", "marshallog")).toEqual([]);
  });

  it("skips a block whose data-post handle differs from the requested handle", () => {
    // A preview page embeds forwarded/reply-quoted messages from other channels. Attributing
    // those to the swept KOL would invent a deliverable the KOL never posted.
    const html = `
      <div class="tgme_widget_message_wrap js-widget_message_wrap"><div class="tgme_widget_message text_not_supported_wrap js-widget_message" data-post="otherchannel/500">
        <div class="tgme_widget_message_text js-message_text" dir="auto">not ours</div>
        <div class="tgme_widget_message_footer compact js-message_footer">
          <span class="tgme_widget_message_views">10</span>
          <span class="tgme_widget_message_meta"><a class="tgme_widget_message_date" href="https://t.me/otherchannel/500"><time datetime="2026-07-01T00:00:00+00:00">00:00</time></a></span>
        </div>
      </div></div>
      <div class="tgme_widget_message_wrap js-widget_message_wrap"><div class="tgme_widget_message text_not_supported_wrap js-widget_message" data-post="marshallog/501">
        <div class="tgme_widget_message_text js-message_text" dir="auto">ours</div>
        <div class="tgme_widget_message_footer compact js-message_footer">
          <span class="tgme_widget_message_views">20</span>
          <span class="tgme_widget_message_meta"><a class="tgme_widget_message_date" href="https://t.me/marshallog/501"><time datetime="2026-07-01T00:00:00+00:00">00:00</time></a></span>
        </div>
      </div></div>
    `;
    const posts = parseChannelPreview(html, "marshallog");
    expect(posts.map((p) => p.messageId)).toEqual([501]);
    expect(posts[0]!.handle).toBe("marshallog");
  });
});

describe("parseViewCount", () => {
  it("keeps a sub-1000 count exact, which is what the page serves", () => {
    expect(parseViewCount("879")).toBe(879);
    expect(parseViewCount("704")).toBe(704);
  });

  it("expands the K and M suffixes the page uses above 1000", () => {
    expect(parseViewCount("2.93K")).toBe(2930);
    expect(parseViewCount("1.4K")).toBe(1400);
    expect(parseViewCount("12K")).toBe(12000);
    expect(parseViewCount("1.2M")).toBe(1200000);
  });

  it("tolerates a thousands separator and surrounding whitespace", () => {
    expect(parseViewCount(" 1 234 ")).toBe(1234);
    expect(parseViewCount("1,234")).toBe(1234);
  });

  it("returns 0 for an absent or unreadable count", () => {
    expect(parseViewCount("")).toBe(0);
    expect(parseViewCount("—")).toBe(0);
  });
});
