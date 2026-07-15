export type ConversionType = "x" | "kol" | "pr";

export const ALL_TYPES: ConversionType[] = ["x", "kol", "pr"];

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

const LABELS: Record<ConversionType, string> = { x: "X", kol: "KOL", pr: "PR" };
export function typeLabel(type: ConversionType): string {
  return LABELS[type];
}
