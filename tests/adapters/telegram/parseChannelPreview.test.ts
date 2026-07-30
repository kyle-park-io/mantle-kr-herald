import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  countMessageBlocks,
  parseChannelPreview,
  parseViewCount,
} from "../../../src/adapters/telegram/parseChannelPreview";
import type { ChannelPost } from "../../../src/domain/kol/models";

/**
 * ─── Refreshing the fixtures ────────────────────────────────────────────────────────────────────
 *
 * The three files in `fixtures/` are real captured `t.me/s/` HTML and they are the parser's whole
 * contract: a Telegram markup change has to break a test here before it breaks a run. Re-capture
 * them like this (they were captured on **2026-07-30**):
 *
 *   UA='Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) \
 *   Chrome/124.0.0.0 Safari/537.36'
 *   curl -sL -A "$UA" 'https://t.me/s/marshallog?before=22800'   -o marshallog-before-22800.html
 *   curl -sL -A "$UA" 'https://t.me/s/enjoymyhobby?before=96565' -o enjoymyhobby-before-96565.html
 *   curl -sL -A "$UA" 'https://t.me/s/Raoni1?before=20920'       -o Raoni1-before-20920.html
 *
 * The `?before=` value is in each filename and is what pins the page to a fixed set of posts; drop
 * it and you capture whatever the channel posted most recently instead. The user-agent matters —
 * t.me serves different markup to clients it does not recognise — and must stay in step with
 * `USER_AGENT` in `src/adapters/telegram/TmePreviewGateway.ts`.
 *
 * **The rule when a fresh capture disagrees with an expectation below: the expectation bends to the
 * fixture, never the reverse.** These files are evidence of what Telegram actually serves. Reactions
 * are revocable and views only grow, so a re-capture legitimately moves those numbers (the design
 * doc records `96560` reading 8 engagements at one moment and 7 at another for exactly this reason).
 * Editing a fixture by hand to keep a number green destroys the only thing it is here to prove.
 */

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

  describe("handle casing", () => {
    // Verified live on 2026-07-30: `GET /s/raoni1` and `GET /s/RAONI1` both answer 200 with
    // `data-post="Raoni1/…"`. t.me resolves a handle case-insensitively and always renders the
    // channel's canonical casing, so a case-sensitive comparison parsed **zero** posts from a
    // perfectly healthy channel — silently. Five of the thirteen seeded handles are mixed-case and a
    // human retypes them by hand.
    it("parses a channel's posts however the requested handle was cased", () => {
      for (const requested of ["Raoni1", "raoni1", "RAONI1", "rAoNi1"]) {
        const posts = parseChannelPreview(fixture("Raoni1-before-20920.html"), requested);
        expect(posts.length, `requested as ${requested}`).toBeGreaterThan(0);
        expect(find(posts, 20914)!.views).toBe(2100);
      }
    });

    it("builds handle and url from the canonical casing, not the requested casing", () => {
      // The permalink is the row identity. If it were built from the requested casing, one human
      // retyping `kol-map` as `raoni1` would mint a different deliverableLink for every post of the
      // channel — a duplicate row per post and a doubled deliverable count. So this and the
      // case-insensitive comparison above are one fix, not two.
      for (const requested of ["Raoni1", "raoni1", "RAONI1"]) {
        const post = find(parseChannelPreview(fixture("Raoni1-before-20920.html"), requested), 20914)!;
        expect(post.handle).toBe("Raoni1");
        expect(post.url).toBe("https://t.me/Raoni1/20914");
      }
    });

    it("still refuses a block belonging to a genuinely different channel", () => {
      // Case-insensitive must not mean lax: a forwarded or reply-quoted message from another channel
      // would invent a deliverable the KOL never posted.
      const posts = parseChannelPreview(fixture("Raoni1-before-20920.html"), "marshallog");
      expect(posts).toEqual([]);
    });
  });

  describe("markup tolerance", () => {
    const wrap = (inner: string) =>
      `<div class="tgme_widget_message_wrap js-widget_message_wrap"><div class="tgme_widget_message" data-post="kolx/7">` +
      `<time datetime="2026-07-10T00:00:00+00:00"></time>${inner}</div></div>`;

    it("reads text and views when Telegram adds or reorders a class", () => {
      // The strict siblings demanded an exact class attribute. An added class made parseText return
      // "" → isMantleCandidate("") is false → the post was DROPPED from the candidate net rather
      // than flagged, which is a missed payment obligation rather than a visible defect.
      const posts = parseChannelPreview(
        wrap(
          `<div class="js-message_text tgme_widget_message_text extra_class" dir="auto">맨틀 소식</div>` +
            `<span class="tgme_widget_message_views newclass">1.4K</span>`,
        ),
        "kolx",
      );
      expect(posts[0]!.text).toBe("맨틀 소식");
      expect(posts[0]!.views).toBe(1400);
    });

    it("does not mistake a reply-quoted message for the post's own text", () => {
      // Real markup: a reply quote is a sibling div whose classes are
      // `tgme_widget_message_text js-message_reply_text`. Tolerating extra classes must not start
      // matching it, or a post would be attributed the text it was replying to.
      const posts = parseChannelPreview(
        wrap(
          `<div class="tgme_widget_message_text js-message_reply_text">quoted stranger</div>` +
            `<div class="tgme_widget_message_text js-message_text" dir="auto">맨틀 본문</div>`,
        ),
        "kolx",
      );
      expect(posts[0]!.text).toBe("맨틀 본문");
    });

    it("reads an abbreviated reaction count instead of dropping the entry", () => {
      // `(\d*)` could match only the "1" of "1.2K" and then failed on `.2K</span>`; the engine
      // backtracked out of the whole span and paired this emoji with the NEXT reaction's count, so
      // the 1,200-reaction entry vanished and engagements undercounted by 1200.
      const posts = parseChannelPreview(
        wrap(
          `<div class="tgme_widget_message_reactions js-message_reactions">` +
            `<span class="tgme_reaction"><i class="emoji"><b>❤</b></i>1.2K</span>` +
            `<span class="tgme_reaction"><i class="emoji"><b>👍</b></i>3</span>` +
            `</div>`,
        ),
        "kolx",
      );
      expect(posts[0]!.reactions).toEqual([
        { emoji: "❤", count: 1200 },
        { emoji: "👍", count: 3 },
      ]);
    });
  });
});

describe("countMessageBlocks", () => {
  it("counts the message blocks of a real page", () => {
    expect(countMessageBlocks(fixture("Raoni1-before-20920.html"))).toBeGreaterThan(0);
  });

  it("is 0 for the contact page a dead handle redirects to", () => {
    // Verified live on 2026-07-30: `GET https://t.me/s/<dead-handle>` answers 302 to
    // `https://t.me/<dead-handle>`, fetch follows it, and that page is a clean HTTP 200 with no
    // message blocks. This counter is the only thing that separates it from "no posts this month".
    expect(countMessageBlocks("<html><body><div class='tgme_page'>contact</div></body></html>")).toBe(0);
    expect(countMessageBlocks("")).toBe(0);
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
