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
      // `posted` is terminal for the Drive path, and this is the one place that rule can be enforced
      // for every caller — the CLI's bulk `drive:publish`, the dashboard's per-item button, and any
      // future one.
      //
      // The Drive layer knows exactly two statuses: the two lines below pick `renderApproved` +
      // `approved/` when the status is literally `"approved"`, and `renderReview` + `review/`
      // otherwise. A third status therefore does not read as "third folder", it reads as "review" —
      // so an item that was approved, published to `approved/`, and then retired to `posted` by
      // reconcile would be **demoted**: re-rendered as a review doc, uploaded to `review/`, and its
      // approved doc deleted by the move-don't-copy sweep below. That is data loss driven by a
      // status change that has nothing to do with Drive. `x:2080608995371597892` — one of the five
      // items that retire on the first production run — is exactly this shape.
      //
      // Skipping instead of extending the two-way branch is deliberate: a `posted` item is finished.
      // Its doc, at whatever status it was published under, is the correct record of the copy that
      // went out. 되돌리기 puts it back to `translated` and publishing resumes normally from there.
      if (t.status === "posted") continue;

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

          // Move, don't copy: drop this item's doc at any OTHER status on this drive, so approval
          // moves review→approved and un-approval moves it back. Best-effort — a failed delete leaves
          // at most one stale doc (the pre-move behavior) and never fails the publish.
          if (uploader.delete) {
            let siblings: SyncEntry[] = [];
            try {
              siblings = (await this.publishStore.listEntries()).filter(
                (e) => e.itemId === t.itemId && e.target === uploader.name && e.status !== t.status,
              );
            } catch (err) {
              console.warn(
                `[publish] published ${t.itemId} to ${folder} but could not scan for a prior-status doc on ${uploader.name}: ${err instanceof Error ? err.message : String(err)}`,
              );
            }
            for (const sib of siblings) {
              if (!sib.remoteId) continue;
              try {
                await uploader.delete(sib.remoteId);
                await this.publishStore.remove(entryKey(sib));
              } catch (err) {
                console.warn(
                  `[publish] moved ${t.itemId} to ${folder} but could not remove its ${sib.status} doc on ${uploader.name}: ${err instanceof Error ? err.message : String(err)} — delete it by hand`,
                );
              }
            }
          }
        } catch (err) {
          failed += 1;
          failures.push({ key, error: err instanceof Error ? err.message : String(err) });
        }
      }
    }

    return { uploaded, updated, failed, failures, byDrive };
  }
}
