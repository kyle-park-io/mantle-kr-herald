import { renderApproved, renderReview, publishFileName } from "../domain/publish/renderers";
import type { FolderKind } from "../domain/publish/publishModels";
import type { TranslationStore } from "../ports/TranslationStore";
import type { DriveUploader } from "../ports/DriveUploader";
import type { PublishStore } from "../ports/PublishStore";

export interface PublishResult {
  uploaded: number;
  failed: number;
  byDrive: Record<string, number>;
}

export class PublishTranslations {
  constructor(
    private readonly translationStore: TranslationStore,
    private readonly uploaders: DriveUploader[],
    private readonly publishStore: PublishStore,
  ) {}

  async run(): Promise<PublishResult> {
    const published = await this.publishStore.listPublished();
    let uploaded = 0;
    let failed = 0;
    const byDrive: Record<string, number> = {};

    for (const t of await this.translationStore.loadAll()) {
      const content = t.status === "approved" ? renderApproved(t) : renderReview(t);
      const folder: FolderKind = t.status === "approved" ? "approved" : "review";
      const name = publishFileName(t);

      for (const uploader of this.uploaders) {
        const key = `${t.itemId}:${t.status}:${uploader.name}`;
        if (published.has(key)) continue;
        try {
          await uploader.upload({ name, content, folder });
          await this.publishStore.record(key);
          uploaded += 1;
          byDrive[uploader.name] = (byDrive[uploader.name] ?? 0) + 1;
        } catch {
          failed += 1;
        }
      }
    }

    return { uploaded, failed, byDrive };
  }
}
