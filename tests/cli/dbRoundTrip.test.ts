import { describe, it, expect, afterEach } from "vitest";
import { mkdtemp, mkdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createTestDb } from "../support/testDb";
import { importOutputTree } from "../../src/cli/db-import";
import { exportOutputTree } from "../../src/cli/db-export";

let db: Awaited<ReturnType<typeof createTestDb>> | undefined;
afterEach(async () => { await db?.close(); db = undefined; });

const translations = [
  { itemId: "x:1", source: "x", sourceText: "s", koreanText: "ko",
    status: "approved", translatedAt: "2026-01-01T00:00:00.000Z", approvedAt: "2026-01-02T00:00:00.000Z" },
  { itemId: "lark:2", source: "lark", sourceText: "t", koreanText: "코", status: "translated",
    translatedAt: "2026-01-03T00:00:00.000Z" },
];

describe("import → export round trip", () => {
  it("reproduces the original file byte for byte", async () => {
    db = await createTestDb();
    const from = await mkdtemp(join(tmpdir(), "rt-from-"));
    await mkdir(join(from, "translations"), { recursive: true });
    const original = JSON.stringify(translations, null, 2) + "\n";
    await writeFile(join(from, "translations", "translations.json"), original, "utf8");

    await importOutputTree(db, from);
    const to = await mkdtemp(join(tmpdir(), "rt-to-"));
    await exportOutputTree(db, to);

    expect(await readFile(join(to, "translations", "translations.json"), "utf8")).toBe(original);
  });
});

/**
 * Every one of the eleven migrated stores (`docs/superpowers/specs/2026-07-31-hosted-writes-
 * design.md`'s "What moves" table), verified byte-for-byte the same way the test above verifies
 * translations. This is the rollback path for a live-data migration: an unverified store here means
 * an unevidenced claim about key order, absent-vs-null and `ordinal` ordering for that store.
 */
describe("round trip — every migrated store", () => {
  /**
   * Writes `data` to `outputRoot/<relPath>`, imports both roots, exports to fresh targets, and
   * returns what landed at the same `relPath` under the export target. `configRoot` defaults to a
   * fresh empty directory (harmless: an absent `translation`/`conversion` tree imports as zero
   * few-shot examples) so every non-few-shot test can ignore it entirely.
   */
  async function roundTripOutput(relPath: string, data: unknown): Promise<string> {
    db = await createTestDb();
    const from = await mkdtemp(join(tmpdir(), "rt2-from-"));
    const configFrom = await mkdtemp(join(tmpdir(), "rt2-cfg-from-"));
    const filePath = join(from, relPath);
    await mkdir(join(filePath, ".."), { recursive: true });
    const original = JSON.stringify(data, null, 2) + "\n";
    await writeFile(filePath, original, "utf8");

    await importOutputTree(db, from, configFrom);
    const to = await mkdtemp(join(tmpdir(), "rt2-to-"));
    const configTo = await mkdtemp(join(tmpdir(), "rt2-cfg-to-"));
    await exportOutputTree(db, to, configTo);

    return readFile(join(to, relPath), "utf8");
  }

  it("x/items.json", async () => {
    const threads = [
      {
        rootId: "1001",
        tweets: [
          { id: "1001", conversationId: "1001", text: "gm mantle", createdAt: "2026-01-01T00:00:00.000Z",
            url: "https://x.com/mantle/status/1001", authorUserName: "mantle_official", isReply: false, isQuote: false },
        ],
        status: "active",
        firstSeenAt: "2026-01-01T00:05:00.000Z",
      },
      {
        rootId: "1002",
        tweets: [
          { id: "1002", conversationId: "1002", text: "gn", createdAt: "2026-01-02T00:00:00.000Z",
            url: "https://x.com/mantle/status/1002", authorUserName: "mantle_official", isReply: false, isQuote: false },
        ],
        status: "deleted",
        firstSeenAt: "2026-01-02T00:05:00.000Z",
        deletedAt: "2026-01-03T00:00:00.000Z",
      },
    ];
    expect(await roundTripOutput(join("x", "items.json"), threads)).toBe(JSON.stringify(threads, null, 2) + "\n");
  });

  it("lark/items.json", async () => {
    const messages = [
      { messageId: "om_1", chatId: "oc_x", msgType: "text", createdAt: "2026-01-01T00:00:00.000Z",
        text: "안녕", rawContent: '{"text":"안녕"}' },
      { messageId: "om_2", chatId: "oc_x", msgType: "post", createdAt: "2026-01-02T00:00:00.000Z",
        senderId: "ou_1", threadId: "omt_1", parentId: "om_1", text: "공지", rawContent: '{"title":"공지"}' },
    ];
    expect(await roundTripOutput(join("lark", "items.json"), messages)).toBe(JSON.stringify(messages, null, 2) + "\n");
  });

  it("variants/variants.json", async () => {
    const variants = [
      { itemId: "x:1", type: "announcement", sourceKorean: "가", convertedText: "나", status: "approved",
        createdAt: "2026-01-01T00:00:00.000Z", approvedAt: "2026-01-02T00:00:00.000Z" },
      { itemId: "lark:2", type: "kol", sourceKorean: "다", convertedText: "라", status: "converted",
        createdAt: "2026-01-03T00:00:00.000Z" },
    ];
    expect(await roundTripOutput(join("variants", "variants.json"), variants)).toBe(JSON.stringify(variants, null, 2) + "\n");
  });

  it("formatted/renderings.json", async () => {
    const renderings = [
      { itemId: "x:1", type: "announcement", channel: "telegram", text: "hi", refined: false,
        createdAt: "2026-01-01T00:00:00.000Z", status: "approved", approvedAt: "2026-01-02T00:00:00.000Z" },
      { itemId: "x:2", type: "x", channel: "x", text: "yo", refined: true,
        createdAt: "2026-01-03T00:00:00.000Z", status: "rendered" },
    ];
    expect(await roundTripOutput(join("formatted", "renderings.json"), renderings)).toBe(JSON.stringify(renderings, null, 2) + "\n");
  });

  it("formatted/overrides.json", async () => {
    const overrides = [
      { itemId: "x:1", type: "announcement", outletId: "tg-a", text: "hi", status: "approved",
        createdAt: "2026-01-01T00:00:00.000Z", approvedAt: "2026-01-02T00:00:00.000Z" },
      { itemId: "x:2", type: "announcement", outletId: "tg-b", text: "yo", status: "rendered",
        createdAt: "2026-01-03T00:00:00.000Z" },
    ];
    expect(await roundTripOutput(join("formatted", "overrides.json"), overrides)).toBe(JSON.stringify(overrides, null, 2) + "\n");
  });

  it("publish/deliveries.json", async () => {
    const deliveries = [
      { itemId: "x:1", type: "announcement", outletId: "tg-a", status: "sent", at: "2026-01-01T00:00:00.000Z",
        by: "auto", postId: "p1", url: "https://t.me/a/1" },
      { itemId: "x:2", type: "announcement", outletId: "tg-b", status: "dropped", at: "2026-01-02T00:00:00.000Z",
        by: "manual", senderName: "kyle" },
    ];
    expect(await roundTripOutput(join("publish", "deliveries.json"), deliveries)).toBe(JSON.stringify(deliveries, null, 2) + "\n");
  });

  it("publish/x-article.json", async () => {
    const xArticles = [
      { itemId: "x:1", postId: "p1", url: "https://x.com/a/1", sentAt: "2026-01-01T00:00:00.000Z" },
      { itemId: "x:2", sentAt: "2026-01-02T00:00:00.000Z", droppedAt: "2026-01-03T00:00:00.000Z" },
    ];
    expect(await roundTripOutput(join("publish", "x-article.json"), xArticles)).toBe(JSON.stringify(xArticles, null, 2) + "\n");
  });

  it("publish/state.json", async () => {
    const state = {
      entries: [
        { itemId: "x:1", stage: "translation", status: "uploaded", target: "drive", fileName: "a.md",
          remoteId: "r1", url: "https://drive/a", contentHash: "h1", uploadedAt: "2026-01-01T00:00:00.000Z" },
        { itemId: "x:2", stage: "translation", status: "pending", target: "drive" },
      ],
    };
    expect(await roundTripOutput(join("publish", "state.json"), state)).toBe(JSON.stringify(state, null, 2) + "\n");
  });

  it("lineage/*.jsonl — multi-entry, multi-item, and stable across a second import and a second export", async () => {
    db = await createTestDb();
    const from = await mkdtemp(join(tmpdir(), "rt2-lineage-from-"));
    await mkdir(join(from, "lineage"), { recursive: true });
    const entriesA = [
      { itemId: "x:1", stage: "translated", content: "가", sourceText: "a", at: "2026-01-01T00:00:00.000Z" },
      { itemId: "x:1", stage: "converted", variant: "announcement", content: "나", status: "converted", at: "2026-01-02T00:00:00.000Z" },
    ];
    const entriesB = [
      { itemId: "lark:2", stage: "translated", content: "다", sourceText: "b", at: "2026-01-03T00:00:00.000Z" },
    ];
    const textA = entriesA.map((e) => JSON.stringify(e)).join("\n") + "\n";
    const textB = entriesB.map((e) => JSON.stringify(e)).join("\n") + "\n";
    await writeFile(join(from, "lineage", "x_1.jsonl"), textA, "utf8");
    await writeFile(join(from, "lineage", "lark_2.jsonl"), textB, "utf8");

    const report1 = await importOutputTree(db, from);
    expect(report1.lineageEntries).toBe(3);
    const report2 = await importOutputTree(db, from); // re-import must not duplicate
    expect(report2.lineageEntries).toBe(3);

    const to = await mkdtemp(join(tmpdir(), "rt2-lineage-to-"));
    await exportOutputTree(db, to);
    expect(await readFile(join(to, "lineage", "x_1.jsonl"), "utf8")).toBe(textA);
    expect(await readFile(join(to, "lineage", "lark_2.jsonl"), "utf8")).toBe(textB);

    // The regression this guards: exporting again into the SAME target — which is exactly what a
    // real `pnpm db:export` run against its own default `output/` looks like, not an edge case
    // reached only by re-running twice — must not append every line a second time on top of itself.
    await exportOutputTree(db, to);
    expect(await readFile(join(to, "lineage", "x_1.jsonl"), "utf8")).toBe(textA);
    expect(await readFile(join(to, "lineage", "lark_2.jsonl"), "utf8")).toBe(textB);
  });

  it("translation/few-shot.json and conversion/few-shot.<type>.json — the config-tree stores", async () => {
    db = await createTestDb();
    const outputFrom = await mkdtemp(join(tmpdir(), "rt2-cfgstore-out-from-"));
    const configFrom = await mkdtemp(join(tmpdir(), "rt2-cfgstore-cfg-from-"));
    await mkdir(join(configFrom, "translation"), { recursive: true });
    await mkdir(join(configFrom, "conversion"), { recursive: true });

    const translationFewShot = [
      { source: "gm mantle", target: "안녕하세요 맨틀입니다", itemId: "x:1" },
      { source: "no itemId example", target: "예시" },
    ];
    const conversionFewShot = [
      { source: "가", target: "나", itemId: "x:2" },
    ];
    const translationOriginal = JSON.stringify(translationFewShot, null, 2) + "\n";
    const conversionOriginal = JSON.stringify(conversionFewShot, null, 2) + "\n";
    await writeFile(join(configFrom, "translation", "few-shot.json"), translationOriginal, "utf8");
    await writeFile(join(configFrom, "conversion", "few-shot.announcement.json"), conversionOriginal, "utf8");

    const report = await importOutputTree(db, outputFrom, configFrom);
    expect(report.fewShotExamples).toBe(3);

    const outputTo = await mkdtemp(join(tmpdir(), "rt2-cfgstore-out-to-"));
    const configTo = await mkdtemp(join(tmpdir(), "rt2-cfgstore-cfg-to-"));
    await exportOutputTree(db, outputTo, configTo);

    expect(await readFile(join(configTo, "translation", "few-shot.json"), "utf8")).toBe(translationOriginal);
    expect(await readFile(join(configTo, "conversion", "few-shot.announcement.json"), "utf8")).toBe(conversionOriginal);
  });

  it("a zero-row store still exports [] rather than no file at all", async () => {
    db = await createTestDb();
    const to = await mkdtemp(join(tmpdir(), "rt2-empty-to-"));
    const configTo = await mkdtemp(join(tmpdir(), "rt2-empty-cfg-to-"));
    await exportOutputTree(db, to, configTo);

    expect(await readFile(join(to, "publish", "deliveries.json"), "utf8")).toBe("[]\n");
    expect(await readFile(join(to, "translations", "translations.json"), "utf8")).toBe("[]\n");
    expect(await readFile(join(configTo, "translation", "few-shot.json"), "utf8")).toBe("[]\n");
  });
});
