export interface Translation {
  itemId: string;
  source: "x" | "lark";
  sourceText: string;
  koreanText: string;
  status: "translated" | "approved";
  translatedAt: string;
  approvedAt?: string;
}
export interface PublishResult {
  uploaded: number;
  updated: number;
  failed: number;
  byDrive: Record<string, number>;
}

// Mirrors src/domain/conversion/models.ts — keep in sync.
export type ConversionType = "x" | "announcement" | "kol" | "pr";
export type Channel = "x" | "telegram" | "kakao" | "pr_mail";

export interface Rendering {
  itemId: string;
  type: ConversionType;
  channel: Channel;
  text: string;
  refined: boolean;
  createdAt: string;
  status: "rendered" | "approved";
  approvedAt?: string;
  convertedText: string; // joined source context (variant convertedText)
}

/** Stable identity key for a rendering: (itemId, type, channel). */
export const renderingKey = (r: Pick<Rendering, "itemId" | "type" | "channel">) =>
  `${r.itemId}:${r.type}:${r.channel}`;

// Mirrors src/storage/mode.ts — keep in sync.
export type StorageMode = "local" | "cloud";

export interface AppConfig {
  storageMode: StorageMode;
}
