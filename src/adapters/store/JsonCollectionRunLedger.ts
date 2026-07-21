import { dirname } from "node:path";
import type { CollectionRun } from "../../domain/coverage";
import type { CollectionRunLedger } from "../../ports/CollectionRunLedger";
import { readJsonFile, writeJsonFileAtomic } from "../../shared/store/jsonFile";

export class JsonCollectionRunLedger implements CollectionRunLedger {
  private readonly dir: string;
  constructor(private readonly path: string) {
    this.dir = dirname(path);
  }

  async record(run: CollectionRun): Promise<void> {
    const existing = await readJsonFile<CollectionRun[]>(this.path, []);
    existing.push(run);
    await writeJsonFileAtomic(this.dir, this.path, existing);
  }
}
