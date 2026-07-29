import { outletById } from "../outlet/models";

/** A row already carries its final x.com url once reconciled. */
export const isXUrl = (url?: string): boolean => !!url && url.includes("x.com");

/**
 * The room was sent to, but what the ledger holds is a *scheduled Typefully draft*, not a live post.
 *
 * X refuses to direct-publish a draft containing a URL, so every X send goes through Typefully's
 * queue a couple of minutes out. Until `ReconcilePublished` looks the draft up, the row's `postId`
 * is a Typefully draft id, its `url` is empty, and its `at` is the moment we *scheduled* it — so a
 * board that renders it as a plain `발송됨` with a timestamp is telling the operator something that
 * has not happened yet, with no link to check.
 *
 * Telegram publishes immediately and comes back with a `t.me` url, so only X rooms are ever in this
 * state.
 */
/** A type predicate, so a caller that reconciles the row does not have to re-assert its `postId`. */
export function awaitingPublish<T extends { outletId: string; status: string; url?: string; postId?: string }>(
  row: T,
): row is T & { postId: string } {
  return (
    row.status === "sent" &&
    outletById(row.outletId)?.channel === "x" &&
    !isXUrl(row.url) &&
    !!row.postId
  );
}

/**
 * An article ledger row holds a scheduled Typefully draft id and no `x.com` url: it is still waiting
 * to be published.
 *
 * A row carrying `droppedAt` is retired — its draft was deleted before it published, so it is no
 * longer waiting on anything and must not count as in-flight.
 *
 * Used by `ReconcilePublished` (to fetch and store the published url) and the headroom count
 * (to estimate how many articles are in flight).
 */
/** A type predicate, so a caller that reconciles the row does not have to re-assert its `postId`. */
export function awaitingArticlePublish<T extends { url?: string; postId?: string; droppedAt?: string }>(
  row: T,
): row is T & { postId: string } {
  return !isXUrl(row.url) && !!row.postId && !row.droppedAt;
}
