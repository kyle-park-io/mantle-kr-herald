/**
 * What the approved translation is rewritten *into* — an audience/purpose, not a transport.
 * The transport is `Channel` (see domain/formatting). One type can go out over several
 * channels, and one channel can carry several types: an `announcement` and a `kol` request
 * both travel over Telegram but are different writing, with different CTA rules.
 *
 * Four of them are Telegram-bound and differ by register, not by destination:
 * `announcement` states what happened, `explainer` works through why it matters and how it
 * behaves, `casual` shares it with the ecosystem, and `kol` is a brief addressed to one
 * creator rather than to a community.
 *
 * `kakao_notice` is the one that differs by destination: the same news as an `announcement`,
 * written for KakaoTalk instead of Telegram. It is a type rather than a second rendering of
 * `announcement` because the two cannot share copy — a KakaoTalk message is always one message
 * capped at 500 characters, against Telegram's 4096, and no amount of formatting folds one into
 * the other. Each type has its own guideline in `conversion/<type>.md`.
 */
export type ConversionType = "x" | "announcement" | "kakao_notice" | "explainer" | "casual" | "kol" | "pr";

export const ALL_TYPES: ConversionType[] = ["x", "announcement", "kakao_notice", "explainer", "casual", "kol", "pr"];

/** One approved translation rewritten for a target item type. Identity is (itemId, type). */
export interface ContentVariant {
  itemId: string; // "x:<rootId>" | "lark:<messageId>" — same id as the translation
  type: ConversionType;
  sourceKorean: string; // the approved translation (input, kept for provenance)
  convertedText: string; // agent-produced, type-specific Korean copy
  status: "converted" | "approved";
  createdAt: string; // ISO
  approvedAt?: string;
}

const LABELS: Record<ConversionType, string> = {
  x: "X",
  announcement: "공지",
  kakao_notice: "카톡 공지",
  explainer: "해설",
  casual: "소통",
  kol: "KOL",
  pr: "PR",
};
export function typeLabel(type: ConversionType): string {
  return LABELS[type];
}
