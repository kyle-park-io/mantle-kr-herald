import { readFile } from "node:fs/promises";
import { join } from "node:path";
import type { ConversionType } from "../../domain/conversion/models";
import type { ConversionConfig } from "../../ports/ConversionConfig";

export class FileConversionConfig implements ConversionConfig {
  constructor(private readonly dir: string) {}

  async loadTypeGuide(type: ConversionType): Promise<{ text: string }> {
    try {
      return { text: await readFile(join(this.dir, `${type}.md`), "utf8") };
    } catch (err: unknown) {
      if (err instanceof Error && "code" in err && (err as NodeJS.ErrnoException).code === "ENOENT") {
        return { text: "" };
      }
      throw err;
    }
  }
}
