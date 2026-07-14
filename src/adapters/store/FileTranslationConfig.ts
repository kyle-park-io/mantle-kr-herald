import { readFile } from "node:fs/promises";
import { join } from "node:path";
import type { Locale, StyleGuide } from "../../domain/translation/models";
import type { TranslationConfig } from "../../ports/TranslationConfig";
import { readJsonFile } from "../../shared/store/jsonFile";

const DEFAULT_LOCALE: Locale = {
  dateFormat: "YYYY년 M월 D일",
  numberFormat: "천 단위 콤마",
  currency: "USD",
  unit: "미터법",
  honorific: "합니다체",
};

export class FileTranslationConfig implements TranslationConfig {
  constructor(private readonly dir: string) {}

  async loadStyleGuide(): Promise<StyleGuide> {
    try {
      return { text: await readFile(join(this.dir, "style-guide.md"), "utf8") };
    } catch (err: unknown) {
      if (err instanceof Error && "code" in err && (err as NodeJS.ErrnoException).code === "ENOENT") {
        return { text: "" };
      }
      throw err;
    }
  }

  async loadLocale(): Promise<Locale> {
    return readJsonFile<Locale>(join(this.dir, "locale.json"), DEFAULT_LOCALE);
  }
}
