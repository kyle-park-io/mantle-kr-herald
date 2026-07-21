import type { ConversionType } from "../conversion/models";

export type Channel = "x" | "telegram" | "kakao" | "pr_mail";

export const ALL_CHANNELS: Channel[] = ["x", "telegram", "kakao", "pr_mail"];

/**
 * Which transports each conversion type goes out over. Not a 1:1 mapping by design —
 * an `announcement` is written once and carried by both Telegram and KakaoTalk, while
 * Telegram also carries `kol` requests, which are different copy entirely.
 */
export const DEFAULT_CHANNELS_BY_TYPE: Record<ConversionType, Channel[]> = {
  x: ["x"],
  announcement: ["telegram", "kakao"],
  kol: ["telegram"],
  pr: ["pr_mail"],
};

/** One converted variant formatted for a specific channel. Identity is (itemId, type, channel). */
export interface ChannelRendering {
  itemId: string;
  type: ConversionType;
  channel: Channel;
  text: string;
  refined: boolean; // false = canonical, untouched; true = agent/human edited
  createdAt: string;
  status: "rendered" | "approved"; // §7 second-review approval gate
  approvedAt?: string;
}
