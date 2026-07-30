import type { ChannelPost } from "../../domain/kol/models";

/**
 * Parse a public Telegram channel preview page (`https://t.me/s/<handle>[?before=N]`) into
 * `ChannelPost`s. This is the only file in the system that knows Telegram's HTML; everything
 * downstream consumes `ChannelPost[]` and never sees markup.
 *
 * Pure: no `fetch`, no `fs`, no clock. Never throws on malformed markup — a block it cannot
 * read is skipped rather than aborting the whole page.
 *
 * A preview page also embeds forwarded and reply-quoted messages from *other* channels. Each
 * message block is split independently and carries its own `data-post="<handle>/<id>"`; a block
 * whose handle does not match the requested one is skipped, so those foreign messages never get
 * attributed to the KOL being swept.
 */
export function parseChannelPreview(html: string, handle: string): ChannelPost[] {
  const posts: ChannelPost[] = [];
  for (const block of messageBlocks(html)) {
    const post = parseBlock(block, handle);
    if (post) posts.push(post);
  }
  return posts;
}

/**
 * How many message blocks the page contains at all, regardless of which channel they belong to or
 * whether they parse.
 *
 * This is the difference between "the channel posted nothing in the window" and "there is no
 * channel here to read". A deleted, renamed, or preview-disabled handle does **not** produce an
 * HTTP error: `GET https://t.me/s/<dead-handle>` answers **302** to `https://t.me/<dead-handle>`,
 * `fetch` follows that by default, and the contact page it lands on is a perfectly good **HTTP
 * 200** with zero message blocks. Verified live on 2026-07-30. Without this counter the gateway
 * takes its "nothing left to page through" exit and the channel is reported as swept clean.
 */
export function countMessageBlocks(html: string): number {
  return messageBlocks(html).length;
}

/**
 * Every message lives inside its own `tgme_widget_message_wrap` div; splitting on that boundary
 * lets each block be parsed independently, so one unreadable block cannot lose the rest of the
 * page. The first chunk (before the first boundary) is page chrome, not a message.
 */
function messageBlocks(html: string): string[] {
  return html.split(MESSAGE_WRAP_BOUNDARY).slice(1);
}

/**
 * Telegram's compact view-count text ("879", "2.93K", "1.2M") to a plain integer. Exported for
 * its own test since the fixtures happen not to cover every boundary (absent count, thousands
 * separators).
 */
export function parseViewCount(raw: string): number {
  const cleaned = raw.trim().replace(/[\s,]/g, "");
  if (!cleaned) return 0;
  const match = VIEW_COUNT_RE.exec(cleaned);
  if (!match) return 0;
  const num = Number.parseFloat(match[1]);
  if (Number.isNaN(num)) return 0;
  const suffix = match[2].toUpperCase();
  const multiplier = suffix === "K" ? 1_000 : suffix === "M" ? 1_000_000 : 1;
  return Math.round(num * multiplier);
}

const MESSAGE_WRAP_BOUNDARY = /<div class="tgme_widget_message_wrap js-widget_message_wrap">/;
const DATA_POST_RE = /data-post="([^"/]+)\/(\d+)"/;
const TIME_RE = /<time datetime="([^"]+)"/;
// `[^"]*` on both sides of the class name, matching REACTIONS_CONTAINER_RE below: Telegram
// appending or reordering a class must not make a post's views unreadable (which would silently
// record 0) or its text unreadable (which would silently drop the post from the candidate net
// entirely, since `isMantleCandidate("")` is false — a missed payment obligation, not a flagged
// row). The two class tokens are still both required, and required as whole tokens, so this
// cannot start matching the sibling `tgme_widget_message_text js-message_reply_text` div that
// carries a *quoted* message rather than this post's own text.
const VIEWS_RE = /<span class="[^"]*\btgme_widget_message_views\b[^"]*"[^>]*>([^<]*)<\/span>/;
const REACTIONS_CONTAINER_RE = /<div class="tgme_widget_message_reactions[^"]*"[^>]*>([\s\S]*?)<\/div>/;
// The count is `([^<]*)`, not `(\d*)`: above 1,000 the page abbreviates it ("1.2K"), and `(\d*)`
// could only match the "1" before failing on `.2K</span>`. The engine then backtracked out of the
// whole span and paired *this* reaction's emoji with the **next** reaction's count — so the
// 1,200-reaction entry vanished and `engagements` undercounted by 1200. The captured text goes
// through `parseViewCount`, which already handles the same abbreviation for views.
const REACTION_ITEM_RE = /<span class="tgme_reaction[^"]*">[\s\S]*?<b>([^<]*)<\/b><\/i>([^<]*)<\/span>/g;
const TEXT_RE =
  /<div class="(?=[^"]*\btgme_widget_message_text\b)(?=[^"]*\bjs-message_text\b)[^"]*"[^>]*>([\s\S]*?)<\/div>/;
const VIEW_COUNT_RE = /^(\d+(?:\.\d+)?)([KM]?)$/i;
const BR_RE = /<br\s*\/?>/gi;
const TAG_RE = /<[^>]+>/g;
const ENTITY_RE = /&(#x[0-9a-fA-F]+|#\d+|[a-zA-Z]+);/g;
const NAMED_ENTITIES: Record<string, string> = {
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
  nbsp: " ",
};

function parseBlock(block: string, handle: string): ChannelPost | null {
  const dataPost = DATA_POST_RE.exec(block);
  if (!dataPost) return null;

  // t.me resolves a handle case-insensitively but always renders the channel's *canonical* casing
  // in `data-post`: verified live on 2026-07-30, `GET /s/raoni1` and `GET /s/RAONI1` both answer
  // with `data-post="Raoni1/…"`. So the comparison has to be case-insensitive — a case-sensitive
  // one made a `kol-map` cell reading `raoni1` parse zero posts from a perfectly healthy channel,
  // silently, and five of the thirteen seeded handles are mixed-case.
  //
  // The canonical handle is then what the permalink is built from, **not** the requested one, and
  // the two halves of that are one fix, not two: matching case-insensitively while still building
  // the URL from the requested casing would mint a different `deliverableLink` for every post of a
  // channel the moment a human retyped its handle differently — a duplicate row per post and a
  // doubled deliverable count. `deliverableLink` is the row identity, so it must not depend on how
  // the handle was typed.
  const canonicalHandle = dataPost[1];
  if (canonicalHandle.toLowerCase() !== handle.toLowerCase()) return null;

  const messageId = Number(dataPost[2]);
  if (!Number.isInteger(messageId)) return null;

  // An undated post cannot be placed in a month window downstream, so it is skipped rather
  // than defaulted to some fetch-time clock the parser is not allowed to touch.
  const timeMatch = TIME_RE.exec(block);
  if (!timeMatch) return null;
  const parsedDate = new Date(timeMatch[1]);
  if (Number.isNaN(parsedDate.getTime())) return null;

  const viewsMatch = VIEWS_RE.exec(block);
  const views = parseViewCount(viewsMatch ? viewsMatch[1] : "");

  return {
    handle: canonicalHandle,
    messageId,
    url: `https://t.me/${canonicalHandle}/${messageId}`,
    postedAt: parsedDate.toISOString(),
    views,
    reactions: parseReactions(block),
    text: parseText(block),
  };
}

function parseReactions(block: string): { emoji: string; count: number }[] {
  const container = REACTIONS_CONTAINER_RE.exec(block);
  if (!container) return [];
  const reactions: { emoji: string; count: number }[] = [];
  for (const item of container[1].matchAll(REACTION_ITEM_RE)) {
    const emoji = unescapeEntities(item[1]);
    // A reaction span with no trailing count renders as 1, which is how the page shows a single
    // reaction in some layouts. Anything else goes through parseViewCount so "1.2K" is 1200 rather
    // than a dropped entry.
    const raw = item[2].trim();
    const count = raw === "" ? 1 : parseViewCount(raw);
    reactions.push({ emoji, count });
  }
  return reactions;
}

function parseText(block: string): string {
  const match = TEXT_RE.exec(block);
  if (!match) return ""; // photo-only post: no text element at all
  const withNewlines = match[1].replace(BR_RE, "\n");
  const withoutTags = withNewlines.replace(TAG_RE, "");
  return unescapeEntities(withoutTags).trim();
}

function unescapeEntities(raw: string): string {
  return raw.replace(ENTITY_RE, (whole, entity: string) => {
    if (entity[0] === "#") {
      const codePoint =
        entity[1] === "x" || entity[1] === "X" ? Number.parseInt(entity.slice(2), 16) : Number.parseInt(entity.slice(1), 10);
      return Number.isNaN(codePoint) ? whole : String.fromCodePoint(codePoint);
    }
    return NAMED_ENTITIES[entity] ?? whole;
  });
}
