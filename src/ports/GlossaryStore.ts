import type { GlossaryEntry } from "../domain/translation/models";

export interface GlossaryStore {
  load(): Promise<GlossaryEntry[]>;
  /** Insert or replace by term. */
  upsertEntry(entry: GlossaryEntry): Promise<void>;
}
