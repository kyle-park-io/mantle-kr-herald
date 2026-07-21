import { describe, it, expect } from "vitest";
import { PublishTranslations } from "../../src/app/PublishTranslations";
import type { TranslationStore } from "../../src/ports/TranslationStore";
import type { DriveUploader } from "../../src/ports/DriveUploader";
import type { PublishStore } from "../../src/ports/PublishStore";
import type { Translation } from "../../src/domain/translation/models";
import type { UploadRequest, UploadResult } from "../../src/domain/publish/publishModels";
import { entryKey, type SyncEntry } from "../../src/domain/publish/syncLedger";
import { InMemoryPublishStore } from "../support/publishStore";

function tr(itemId: string, status: Translation["status"]): Translation {
  return {
    itemId, source: "x", sourceText: `src-${itemId}`, koreanText: `ko-${itemId}`, status,
    translatedAt: "2026-01-01T00:00:00.000Z",
  };
}

function translationStore(list: Translation[]): TranslationStore {
  return { loadAll: async () => list, upsert: async () => {}, listTranslatedIds: async () => new Set() };
}

class FakeUploader implements DriveUploader {
  public reqs: UploadRequest[] = [];
  constructor(public readonly name: string, private readonly fail = false) {}
  async upload(req: UploadRequest): Promise<UploadResult> {
    if (this.fail) throw new Error("boom");
    this.reqs.push(req);
    return { id: `${this.name}-${req.name}`, name: req.name };
  }
}

class UpdatableUploader extends FakeUploader {
  public updates: Array<{ remoteId: string; req: UploadRequest }> = [];
  async update(remoteId: string, req: UploadRequest): Promise<UploadResult> {
    this.updates.push({ remoteId, req });
    return { id: remoteId, name: req.name, url: `https://drive.example/${remoteId}` };
  }
}

describe("PublishTranslations", () => {
  it("uploads review docs for translated + approved docs for approved, to every uploader, and records per drive", async () => {
    const g = new FakeUploader("google");
    const l = new FakeUploader("lark");
    const store = new InMemoryPublishStore();
    const uc = new PublishTranslations(translationStore([tr("x:1", "translated"), tr("x:2", "approved")]), [g, l], store);

    const res = await uc.run();

    expect(res.uploaded).toBe(4); // 2 items × 2 drives
    expect(res.byDrive).toEqual({ google: 2, lark: 2 });
    // find by content (filename is now <date>-<slug>-<id>.md, not the bare id)
    const req1 = g.reqs.find((r) => r.content.includes("x:1"));
    const req2 = g.reqs.find((r) => r.content.includes("x:2"));
    // review folder for translated, approved for approved
    expect(req1?.folder).toBe("review");
    expect(req2?.folder).toBe("approved");
    // review doc contains source, approved doc does not
    expect(req1?.content).toContain("src-x:1");
    expect(req2?.content).not.toContain("src-x:2");
    // descriptive filename: <date>-<slug>-<id>.md
    expect(req1?.name).toMatch(/^2026-01-01-.*x-1\.md$/);
    expect(store.keys.has("x:1:translated:google")).toBe(true);
    expect(store.keys.has("x:2:approved:lark")).toBe(true);
  });

  it("skips keys already published (per drive)", async () => {
    const g = new FakeUploader("google");
    const store = new InMemoryPublishStore();
    store.entries.push({ itemId: "x:1", stage: "translation", status: "translated", target: "google" });
    const uc = new PublishTranslations(translationStore([tr("x:1", "translated")]), [g], store);
    const res = await uc.run();
    expect(res.uploaded).toBe(0);
    expect(g.reqs).toHaveLength(0);
  });

  it("isolates a failing uploader: records the good drive, counts the failure, keeps going", async () => {
    const good = new FakeUploader("google");
    const bad = new FakeUploader("lark", true);
    const store = new InMemoryPublishStore();
    const uc = new PublishTranslations(translationStore([tr("x:1", "translated")]), [good, bad], store);
    const res = await uc.run();
    expect(res.uploaded).toBe(1);
    expect(res.failed).toBe(1);
    expect(res.failures).toEqual([{ key: "x:1:translated:lark", error: "boom" }]);
    expect(store.keys.has("x:1:translated:google")).toBe(true);
    expect(store.keys.has("x:1:translated:lark")).toBe(false);
  });

  it("records what was uploaded, where, and with which content", async () => {
    const recorded: SyncEntry[] = [];
    const store: PublishStore = {
      listEntries: async () => recorded,
      record: async (e) => {
        recorded.push(e);
      },
    };
    const uploader: DriveUploader = {
      name: "google",
      upload: async () => ({ id: "file-1", name: "doc.md", url: "https://drive.example/file-1" }),
    };

    await new PublishTranslations(
      translationStore([tr("x:1", "approved")]),
      [uploader],
      store,
      () => new Date("2026-07-20T09:00:00.000Z"),
    ).run();

    expect(recorded).toHaveLength(1);
    expect(recorded[0].target).toBe("google");
    expect(recorded[0].remoteId).toBe("file-1");
    expect(recorded[0].url).toBe("https://drive.example/file-1");
    expect(recorded[0].uploadedAt).toBe("2026-07-20T09:00:00.000Z");
    expect(recorded[0].contentHash).toMatch(/^sha256:/);
  });

  it("updates in place when the content changed since it was published", async () => {
    const t = tr("x:1", "approved");
    const store = new InMemoryPublishStore();
    await store.record({
      itemId: "x:1", stage: "translation", status: "approved", target: "google",
      remoteId: "file-1", contentHash: "sha256:stale", uploadedAt: "2026-01-01T00:00:00.000Z",
    });
    const uploader = new UpdatableUploader("google");

    const res = await new PublishTranslations(translationStore([t]), [uploader], store).run();

    expect(res.updated).toBe(1);
    expect(res.uploaded).toBe(0);
    expect(uploader.reqs).toHaveLength(0); // never created a duplicate
    expect(uploader.updates).toHaveLength(1);
    expect(uploader.updates[0].remoteId).toBe("file-1");

    const entry = (await store.listEntries()).find((e) => e.target === "google");
    expect(entry?.contentHash).not.toBe("sha256:stale");
    expect(entry?.remoteId).toBe("file-1");
  });

  it("skips when the content is unchanged", async () => {
    const t = tr("x:1", "approved");
    const store = new InMemoryPublishStore();
    const uploader = new UpdatableUploader("google");
    // publish once, then run again with nothing edited
    await new PublishTranslations(translationStore([t]), [uploader], store).run();
    const second = await new PublishTranslations(translationStore([t]), [uploader], store).run();

    expect(second).toMatchObject({ uploaded: 0, updated: 0, failed: 0 });
    expect(uploader.updates).toHaveLength(0);
  });

  // The migration trap: a legacy row has no hash. Unknown is not changed.
  it("never re-uploads a row migrated from the legacy format", async () => {
    const t = tr("x:1", "approved");
    const store = new InMemoryPublishStore();
    await store.record({ itemId: "x:1", stage: "translation", status: "approved", target: "google" });
    const uploader = new UpdatableUploader("google");

    const res = await new PublishTranslations(translationStore([t]), [uploader], store).run();

    expect(res).toMatchObject({ uploaded: 0, updated: 0, failed: 0 });
    expect(uploader.reqs).toHaveLength(0);
    expect(uploader.updates).toHaveLength(0);
  });

  it("reports a failure when a stale item's drive cannot update in place", async () => {
    const t = tr("x:1", "approved");
    const store = new InMemoryPublishStore();
    await store.record({
      itemId: "x:1", stage: "translation", status: "approved", target: "noupdate",
      remoteId: "tok-1", contentHash: "sha256:stale", uploadedAt: "2026-01-01T00:00:00.000Z",
    });
    const uploader = new FakeUploader("noupdate"); // no update method — every shipped adapter has one now

    const res = await new PublishTranslations(translationStore([t]), [uploader], store).run();

    expect(res.failed).toBe(1);
    expect(res.updated).toBe(0);
    expect(uploader.reqs).toHaveLength(0); // must NOT fall back to creating a duplicate
    expect(res.failures[0].error).toMatch(/cannot update/i);
    expect(res.failures[0].error).toMatch(/noupdate/i);
  });

  it("does not count a create as uploaded when the ledger write fails", async () => {
    const t = tr("x:1", "approved");
    const uploader = new FakeUploader("google");
    const store: PublishStore = {
      listEntries: async () => [],
      record: async () => {
        throw new Error("disk full");
      },
    };

    const res = await new PublishTranslations(translationStore([t]), [uploader], store).run();

    expect(res.uploaded).toBe(0);
    expect(res.updated).toBe(0);
    expect(res.failed).toBe(1);
    expect(res.failures[0].error).toBe("disk full");
  });

  it("does not count an update as updated when the ledger write fails", async () => {
    const t = tr("x:1", "approved");
    const uploader = new UpdatableUploader("google");
    const existing: SyncEntry = {
      itemId: "x:1", stage: "translation", status: "approved", target: "google",
      remoteId: "file-1", contentHash: "sha256:stale", uploadedAt: "2026-01-01T00:00:00.000Z",
    };
    const store: PublishStore = {
      listEntries: async () => [existing],
      record: async () => {
        throw new Error("disk full");
      },
    };

    const res = await new PublishTranslations(translationStore([t]), [uploader], store).run();

    expect(res.uploaded).toBe(0);
    expect(res.updated).toBe(0);
    expect(res.failed).toBe(1);
    expect(uploader.updates).toHaveLength(1); // the update itself did happen — only recording failed
    expect(res.failures[0].error).toBe("disk full");
  });

  it("falls back to the existing url when an update response omits webViewLink", async () => {
    const t = tr("x:1", "approved");
    const store = new InMemoryPublishStore();
    await store.record({
      itemId: "x:1", stage: "translation", status: "approved", target: "google",
      remoteId: "file-1", url: "https://drive.example/old-link", contentHash: "sha256:stale",
      uploadedAt: "2026-01-01T00:00:00.000Z",
    });
    class NoUrlUploader extends FakeUploader {
      async update(remoteId: string, req: UploadRequest): Promise<UploadResult> {
        return { id: remoteId, name: req.name }; // no url — as a PATCH response without webViewLink would be
      }
    }
    const uploader = new NoUrlUploader("google");

    await new PublishTranslations(translationStore([t]), [uploader], store).run();

    const entry = (await store.listEntries()).find((e) => e.target === "google");
    expect(entry?.url).toBe("https://drive.example/old-link");
  });

  it("reports a failure when a stale entry has no remoteId, even though the uploader supports update", async () => {
    const t = tr("x:1", "approved");
    const store = new InMemoryPublishStore();
    await store.record({
      itemId: "x:1", stage: "translation", status: "approved", target: "google",
      contentHash: "sha256:stale", uploadedAt: "2026-01-01T00:00:00.000Z", // no remoteId
    });
    const uploader = new UpdatableUploader("google"); // has update()

    const res = await new PublishTranslations(translationStore([t]), [uploader], store).run();

    expect(res.failed).toBe(1);
    expect(res.updated).toBe(0);
    expect(uploader.reqs).toHaveLength(0); // upload not called
    expect(uploader.updates).toHaveLength(0); // update not called
    expect(res.failures[0].error).toMatch(/cannot update/i);
    expect(res.failures[0].error).toMatch(/google/i);
  });

  it("publishes only the named item when run is given an itemId", async () => {
    const g = new FakeUploader("google");
    const store = new InMemoryPublishStore();
    const uc = new PublishTranslations(translationStore([tr("x:1", "approved"), tr("x:2", "approved")]), [g], store);

    const res = await uc.run({ itemId: "x:2" });

    expect(g.reqs.map((r) => r.name)).toHaveLength(1);
    expect(res.uploaded).toBe(1);
    expect(store.entries.map((e) => e.itemId)).toEqual(["x:2"]);
  });
});
