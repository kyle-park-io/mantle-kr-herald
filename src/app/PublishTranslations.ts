import { renderApproved, renderReview, publishFileName } from "../domain/publish/renderers";
import type { FolderKind } from "../domain/publish/publishModels";
import type { TranslationStore } from "../ports/TranslationStore";
import type { DriveUploader } from "../ports/DriveUploader";
import type { PublishStore } from "../ports/PublishStore";
import { contentHash, entryKey, type SyncEntry } from "../domain/publish/syncLedger";

export interface PublishFailure {
  key: string; // `${itemId}:${status}:${drive}`
  error: string;
}

export interface PublishResult {
  uploaded: number;
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

  async run(): Promise<PublishResult> {
    const published = await this.publishStore.listPublished();
    let uploaded = 0;
    let failed = 0;
    const failures: PublishFailure[] = [];
    const byDrive: Record<string, number> = {};

    for (const t of await this.translationStore.loadAll()) {
      const content = t.status === "approved" ? renderApproved(t) : renderReview(t);
      const folder: FolderKind = t.status === "approved" ? "approved" : "review";
      const name = publishFileName(t);

      for (const uploader of this.uploaders) {
        const key = entryKey({ itemId: t.itemId, status: t.status, target: uploader.name });
        if (published.has(key)) continue;
        try {
          const result = await uploader.upload({ name, content, folder });
          const entry: SyncEntry = {
            itemId: t.itemId,
            stage: "translation",
            status: t.status,
            target: uploader.name,
            fileName: result.name,
            remoteId: result.id,
            url: result.url,
            contentHash: contentHash(content),
            uploadedAt: this.now().toISOString(),
          };
          await this.publishStore.record(entry);
          uploaded += 1;
          byDrive[uploader.name] = (byDrive[uploader.name] ?? 0) + 1;
        } catch (err) {
          failed += 1;
          failures.push({ key, error: err instanceof Error ? err.message : String(err) });
        }
      }
    }

    return { uploaded, failed, failures, byDrive };
  }
}
