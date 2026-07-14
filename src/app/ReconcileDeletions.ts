import type { SourceGateway } from "../ports/SourceGateway";
import type { CollectionRepository } from "../ports/CollectionRepository";
import { systemClock, type Clock } from "../ports/Clock";

export interface ReconcileResult {
  checked: number;
  deleted: number;
}

export class ReconcileDeletions {
  constructor(
    private readonly source: SourceGateway,
    private readonly repo: CollectionRepository,
    private readonly now: Clock = systemClock,
    private readonly batchSize = 100,
  ) {}

  async run(): Promise<ReconcileResult> {
    const activeIds = await this.repo.listActiveTweetIds();

    const alive = new Set<string>();
    for (let i = 0; i < activeIds.length; i += this.batchSize) {
      const batch = activeIds.slice(i, i + this.batchSize);
      const tweets = await this.source.fetchByIds(batch);
      for (const t of tweets) alive.add(t.id);
    }

    const missing = activeIds.filter((id) => !alive.has(id));
    if (missing.length > 0) {
      await this.repo.markDeleted(missing, this.now());
    }

    return { checked: activeIds.length, deleted: missing.length };
  }
}
