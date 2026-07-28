/**
 * What the approved translation is rewritten *into* — an audience/purpose, not a transport.
 * The transport is `Channel` (see domain/formatting). One type can go out over several
 * channels, and one channel can carry several types: an `announcement` and a `kol` request
 * both travel over Telegram but are different writing, with different CTA rules.
 *
 * The four Telegram-bound types differ by register, not by destination:
 * `announcement` states what happened, `explainer` works through why it matters and how it
 * behaves, `casual` shares it with the ecosystem, and `kol` is a brief addressed to one
 * creator rather than to a community. Each has its own guideline in `conversion/<type>.md`.
 */
export type ConversionType = "x" | "announcement" | "explainer" | "casual" | "kol" | "pr";

export const ALL_TYPES: ConversionType[] = ["x", "announcement", "explainer", "casual", "kol", "pr"];

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
  explainer: "해설",
  casual: "소통",
  kol: "KOL",
  pr: "PR",
};
export function typeLabel(type: ConversionType): string {
  return LABELS[type];
}
