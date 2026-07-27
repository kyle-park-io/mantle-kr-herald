import { join } from "node:path";
import type { ChannelSentEntry } from "../../domain/send/channels";
import { sentKey } from "../../domain/send/channels";
import { readJsonFile, writeJsonFileAtomic } from "../../shared/store/jsonFile";

export class JsonChannelLedger {
  private readonly path: string;
  constructor(private readonly dir: string) {
    this.path = join(dir, "channels.json");
  }
  private load(): Promise<ChannelSentEntry[]> {
    return readJsonFile<ChannelSentEntry[]>(this.path, []);
  }
  async loadKeys(): Promise<Set<string>> {
    return new Set((await this.load()).map(sentKey));
  }
  async add(entry: ChannelSentEntry): Promise<void> {
    const byKey = new Map((await this.load()).map((e) => [sentKey(e), e]));
    byKey.set(sentKey(entry), entry);
    await writeJsonFileAtomic(this.dir, this.path, [...byKey.values()]);
  }
}
