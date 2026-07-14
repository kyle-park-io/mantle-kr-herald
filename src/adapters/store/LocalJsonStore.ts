import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import type { CollectedThread } from "../../domain/models";
import type { CollectionRepository } from "../../ports/CollectionRepository";
import type { WatermarkStore } from "../../ports/WatermarkStore";

interface StateFile {
  watermark?: string;
}

function isErrnoException(err: unknown): err is NodeJS.ErrnoException {
  return err instanceof Error && "code" in err;
}

export class LocalJsonStore implements CollectionRepository, WatermarkStore {
  private readonly itemsPath: string;
  private readonly statePath: string;

  constructor(private readonly dir: string) {
    this.itemsPath = join(dir, "items.json");
    this.statePath = join(dir, "state.json");
  }

  private async readJson<T>(path: string, fallback: T): Promise<T> {
    try {
      return JSON.parse(await readFile(path, "utf8")) as T;
    } catch (err: unknown) {
      if (isErrnoException(err) && err.code === "ENOENT") {
        return fallback;
      }
      const cause = err instanceof Error ? err.message : String(err);
      throw new Error(`Failed to read JSON store file at ${path}: ${cause}`, { cause: err });
    }
  }

  private async writeJson(path: string, data: unknown): Promise<void> {
    await mkdir(this.dir, { recursive: true });
    const tmpPath = `${path}.tmp-${process.pid}-${Date.now()}-${randomUUID()}`;
    await writeFile(tmpPath, `${JSON.stringify(data, null, 2)}\n`, "utf8");
    await rename(tmpPath, path);
  }

  async loadAll(): Promise<CollectedThread[]> {
    return this.readJson<CollectedThread[]>(this.itemsPath, []);
  }

  async upsert(threads: CollectedThread[]): Promise<void> {
    const existing = await this.loadAll();
    const byRoot = new Map(existing.map((t) => [t.rootId, t]));
    for (const incoming of threads) {
      const prev = byRoot.get(incoming.rootId);
      byRoot.set(incoming.rootId, {
        ...incoming,
        firstSeenAt: prev?.firstSeenAt ?? incoming.firstSeenAt,
      });
    }
    await this.writeJson(this.itemsPath, [...byRoot.values()]);
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
    if (changed) await this.writeJson(this.itemsPath, all);
  }

  async get(): Promise<string | undefined> {
    const state = await this.readJson<StateFile>(this.statePath, {});
    return state.watermark;
  }

  async set(time: string): Promise<void> {
    await this.writeJson(this.statePath, { watermark: time } satisfies StateFile);
  }
}
