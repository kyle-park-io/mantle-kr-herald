import type { Translation } from "../domain/translation/models";

export interface TranslationStore {
  loadAll(): Promise<Translation[]>;
  upsert(t: Translation): Promise<void>; // by itemId
  listTranslatedIds(): Promise<Set<string>>;
}
