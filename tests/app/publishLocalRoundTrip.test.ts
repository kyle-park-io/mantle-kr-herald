import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LocalFileUploader } from "../../src/adapters/drive/LocalFileUploader";
import { PublishTranslations } from "../../src/app/PublishTranslations";
import { publishFileName } from "../../src/domain/publish/renderers";
import type { Translation } from "../../src/domain/translation/models";
import type { TranslationStore } from "../../src/ports/TranslationStore";
import { InMemoryPublishStore } from "../support/publishStore";

let root: string;
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "roundtrip-"));
});
afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

function store(list: Translation[]): TranslationStore {
  return { loadAll: async () => list, upsert: async () => {}, listTranslatedIds: async () => new Set() };
}

describe("publishing to the local filesystem across a re-approval", () => {
  it("leaves exactly one document when re-approval changes the filename", async () => {
    const approved: Translation = {
      itemId: "x:1",
      source: "x",
      sourceText: "hello world from mantle",
      koreanText: "안녕하세요",
      status: "approved",
      translatedAt: "2026-07-15T00:00:00.000Z",
      approvedAt: "2026-07-15T00:00:00.000Z",
    };
    const ledger = new InMemoryPublishStore();
    const uploader = new LocalFileUploader(root);

    const first = await new PublishTranslations(store([approved]), [uploader], ledger).run();
    expect(first).toMatchObject({ uploaded: 1, updated: 0, failed: 0 });
    expect(await readdir(join(root, "approved"))).toEqual([publishFileName(approved)]);

    // Edited and re-approved six days later: koreanText changes (new hash → stale) and approvedAt
    // changes (new filename).
    const reapproved: Translation = {
      ...approved,
      koreanText: "안녕하세요, 수정본입니다",
      approvedAt: "2026-07-21T00:00:00.000Z",
    };
    expect(publishFileName(reapproved)).not.toBe(publishFileName(approved));

    const second = await new PublishTranslations(store([reapproved]), [uploader], ledger).run();

    expect(second).toMatchObject({ uploaded: 0, updated: 1, failed: 0 });
    expect(await readdir(join(root, "approved"))).toEqual([publishFileName(reapproved)]);
    expect(await readFile(join(root, "approved", publishFileName(reapproved)), "utf8")).toContain("수정본");
    expect(ledger.entries).toHaveLength(1);
  });

  it("does nothing on a re-run when the content is unchanged", async () => {
    const approved: Translation = {
      itemId: "x:2",
      source: "x",
      sourceText: "unchanged",
      koreanText: "그대로",
      status: "approved",
      translatedAt: "2026-07-15T00:00:00.000Z",
      approvedAt: "2026-07-15T00:00:00.000Z",
    };
    const ledger = new InMemoryPublishStore();
    const uploader = new LocalFileUploader(root);

    await new PublishTranslations(store([approved]), [uploader], ledger).run();
    const second = await new PublishTranslations(store([approved]), [uploader], ledger).run();

    expect(second).toMatchObject({ uploaded: 0, updated: 0, failed: 0 });
  });
});
