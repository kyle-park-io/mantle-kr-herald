import { MD_LINK } from "./canonical";

/**
 * Spell out the X profile behind a bare `@handle`, for destinations where `@` means something else.
 *
 * On X a mention is already a link to the profile. On Telegram the same characters are a **Telegram
 * username**: the client resolves `@RWA_xyz` against its own directory and lands the reader on a
 * different service's account, or on nothing at all. Every Telegram-bound rendering in production
 * on 2026-08-18 carried at least one of `@SolanaConf`, `@RWA_xyz`, `@OpenstockInc`, and none of
 * them could be followed to the account the copy was actually crediting.
 *
 * **Emits markdown, not a finished link.** The two Telegram destinations need different shapes —
 * `<a href>` for the bot, `@handle (url)` for the paste path — and `canonical.ts` already converts
 * `[label](url)` into both (`linksToLabel` + the HTML pass, and `linksToPlain`). Producing markdown
 * here means this module never learns which destination asked, and the length each destination
 * reports keeps falling out of the same helpers: the bot still counts `@handle`, since that is all
 * its reader sees, while the paste path counts the url it really pasted.
 *
 * Called by the Telegram emitters only. The x channel is deliberately not a caller — see
 * `tests/domain/formatting/emitters/x.test.ts`.
 */

/**
 * A mention as X itself defines one: 1–15 characters of `[A-Za-z0-9_]`.
 *
 * The lookbehind is the whole safety story, and each alternative is a real string this pipeline
 * carries. `\w` rejects an email local part (`press@mantle.xyz` — collected copy has press contacts
 * in it). `/` rejects a path segment (`https://example.com/@handle`). `@` rejects the second `@` of
 * a doubled one. The trailing boundary is `[^A-Za-z0-9_]`, not `\b`, so a Korean particle glued
 * straight onto the handle — `@SolanaConf와`, the normal shape in this copy — ends the match at
 * `와` instead of swallowing it: `\b` sits between `f` and `와` too, but only because Hangul is not
 * a word character to a non-unicode regex, and relying on that would break the day someone writes
 * `@handle_와`.
 */
const HANDLE = /(?<![\w/@])@([A-Za-z0-9_]{1,15})(?![A-Za-z0-9_])/g;

const PROFILE_PREFIX = "https://x.com/";

/**
 * Split on markdown links so the substitution below only ever sees the prose between them.
 *
 * A handle already inside `[@RWA_xyz](https://x.com/RWA_xyz)` must survive untouched in both
 * halves: linking the label again would nest links, and the url half contains the handle too. This
 * is why the pass cannot be a single `String.replace` over the whole text.
 */
function splitOnLinks(text: string): { chunk: string; isLink: boolean }[] {
  const parts: { chunk: string; isLink: boolean }[] = [];
  let last = 0;
  // `MD_LINK` is a shared module-level regex with `g`, so its `lastIndex` is shared state. A local
  // copy keeps a caller mid-iteration elsewhere from seeing this loop move the cursor.
  const links = new RegExp(MD_LINK.source, "g");
  for (let m = links.exec(text); m !== null; m = links.exec(text)) {
    if (m.index > last) parts.push({ chunk: text.slice(last, m.index), isLink: false });
    parts.push({ chunk: m[0], isLink: true });
    last = m.index + m[0].length;
  }
  if (last < text.length) parts.push({ chunk: text.slice(last), isLink: false });
  return parts;
}

/**
 * Rewrite the **first** mention of each handle as `[@handle](https://x.com/handle)`.
 *
 * First only, because a tag repeated three times would otherwise carry the same url three times,
 * and on the paste path that url is 30-odd visible characters of noise each time. Later mentions
 * read as what they are — a reference back to the one already introduced.
 *
 * Handles are compared case-insensitively because X usernames are: `@RWA_xyz` and `@rwa_xyz` are
 * one account, and linking both would be the same repetition wearing different capitals. The link
 * that does get written preserves the capitalisation the author used — `x.com` resolves either, and
 * the copy should read the way it was written.
 */
export function linkXHandles(text: string): string {
  const seen = new Set<string>();
  return splitOnLinks(text)
    .map(({ chunk, isLink }) => {
      // A hand-written link is what introduced that account, so it claims the handle before any
      // bare mention downstream can. Skipping this would put the same url on screen twice, which
      // is the repetition the first-only rule exists to prevent.
      if (isLink) {
        for (const m of chunk.matchAll(HANDLE)) seen.add(m[1]!.toLowerCase());
        return chunk;
      }
      return chunk.replace(HANDLE, (match, handle: string) => {
        const key = handle.toLowerCase();
        if (seen.has(key)) return match;
        seen.add(key);
        return `[@${handle}](${PROFILE_PREFIX}${handle})`;
      });
    })
    .join("");
}
