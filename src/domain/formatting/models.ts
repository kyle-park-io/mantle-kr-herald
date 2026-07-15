import type { ConversionType } from "../conversion/models";

export type Channel = "x" | "telegram" | "kakao" | "pr_mail";

export const ALL_CHANNELS: Channel[] = ["x", "telegram", "kakao", "pr_mail"];

export const DEFAULT_CHANNELS_BY_TYPE: Record<ConversionType, Channel[]> = {
  x: ["x", "kakao"],
  kol: ["telegram"],
  pr: ["pr_mail"],
};

export interface FormatOptions {
  xBold?: "plain" | "unicode";
}

export interface FormatResult {
  text: string;
  warnings: string[];
}

/** One converted variant formatted for a specific channel. Identity is (itemId, type, channel). */
export interface ChannelRendering {
  itemId: string;
  type: ConversionType;
  channel: Channel;
  text: string;
  refined: boolean; // false = code formatter only; true = agent-refined
  createdAt: string;
}
