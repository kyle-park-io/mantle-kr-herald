import { renderApproved, renderReview, publishFileName } from "../domain/publish/renderers";
import type { FolderKind } from "../domain/publish/publishModels";
import type { TranslationStore } from "../ports/TranslationStore";
import type { DriveUploader } from "../ports/DriveUploader";
import type { PublishStore } from "../ports/PublishStore";
import { contentHash, entryKey, isStale, type SyncEntry } from "../domain/publish/syncLedger";

export interface PublishFailure {
  key: string; // `${itemId}:${status}:${drive}`
  error: string;
}

export interface PublishResult {
  uploaded: number;
  updated: number;
  failed: number; // count (kept for the dashboard)
  failures: PublishFailure[]; // per-failure reason
  byDrive: Record<string, number>;
}

export class PublishTranslations {
  constructor(
    private readonly translationStore: TranslationStore,
    private readonly uploaders: DriveUploader[],
    private readonly publishStore: PublishStore,
    private readonly now: () => Date = () => new Date(),
  ) {}

  async run(opts: { itemId?: string } = {}): Promise<PublishResult> {
    const entries = await this.publishStore.listEntries();
    const byKey = new Map(entries.map((e) => [entryKey(e), e]));
    let uploaded = 0;
    let updated = 0;
    let failed = 0;
    const failures: PublishFailure[] = [];
    const byDrive: Record<string, number> = {};

    const all = await this.translationStore.loadAll();
    const translations = opts.itemId ? all.filter((t) => t.itemId === opts.itemId) : all;
    for (const t of translations) {
      const content = t.status === "approved" ? renderApproved(t) : renderReview(t);
      const folder: FolderKind = t.status === "approved" ? "approved" : "review";
      const name = publishFileName(t);
      const hash = contentHash(content);

      for (const uploader of this.uploaders) {
        const key = entryKey({ itemId: t.itemId, status: t.status, target: uploader.name });
        const existing = byKey.get(key);

        // A migrated legacy row has no hash: unknown is not changed. Re-uploading it would
        // create a duplicate in Drive for every item published before the ledger existed.
        if (existing && !isStale(existing, hash)) continue;

        try {
          let result;
          const isUpdate = existing !== undefined;
          if (existing) {
            if (!uploader.update || !existing.remoteId) {
              throw new Error(
                `${uploader.name} cannot update a published file in place — edit it in the drive by hand, ` +
                  `or delete this row from the sync ledger to re-publish as a new file (this leaves the old ` +
                  `file in the drive — find and delete it by hand afterward, or you will end up with a duplicate)`,
              );
            }
            result = await uploader.update(existing.remoteId, { name, content, folder });
          } else {
            result = await uploader.upload({ name, content, folder });
          }

          const entry: SyncEntry = {
            itemId: t.itemId,
            stage: "translation",
            status: t.status,
            target: uploader.name,
            fileName: result.name,
            remoteId: result.id,
            url: result.url ?? existing?.url,
            contentHash: hash,
            uploadedAt: this.now().toISOString(),
          };
          await this.publishStore.record(entry);
          if (isUpdate) updated += 1;
          else uploaded += 1;
          byDrive[uploader.name] = (byDrive[uploader.name] ?? 0) + 1;
        } catch (err) {
          failed += 1;
          failures.push({ key, error: err instanceof Error ? err.message : String(err) });
        }
      }
    }

    return { uploaded, updated, failed, failures, byDrive };
  }
}
