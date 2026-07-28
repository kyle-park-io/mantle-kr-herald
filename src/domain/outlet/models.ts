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
  /**
   * Which pipeline delivers an `auto` outlet. `"channel"` (the default) = `send:channels` posts it
   * through the channel's `ChannelSender`. `"x-article"` = `send:x-article` posts it from the
   * translation rather than from a `ChannelRendering`, against its own ledger — so `send:channels`
   * must skip it, or one approved `x` rendering goes out on the account twice. Ignored when
   * `delivery` is `manual`.
   */
  autoPipeline?: "channel" | "x-article";
}

/**
 * A code constant, not configuration: rooms change rarely, and a constant is what lets the
 * invariant tests and the UI labels stay in sync — the same reasoning behind ALL_TYPES.
 * Only the Telegram chat ids live in `.env`.
 */
export const ALL_OUTLETS: Outlet[] = [
  { id: "x-post", label: "@0xMantleKR 포스트", channel: "x", delivery: "auto", suggestedTypes: ["x"] },
  { id: "x-article", label: "@0xMantleKR 아티클", channel: "x", delivery: "auto", suggestedTypes: [], autoPipeline: "x-article" },
  { id: "tg-community", label: "맨틀 한국 커뮤니티", channel: "telegram", delivery: "auto", suggestedTypes: ["announcement", "casual"], chatIdEnv: "TELEGRAM_CHAT_ID_COMMUNITY" },
  { id: "tg-dev", label: "맨틀 한국 데브방", channel: "telegram", delivery: "auto", suggestedTypes: ["announcement", "explainer"], chatIdEnv: "TELEGRAM_CHAT_ID_DEV" },
  { id: "tg-kol", label: "텔레그램 KOL방", channel: "telegram", delivery: "manual", suggestedTypes: ["kol", "announcement"] },
  { id: "tg-blockchain", label: "한국 블록체인 커뮤니티방", channel: "telegram", delivery: "manual", suggestedTypes: ["announcement"] },
  { id: "kakao-kol", label: "오픈카톡 KOL방", channel: "kakao", delivery: "manual", suggestedTypes: ["announcement"] },
  { id: "kakao-blockchain", label: "오픈카톡 블록체인 커뮤니티방", channel: "kakao", delivery: "manual", suggestedTypes: ["announcement"] },
  { id: "pr-mail", label: "PR 메일", channel: "pr_mail", delivery: "auto", suggestedTypes: ["pr"] },
];

/**
 * Where a legacy `(itemId, type, channel)` ledger row is attributed when re-keyed by outlet.
 * The two kakao rooms are interchangeable for this purpose, so `kakao-blockchain` is an
 * arbitrary but fixed choice — recorded here so a later reader does not look for meaning in it.
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
 * `ChannelSender`. Manual rooms are pasted by a human, and `x-article` is posted by `send:x-article`
 * from the translation against its own ledger — sending it here too would post the copy twice.
 */
export function deliveredByChannelSender(o: Outlet): boolean {
  return o.delivery === "auto" && (o.autoPipeline ?? "channel") === "channel";
}
