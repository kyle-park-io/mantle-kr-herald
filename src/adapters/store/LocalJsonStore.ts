import { join } from "node:path";
import type { CollectedThread, SourceTweet } from "../../domain/models";
import type { CollectionRepository } from "../../ports/CollectionRepository";
import type { WatermarkStore } from "../../shared/store/WatermarkStore";
import { readJsonFile, writeJsonFileAtomic } from "../../shared/store/jsonFile";

interface StateFile {
  watermarks?: Record<string, string>;
}

export class LocalJsonStore implements CollectionRepository, WatermarkStore {
  private readonly itemsPath: string;
  private readonly statePath: string;

  constructor(private readonly dir: string) {
    this.itemsPath = join(dir, "items.json");
    this.statePath = join(dir, "state.json");
  }

  async loadAll(): Promise<CollectedThread[]> {
    return readJsonFile<CollectedThread[]>(this.itemsPath, []);
  }

  async upsert(threads: CollectedThread[]): Promise<void> {
    const existing = await this.loadAll();
    const byRoot = new Map(existing.map((t) => [t.rootId, t]));
    for (const incoming of threads) {
      const prev = byRoot.get(incoming.rootId);
      byRoot.set(incoming.rootId, {
        ...incoming,
        tweets: this.mergeTweets(prev?.tweets ?? [], incoming.tweets),
        firstSeenAt: prev?.firstSeenAt ?? incoming.firstSeenAt,
      });
    }
    await writeJsonFileAtomic(this.dir, this.itemsPath, [...byRoot.values()]);
  }

  private mergeTweets(existing: SourceTweet[], incoming: SourceTweet[]): SourceTweet[] {
    const byId = new Map<string, SourceTweet>();
    for (const t of existing) byId.set(t.id, t);
    for (const t of incoming) byId.set(t.id, t);
    return [...byId.values()].sort(
      (a, b) => a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id),
    );
  }

  async listActiveTweetIds(): Promise<string[]> {
    const all = await this.loadAll();
    const ids: string[] = [];
    for (const thread of all) {
      if (thread.status !== "active") continue;
      for (const tweet of thread.tweets) ids.push(tweet.id);
    }
    return ids;
  }

  async markDeleted(tweetIds: string[], deletedAt: string): Promise<void> {
    const target = new Set(tweetIds);
    const all = await this.loadAll();
    let changed = false;
    for (const thread of all) {
      if (thread.status !== "active") continue;
      if (thread.tweets.some((t) => target.has(t.id))) {
        thread.status = "deleted";
        thread.deletedAt = deletedAt;
        changed = true;
      }
    }
    if (changed) await writeJsonFileAtomic(this.dir, this.itemsPath, all);
  }

  async get(key: string): Promise<string | undefined> {
    const state = await readJsonFile<StateFile>(this.statePath, {});
    return state.watermarks?.[key];
  }

  async set(key: string, time: string): Promise<void> {
    const state = await readJsonFile<StateFile>(this.statePath, {});
    const watermarks = { ...(state.watermarks ?? {}), [key]: time };
    await writeJsonFileAtomic(this.dir, this.statePath, { watermarks } satisfies StateFile);
  }
}
