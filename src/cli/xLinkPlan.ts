/**
 * The decision `pnpm x:link` makes, as a pure function — what to write when a human names the post
 * a translation was published as.
 *
 * Why the command exists. `x:reconcile` finds a translation's live post by scoring it against the
 * account's timeline, which means it can only ever match a post that timeline actually returns.
 * Measured 2026-08-07 against two real posts (2082062251876561175, 2081658695289831503): both are
 * authored by @0xMantleKR, both are conversation roots, neither is a reply, retweet, quote or
 * community post — and neither appears in `advanced_search`'s raw response, in the `user/last_tweets`
 * timeline, or in X's own search UI. Fetched by id they come back immediately. So the enumeration is
 * incomplete on X's side, and no threshold or wider `--since` can reach them: they are not
 * candidates at all. A human with the url is the only source of that fact, and this is where they
 * put it.
 *
 * Pure: no clock, no I/O, no environment. The CLI fetches, this decides, the same use cases
 * `x:reconcile` already uses do the writing.
 */

import { similarity } from "../domain/kol/attribution";
import { THREAD_TWEET_SEPARATOR } from "../domain/formatting/canonical";
import { parsePostUrl, postUrl, findRootTweet } from "../domain/publish/xReconcile";
import { TRANSLATION_MATCH_AT } from "../domain/publish/xReconcile";
import type { AssembledThread } from "../domain/models";
import type { Translation } from "../domain/translation/models";

export type XLinkPlan =
  | {
      kind: "link";
      itemId: string;
      rootId: string;
      url: string;
      /** The root tweet's own `createdAt` — when the human actually posted it, not now. */
      postedAt: string;
      /** The thread body to store as `publishedText`, joined the way every draft is. */
      text: string;
      score: number;
      /** Reported, never enforced — see `planXLink`'s doc comment. */
      lowScore: boolean;
    }
  | { kind: "already-linked"; itemId: string; rootId: string }
  | { kind: "refuse"; reason: string };

/**
 * A `--post` argument as either a bare id or a url copied from X (which carries a `?s=20` and
 * friends). Anything else returns `undefined` rather than a guess: this argument decides which post
 * a publish-history row will claim, and a wrong guess writes a false record.
 */
export function parsePostArg(arg: string): string | undefined {
  const trimmed = arg.trim();
  if (/^\d+$/.test(trimmed)) return trimmed;
  return parsePostUrl(trimmed)?.rootId;
}

/**
 * Decide what linking `itemId` to `rootId` should write.
 *
 * The score is computed and reported but **never gates the link**. This command exists precisely
 * because the matcher could not find the post; letting its score veto the human would rebuild the
 * wall the command was written to get around. `lowScore` marks a link that scores below
 * `TRANSLATION_MATCH_AT` so the CLI can ask "really this post?" before writing — a pasted url can
 * be the wrong one, and that is a different failure from a matcher being blind.
 *
 * Refusals are for the cases where writing would record something false: no such translation, a
 * post that could not be read back, a post authored by another account (a history row claiming we
 * published someone else's copy), a Lark translation this account never published, and an item
 * already linked to a *different* post — repointing that silently would drop the first match's
 * evidence with nothing recording the change, so it asks for a 되돌리기 first.
 */
export function planXLink(input: {
  translation: Translation | undefined;
  itemId: string;
  rootId: string;
  thread: AssembledThread | undefined;
  handle: string;
}): XLinkPlan {
  const { translation, itemId, rootId, thread, handle } = input;

  if (translation === undefined) {
    return { kind: "refuse", reason: `no translation row for ${itemId} — nothing to link` };
  }
  if (translation.source !== "x") {
    return {
      kind: "refuse",
      reason: `${itemId} is a ${translation.source} translation — @${handle} never published it, so a publish-history row would be false`,
    };
  }
  if (thread === undefined) {
    return {
      kind: "refuse",
      reason: `post ${rootId} could not be read back from the account — check the url, or the post may have been deleted`,
    };
  }

  const root = findRootTweet(thread) ?? thread.tweets[0];
  if (root === undefined) {
    return { kind: "refuse", reason: `post ${rootId} came back with no tweets` };
  }
  if (root.authorUserName.toLowerCase() !== handle.toLowerCase()) {
    return {
      kind: "refuse",
      reason: `post ${rootId} was authored by @${root.authorUserName}, not @${handle} — linking it would record that we published someone else's post`,
    };
  }

  // Already settled. Same post is a no-op worth saying out loud; a different one is a conflict this
  // command will not resolve on its own.
  if (translation.postedUrl !== undefined) {
    const existing = parsePostUrl(translation.postedUrl)?.rootId;
    if (existing === rootId) return { kind: "already-linked", itemId, rootId };
    return {
      kind: "refuse",
      reason:
        `${itemId} is already linked to post ${existing ?? translation.postedUrl}. Press 되돌리기 on the board ` +
        `first if that match was wrong, then run this again — repointing it here would drop that record silently`,
    };
  }

  const text = thread.tweets.map((t) => t.text).join(THREAD_TWEET_SEPARATOR);
  const score = similarity(translation.koreanText, text);

  return {
    kind: "link",
    itemId,
    rootId,
    url: postUrl(handle, rootId),
    postedAt: root.createdAt,
    text,
    score,
    lowScore: score < TRANSLATION_MATCH_AT,
  };
}
