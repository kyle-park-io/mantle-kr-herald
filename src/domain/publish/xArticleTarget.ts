/**
 * The X Articles surface on @0xMantleKR — deliberately NOT an `Outlet`.
 *
 * An outlet (`src/domain/outlet/models.ts`) is a delivery room: a place one `(itemId, type)`
 * rendering is sent to, keyed in the delivery ledger by `(itemId, type, outletId)`, chosen on the
 * 2차 검수 board. The article surface is none of that. It is the same X account published in a
 * different format, fed straight from the translation by `send:x-article` (`SendXArticle`), keyed
 * by `itemId` alone in its own ledger — there is no `type`, so the delivery ledger's key does not
 * even fit it.
 *
 * It used to sit in `ALL_OUTLETS` anyway, which made `outletsForChannel("x")` answer with two
 * "rooms" and forced every consumer to filter it back out. The board did (a `reachable` predicate,
 * removed with this file's arrival), and its footer still told reviewers that "이 채널의 모든 방이
 * 이미 올라와 있습니다" while a supposed room sat hidden — the confusion that prompted this split.
 *
 * `drive:publish` and `lark:send` are the company this belongs in: publish targets fed by the
 * translation, living outside the room registry. The id is kept verbatim because it is what the
 * CLIs accept and what `output/publish/x-article.json` has always been named.
 */
export const X_ARTICLE_TARGET = {
  id: "x-article",
  label: "@0xMantleKR 아티클",
  /** What to tell an operator who aimed a room-shaped command at it. */
  sentBy: "pnpm send:x-article",
} as const;

/** Whether an operator-supplied id names the article surface rather than a room. */
export const isXArticleTarget = (id: string): boolean => id === X_ARTICLE_TARGET.id;
