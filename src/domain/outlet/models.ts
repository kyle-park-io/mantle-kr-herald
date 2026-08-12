import type { Channel } from "../formatting/models";
import type { ConversionType } from "../conversion/models";

/**
 * A delivery room. The third axis, distinct from the other two: `type` is what kind of copy this
 * is, `channel` is what format it takes, `outlet` is where it goes. Two outlets can share a
 * channel (맨틀 한국 커뮤니티 and 맨틀 한국 데브방 are both auto Telegram), which is precisely
 * why the send ledger is keyed by outlet rather than channel.
 *
 * NOT to be confused with `Destination` in domain/formatting/emitters, which is the *spelling* of
 * a channel (`telegram_paste` vs `telegram_bot`), nor with `--target` in `drive:publish`.
 *
 * A room, specifically — not every place copy can end up. The X Articles surface is the same
 * @0xMantleKR account in a different format, fed from the translation by `send:x-article` against
 * its own ledger, and it lives in `domain/publish/xArticleTarget.ts` rather than here. It was in
 * this array until 2026-08-08, which made `outletsForChannel("x")` answer with a room nothing could
 * send to and every consumer filter it back out; see that file for the whole story.
 */
export interface Outlet {
  id: string;
  label: string;
  channel: Channel;
  /** `auto` = a bot/API posts it. `manual` = a human copies the `_paste` text and pastes it. */
  delivery: "auto" | "manual";
  /** Pre-checked rows on the board. Every type stays selectable — this is a default, not a limit. */
  suggestedTypes: ConversionType[];
  /** Name of the env var holding the chat id. Only auto Telegram rooms have one. */
  chatIdEnv?: string;
}

/**
 * A code constant, not configuration: rooms change rarely, and a constant is what lets the
 * invariant tests and the UI labels stay in sync — the same reasoning behind ALL_TYPES.
 * Only the Telegram chat ids live in `.env`.
 */
export const ALL_OUTLETS: Outlet[] = [
  { id: "x-post", label: "@0xMantleKR 포스트", channel: "x", delivery: "auto", suggestedTypes: ["x"] },
  { id: "tg-community", label: "맨틀 한국 커뮤니티", channel: "telegram", delivery: "auto", suggestedTypes: ["announcement", "casual"], chatIdEnv: "TELEGRAM_CHAT_ID_COMMUNITY" },
  { id: "tg-dev", label: "맨틀 한국 데브방", channel: "telegram", delivery: "auto", suggestedTypes: ["announcement", "explainer"], chatIdEnv: "TELEGRAM_CHAT_ID_DEV" },
  // Community rooms before KOL rooms, on both channels: this array's order is the order the board
  // rows a channel's rooms in, and a 공지 goes to the community first — a KOL room is a paid
  // promotion ask, which is a different decision and belongs further down the list.
  { id: "tg-blockchain", label: "텔레그램 블록체인 커뮤니티방", channel: "telegram", delivery: "manual", suggestedTypes: ["announcement"] },
  { id: "tg-kol", label: "텔레그램 KOL방", channel: "telegram", delivery: "manual", suggestedTypes: ["kol", "announcement"] },
  { id: "kakao-blockchain", label: "오픈카톡 블록체인 커뮤니티방", channel: "kakao", delivery: "manual", suggestedTypes: ["kakao_notice"] },
  { id: "kakao-kol", label: "오픈카톡 KOL방", channel: "kakao", delivery: "manual", suggestedTypes: ["kakao_notice"] },
  // `manual` until a mail sender exists: `pr_mail` is not a SendableChannel, so `send:channels`
  // can never reach it, and as `auto` it was also refused by MarkDelivery — permanently
  // undeliverable and permanently unmarkable. Manual is the truth today: a human sends the mail
  // and ticks 전달함. Flip it back to `auto` on the day a mail sender lands.
  { id: "pr-mail", label: "PR 메일", channel: "pr_mail", delivery: "manual", suggestedTypes: ["pr"] },
];

/**
 * Where a legacy `(itemId, type, channel)` ledger row is attributed when re-keyed by outlet.
 * Each is that channel's first room in `ALL_OUTLETS`. These values are load-bearing for already
 * migrated ledgers, so they must NOT be re-derived from the array — reordering rooms later would
 * silently re-attribute history. Change one only with a data migration.
 */
export const PRIMARY_OUTLET_BY_CHANNEL: Record<Channel, string> = {
  x: "x-post",
  telegram: "tg-community",
  kakao: "kakao-blockchain",
  pr_mail: "pr-mail",
};

export function outletById(id: string): Outlet | undefined {
  return ALL_OUTLETS.find((o) => o.id === id);
}

export function outletsForChannel(channel: Channel): Outlet[] {
  return ALL_OUTLETS.filter((o) => o.channel === channel);
}

/**
 * Whether `send:channels` delivers this outlet, i.e. an auto room posted through the channel's
 * `ChannelSender`. Manual rooms are pasted by a human instead.
 *
 * Every room in this registry is now delivered by its channel's sender or by hand, so this is `auto`
 * spelled out. It kept a second clause while the X Articles surface was registered as a room, since
 * that one was `auto` and yet posted by `send:x-article`; the surface moved out
 * (`domain/publish/xArticleTarget.ts`) and the clause went with it. Kept as a named predicate rather
 * than inlined: the call sites ask "does send:channels deliver this?", which is the question that
 * survives the next room being added.
 */
export function deliveredByChannelSender(o: Outlet): boolean {
  return o.delivery === "auto";
}
