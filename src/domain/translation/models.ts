export type GlossaryRule = "translate" | "transliterate" | "keep";

export interface GlossaryEntry {
  term: string;
  rule: GlossaryRule;
  target?: string;
  note?: string;
  updatedAt: string;
  source?: string;
}

export interface StyleGuide {
  text: string;
}

export interface Locale {
  dateFormat: string;
  numberFormat: string;
  currency: string;
  unit: string;
  honorific: string;
}

export interface FewShotExample {
  source: string;
  target: string;
  itemId?: string;
}

export type TranslationStatus = "translated" | "approved";

export interface Translation {
  itemId: string;
  source: "x" | "lark";
  sourceText: string;
  koreanText: string;
  status: TranslationStatus;
  translatedAt: string;
  approvedAt?: string;
}

export interface SharedContext {
  role: string;
  glossary: GlossaryEntry[];
  styleGuide: StyleGuide;
  locale: Locale;
  fewShots: FewShotExample[];
}
