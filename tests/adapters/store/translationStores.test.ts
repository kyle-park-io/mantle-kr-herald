import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { JsonGlossaryStore } from "../../../src/adapters/store/JsonGlossaryStore";
import { JsonFewShotStore } from "../../../src/adapters/store/JsonFewShotStore";
import { JsonTranslationStore } from "../../../src/adapters/store/JsonTranslationStore";
import { FileTranslationConfig } from "../../../src/adapters/store/FileTranslationConfig";
import type { Translation } from "../../../src/domain/translation/models";

let dir: string;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "tstore-"));
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

function translation(itemId: string, over: Partial<Translation> = {}): Translation {
  return {
    itemId, source: "x", sourceText: "s", koreanText: "ko",
    status: over.status ?? "translated", translatedAt: "2026-01-01T00:00:00.000Z", ...over,
  };
}

describe("JsonGlossaryStore", () => {
  it("upsertEntry replaces by term; load returns all", async () => {
    const store = new JsonGlossaryStore(dir);
    await store.upsertEntry({ term: "Mantle", rule: "transliterate", target: "맨틀", updatedAt: "2026-07-14" });
    await store.upsertEntry({ term: "Mantle", rule: "transliterate", target: "맨틀넷", updatedAt: "2026-07-15" });
    const all = await store.load();
    expect(all).toHaveLength(1);
    expect(all[0].target).toBe("맨틀넷");
  });
});

describe("JsonFewShotStore", () => {
  it("add appends; load returns all", async () => {
    const store = new JsonFewShotStore(dir);
    await store.add({ source: "a", target: "가" });
    await store.add({ source: "b", target: "나" });
    expect(await store.load()).toHaveLength(2);
  });

  it("add upserts by itemId when present, keeping the latest target", async () => {
    const store = new JsonFewShotStore(dir);
    await store.add({ source: "a", target: "가", itemId: "x:1" });
    await store.add({ source: "a-fixed", target: "가고침", itemId: "x:1" });
    const all = await store.load();
    expect(all).toHaveLength(1);
    expect(all[0].target).toBe("가고침");
  });
});

describe("JsonTranslationStore", () => {
  it("upsert by itemId; listTranslatedIds returns the id set", async () => {
    const store = new JsonTranslationStore(dir);
    await store.upsert(translation("x:1", { koreanText: "old" }));
    await store.upsert(translation("x:1", { koreanText: "new" }));
    await store.upsert(translation("lark:2"));
    const all = await store.loadAll();
    expect(all).toHaveLength(2);
    expect(all.find((t) => t.itemId === "x:1")?.koreanText).toBe("new");
    expect([...(await store.listTranslatedIds())].sort()).toEqual(["lark:2", "x:1"]);
  });
});

describe("FileTranslationConfig", () => {
  it("loads style guide text and locale json", async () => {
    await writeFile(join(dir, "style-guide.md"), "# Style\nBe concise.", "utf8");
    await writeFile(join(dir, "locale.json"), JSON.stringify({ dateFormat: "d", numberFormat: "n", currency: "USD", unit: "m", honorific: "합니다체" }), "utf8");
    const config = new FileTranslationConfig(dir);
    expect((await config.loadStyleGuide()).text).toContain("Be concise");
    expect((await config.loadLocale()).honorific).toBe("합니다체");
  });
});
