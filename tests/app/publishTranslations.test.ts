import { describe, it, expect } from "vitest";
import { PublishTranslations } from "../../src/app/PublishTranslations";
import type { TranslationStore } from "../../src/ports/TranslationStore";
import type { DriveUploader } from "../../src/ports/DriveUploader";
import type { PublishStore } from "../../src/ports/PublishStore";
import type { Translation } from "../../src/domain/translation/models";
import type { UploadRequest, UploadResult } from "../../src/domain/publish/publishModels";

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

class InMemoryPublishStore implements PublishStore {
  public keys = new Set<string>();
  async listPublished() { return this.keys; }
  async record(key: string) { this.keys.add(key); }
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
    store.keys.add("x:1:translated:google");
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
});
