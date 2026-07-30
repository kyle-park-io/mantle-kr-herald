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
  // Every message lives inside its own `tgme_widget_message_wrap` div; splitting on that
  // boundary lets each block be parsed independently, so one unreadable block cannot lose the
  // rest of the page. The first chunk (before the first boundary) is page chrome, not a message.
  const blocks = html.split(MESSAGE_WRAP_BOUNDARY).slice(1);
  for (const block of blocks) {
    const post = parseBlock(block, handle);
    if (post) posts.push(post);
  }
  return posts;
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
const VIEWS_RE = /<span class="tgme_widget_message_views">([^<]*)<\/span>/;
const REACTIONS_CONTAINER_RE = /<div class="tgme_widget_message_reactions[^"]*"[^>]*>([\s\S]*?)<\/div>/;
const REACTION_ITEM_RE = /<span class="tgme_reaction[^"]*">[\s\S]*?<b>([^<]*)<\/b><\/i>(\d*)<\/span>/g;
const TEXT_RE = /<div class="tgme_widget_message_text js-message_text"[^>]*>([\s\S]*?)<\/div>/;
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
  if (!dataPost || dataPost[1] !== handle) return null;

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
    handle,
    messageId,
    url: `https://t.me/${handle}/${messageId}`,
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
    // A reaction span with no trailing digits counts as 1, which is how the page renders a
    // single reaction in some layouts.
    const count = item[2] ? Number(item[2]) : 1;
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
