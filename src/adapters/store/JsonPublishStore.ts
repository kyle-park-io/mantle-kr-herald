import { join } from "node:path";
import type { PublishStore } from "../../ports/PublishStore";
import { readJsonFile, writeJsonFileAtomic } from "../../shared/store/jsonFile";

interface StateFile {
  published?: string[];
}

export class JsonPublishStore implements PublishStore {
  private readonly path: string;
  constructor(private readonly dir: string) {
    this.path = join(dir, "state.json");
  }

  async listPublished(): Promise<Set<string>> {
    const state = await readJsonFile<StateFile>(this.path, {});
    return new Set(state.published ?? []);
  }

  async record(key: string): Promise<void> {
    const state = await readJsonFile<StateFile>(this.path, {});
    const published = new Set(state.published ?? []);
    published.add(key);
    await writeJsonFileAtomic(this.dir, this.path, { published: [...published] } satisfies StateFile);
  }
}
