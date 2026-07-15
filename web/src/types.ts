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
  failed: number;
  byDrive: Record<string, number>;
}

export type ConversionType = "x" | "kol" | "pr";
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
