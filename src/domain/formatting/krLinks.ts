/**
 * Rewrite a Mantle Global (`@Mantle_Official`) post link inside a translation's `x` copy into the
 * matching @0xMantleKR post, so a Korean reader who follows an inline link stays on the Korean
 * account instead of landing back on the English original.
 *
 * Only `x` copy carries this problem. The other rendered types (`announcement`, `kakao_notice`,
 * `explainer`, `casual`, `kol`, `pr`) are written by us, not translated near-verbatim from a source
 * tweet, so they never inherit a source post's inline links in the first place.
 *
 * This module is split into two pure stages — **find** (`linkedSweptItemIds`) and **swap**
 * (`rewriteGlobalLinks`) — on purpose, with link resolution (itemId → Korean url) left entirely to
 * the caller. That resolution is asynchronous in one caller and synchronous in the other:
 * `/emissions`'s preview resolves through `deps.loadXPostUrl` (a DB read), while `SendChannels`
 * already has the whole run's delivery rows in memory and can look a url up synchronously. If this
 * module tried to resolve links itself it would have to either force both callers onto one calling
 * convention or carry two resolution paths internally — either way the two pure halves (extract,
 * substitute) would stop being pure. Splitting them lets each call site plug in its own resolution
 * between the two calls and keeps both halves testable without a DB or a mock clock.
 */

import { parsePostUrl } from "../publish/xReconcile";
import { isSweptAccount } from "../sweptAccount";

/**
 * Candidate post status URLs in a body of text. Deliberately loose on scheme and host — wider than
 * `parsePostUrl` accepts — because the two are answering different questions. `parsePostUrl` proves a
 * url is byte-for-byte one `postUrl()` (this codebase) wrote, so it only ever accepts `https://x.com`
 * (`xReconcile.test.ts`'s "fails on a lookalike host" case asserts exactly that, on purpose). This
 * regex instead has to recognize a link as it arrives in *collected* source tweet text, which is not
 * under this codebase's control and is documented to vary on both axes it stays loose on:
 *
 * - **scheme** — `docs/superpowers/specs/2026-07-28-tco-url-expansion-design.md` records that
 *   `expandUrls` deliberately leaves `expanded_url`'s scheme exactly as the API returned it,
 *   including a live-verified `http://x.com/i/article/<id>` (pinned by
 *   `tests/adapters/twitterapi/expandUrls.test.ts`); rewriting another party's scheme was
 *   explicitly ruled out of scope there.
 * - **host** — the same non-normalization policy leaves `twitter.com` links as collected;
 *   `tests/adapters/schemas.test.ts` (the quoted-tweet dedup cases) already carries a literal
 *   `https://twitter.com/.../status/999` in tweet text as a legitimate value.
 *
 * A candidate that matches here is not yet trusted — see `normalizeToPostUrl`, which is the other
 * half of this split. Matching loosely here and letting `parsePostUrl` own the strict shape (after
 * normalization) means this file never carries a second, competing definition of what a post URL is;
 * it only ever widens the *front door* into that one definition.
 */
const X_STATUS_URL = /https?:\/\/(?:www\.)?(?:x|twitter)\.com\/[A-Za-z0-9_]+\/status\/\d+/gi;

/**
 * Canonicalize a matched candidate's scheme and host to the exact `https://x.com/` `parsePostUrl`
 * requires, leaving the handle/status/id segment untouched — deciding whether *that* part is
 * well-formed is `parsePostUrl`'s job, not this module's. Scheme and host are the only two axes
 * `X_STATUS_URL` was widened on (see its comment), so they are the only two this rewrites; forking
 * or loosening `parsePostUrl` itself is deliberately not the fix, since other callers
 * (`xReconcile.ts`'s settle path) depend on its stricter round-trip guarantee.
 */
function normalizeToPostUrl(candidate: string): { handle: string; rootId: string } | undefined {
  const canonical = candidate.replace(/^https?:\/\/(?:www\.)?(?:x|twitter)\.com\//i, "https://x.com/");
  return parsePostUrl(canonical);
}

/** Only `x` copy is a near-verbatim translation, so only it carries the source's inline links. */
export function needsKrLinkRewrite(type: string): boolean {
  return type === "x";
}

/**
 * The itemIds of every Mantle Global post `text` links to, `x:<rootId>`-shaped to match how the rest
 * of the codebase names an X source item (see `xReconcile.ts`'s `kr:`/`x:` id convention). Only links
 * to `SWEPT_ACCOUNT` count — a link to any other account, including our own @0xMantleKR, is not a
 * candidate for this rewrite, because there is no "Korean version" of a post that was never English
 * source copy to begin with.
 *
 * Deduped, first-seen order: the caller resolves each id at most once and reports it at most once
 * (`krLinkNotice`'s count), so a post linked twice in one body must not cost two lookups or count as
 * two unresolved links.
 */
export function linkedSweptItemIds(text: string): string[] {
  const seen = new Set<string>();
  const ids: string[] = [];

  for (const match of text.matchAll(X_STATUS_URL)) {
    const parsed = normalizeToPostUrl(match[0]);
    if (parsed === undefined || !isSweptAccount(parsed.handle)) continue;

    const itemId = `x:${parsed.rootId}`;
    if (seen.has(itemId)) continue;
    seen.add(itemId);
    ids.push(itemId);
  }

  return ids;
}

/**
 * Swap every Mantle Global post link in `text` for the Korean account's url, given a map the caller
 * already resolved (`linkedSweptItemIds`'s output, itemId → Korean url). A link with no entry in the
 * map — the Korean post does not exist yet — is left exactly as written; it is not this function's
 * call to invent a placeholder or fail the rendering over it (`krLinkNotice` is how the gap gets
 * reported to a human instead).
 *
 * `unresolved` counts **distinct link targets**, not occurrences: the same unresolved link appearing
 * twice in `text` is one missing Korean post, not two, so a Set collects itemIds rather than a plain
 * counter incrementing per match.
 */
export function rewriteGlobalLinks(
  text: string,
  krUrlByItemId: ReadonlyMap<string, string>,
): { text: string; unresolved: number } {
  const unresolved = new Set<string>();

  const rewritten = text.replace(X_STATUS_URL, (match) => {
    const parsed = normalizeToPostUrl(match);
    if (parsed === undefined || !isSweptAccount(parsed.handle)) return match;

    const itemId = `x:${parsed.rootId}`;
    const krUrl = krUrlByItemId.get(itemId);
    if (krUrl === undefined) {
      unresolved.add(itemId);
      return match;
    }
    return krUrl;
  });

  return { text: rewritten, unresolved: unresolved.size };
}

/**
 * Operator-facing note for a rendering that still points at one or more un-rewritten Mantle Global
 * links, or `null` when nothing is left to say. Names the remedy, not just the problem — the fix is
 * always "translate and publish the linked post first", never something this rendering's own author
 * can do — because the same source post going up on @0xMantleKR later re-resolves the link
 * automatically (see this module's header) without anyone editing this copy by hand.
 */
export function krLinkNotice(unresolved: number): string | null {
  return unresolved === 0
    ? null
    : `링크된 글로벌 글 ${unresolved}건은 아직 한국 글이 없습니다. 먼저 올리면 자동으로 한국 링크가 됩니다.`;
}
