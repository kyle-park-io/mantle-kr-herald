import type { Locale, StyleGuide } from "../domain/translation/models";

export interface TranslationConfig {
  loadStyleGuide(): Promise<StyleGuide>;
  loadLocale(): Promise<Locale>;
}
