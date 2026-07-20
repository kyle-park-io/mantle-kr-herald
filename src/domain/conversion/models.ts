/**
 * What the approved translation is rewritten *into* — an audience/purpose, not a transport.
 * The transport is `Channel` (see domain/formatting). One type can go out over several
 * channels, and one channel can carry several types: an `announcement` and a `kol` request
 * both travel over Telegram but are different writing, with different CTA rules.
 */
export type ConversionType = "x" | "announcement" | "kol" | "pr";

export const ALL_TYPES: ConversionType[] = ["x", "announcement", "kol", "pr"];

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

const LABELS: Record<ConversionType, string> = { x: "X", announcement: "공지", kol: "KOL", pr: "PR" };
export function typeLabel(type: ConversionType): string {
  return LABELS[type];
}
