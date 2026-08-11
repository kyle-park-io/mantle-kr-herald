import { readdir, readFile, writeFile, mkdir } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { ConfigFile } from "../../domain/config/bundle";
import type { ConfigFileStore } from "../../ports/ConfigFileStore";
import { isSteeringConfigFile } from "../../domain/config/steering";

export class FsConfigFileStore implements ConfigFileStore {
  constructor(
    private readonly dirs: { abs: string; rel: string }[],
    private readonly repoRoot: string,
  ) {}

  /**
   * Every steering-config file in the configured directories. `isSteeringConfigFile` is what keeps
   * the `db:export` few-shot artifacts out — see its module doc; without it `config:push` uploads a
   * corpus snapshot nothing reads and `backup()` (and so `config:pull`'s pre-write backup) treats
   * the same dead files as team assets worth preserving.
   */
  async list(): Promise<ConfigFile[]> {
    const out: ConfigFile[] = [];
    for (const d of this.dirs) {
      for (const entry of await readdir(d.abs, { withFileTypes: true })) {
        if (!entry.isFile() || !isSteeringConfigFile(entry.name)) continue;
        const content = await readFile(join(d.abs, entry.name), "utf8");
        out.push({ path: `${d.rel}/${entry.name}`, content });
      }
    }
    return out;
  }

  async write(path: string, content: string): Promise<void> {
    const abs = join(this.repoRoot, path);
    await mkdir(dirname(abs), { recursive: true });
    await writeFile(abs, content, "utf8");
  }

  async backup(destDir: string): Promise<void> {
    for (const f of await this.list()) {
      const abs = join(destDir, f.path);
      await mkdir(dirname(abs), { recursive: true });
      await writeFile(abs, f.content, "utf8");
    }
  }
}
