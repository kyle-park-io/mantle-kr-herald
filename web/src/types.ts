/** The original tweet URL for an `x:<id>` item, else null (lark items have no public URL). */
export const itemUrl = (itemId: string): string | null =>
  itemId.startsWith("x:") ? `https://x.com/i/status/${itemId.slice(2)}` : null;

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
  failures: { key: string; error: string }[];
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

export interface AppStatus {
  storageMode: StorageMode;
  availableTargets: ("local" | "google" | "lark")[];
  funnel: { collected: number; translated: number; converted: number; rendered: number; published: number };
  sync: { published: number; unsynced: number; stale: number };
}

export interface PublishStateRow {
  itemId: string;
  status: string;
  target: string;
  url?: string;
  remoteId?: string;
  fileName?: string;
}

// Mirrors src/domain/formatting/emitters/types.ts — keep in sync.
export type Destination =
  | "x_paste" | "x_typefully"
  | "telegram_paste" | "telegram_bot"
  | "kakao_paste" | "pr_mail";

export interface EmitSegment {
  text: string;
  label?: string;
  length: number;
  limit: number;
  overLimit: boolean;
}
export interface EmitResult {
  segments: EmitSegment[];
  warnings: string[];
}
export type Emissions = Partial<Record<Destination, EmitResult>>;

export const DESTINATION_LABEL: Record<Destination, string> = {
  x_paste: "X 붙여넣기",
  x_typefully: "Typefully",
  telegram_paste: "텔레그램",
  telegram_bot: "텔레그램 봇",
  kakao_paste: "카카오",
  pr_mail: "메일",
};
