import { describe, it, expect, afterEach } from "vitest";
import { mkdtemp, mkdir, readFile, writeFile } from "node:fs/promises";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createTestDb, createUnmigratedTestDb } from "../support/testDb";
import { exportOutputTree, previewExport } from "../../src/cli/db-export";

let db: Awaited<ReturnType<typeof createTestDb>> | undefined;
afterEach(async () => {
  await db?.close();
  db = undefined;
});

/**
 * `db:export` with no arguments defaults its target to the real `output/` tree. An empty database
 * (wrong `HERALD_DB_ENV`, or one `db:import` was never run against) exporting over that populated
 * tree used to rewrite every array-shaped store's file to `[]` with no preview, no `--yes` and no
 * confirmation — the asymmetric opposite of `db:import`, which previews by default and refuses
 * production outright. These tests pin the fix: refuse the write outright and leave every file on
 * disk exactly as it was.
 */
describe("exportOutputTree — refuses to overwrite a populated file with an empty export", () => {
  it("refuses when the database has zero deliveries but deliveries.json already holds sent rows, and leaves it untouched", async () => {
    db = await createTestDb();
    const root = await mkdtemp(join(tmpdir(), "export-guard-"));
    await mkdir(join(root, "publish"), { recursive: true });
    const original =
      JSON.stringify(
        [
          {
            itemId: "x:1",
            type: "announcement",
            outletId: "tg-community",
            status: "sent",
            at: "2026-07-29T00:00:00.000Z",
            by: "auto",
          },
        ],
        null,
        2,
      ) + "\n";
    await writeFile(join(root, "publish", "deliveries.json"), original, "utf8");

    await expect(exportOutputTree(db, root)).rejects.toThrow(/deliveries\.json/);
    expect(await readFile(join(root, "publish", "deliveries.json"), "utf8")).toBe(original);
  });

  it("catches the hazard before any store is written — a populated translations.json survives even though deliveries.json is also populated and empty in the database", async () => {
    db = await createTestDb();
    const root = await mkdtemp(join(tmpdir(), "export-guard-multi-"));
    await mkdir(join(root, "translations"), { recursive: true });
    await mkdir(join(root, "publish"), { recursive: true });
    const translationsOriginal =
      JSON.stringify(
        [
          {
            itemId: "x:1",
            source: "x",
            sourceText: "s",
            koreanText: "ko",
            status: "translated",
            translatedAt: "2026-01-01T00:00:00.000Z",
          },
        ],
        null,
        2,
      ) + "\n";
    const deliveriesOriginal =
      JSON.stringify(
        [
          {
            itemId: "x:1",
            type: "announcement",
            outletId: "tg-community",
            status: "sent",
            at: "2026-07-29T00:00:00.000Z",
            by: "auto",
          },
        ],
        null,
        2,
      ) + "\n";
    await writeFile(join(root, "translations", "translations.json"), translationsOriginal, "utf8");
    await writeFile(join(root, "publish", "deliveries.json"), deliveriesOriginal, "utf8");

    await expect(exportOutputTree(db, root)).rejects.toThrow();

    expect(await readFile(join(root, "translations", "translations.json"), "utf8")).toBe(translationsOriginal);
    expect(await readFile(join(root, "publish", "deliveries.json"), "utf8")).toBe(deliveriesOriginal);
  });

  it("refuses over a populated few-shot corpus too, when a configRoot is given", async () => {
    db = await createTestDb();
    const root = await mkdtemp(join(tmpdir(), "export-guard-fewshot-out-"));
    const configRoot = await mkdtemp(join(tmpdir(), "export-guard-fewshot-cfg-"));
    await mkdir(join(configRoot, "translation"), { recursive: true });
    const original = JSON.stringify([{ source: "gm mantle", target: "안녕하세요 맨틀입니다" }], null, 2) + "\n";
    await writeFile(join(configRoot, "translation", "few-shot.json"), original, "utf8");

    await expect(exportOutputTree(db, root, configRoot)).rejects.toThrow(/few-shot\.json/);
    expect(await readFile(join(configRoot, "translation", "few-shot.json"), "utf8")).toBe(original);
  });

  it("allows the empty overwrite when --allow-empty-overwrite is passed explicitly", async () => {
    db = await createTestDb();
    const root = await mkdtemp(join(tmpdir(), "export-guard-allow-"));
    await mkdir(join(root, "publish"), { recursive: true });
    await writeFile(
      join(root, "publish", "deliveries.json"),
      JSON.stringify([
        {
          itemId: "x:1",
          type: "announcement",
          outletId: "tg-community",
          status: "sent",
          at: "2026-07-29T00:00:00.000Z",
          by: "auto",
        },
      ]),
      "utf8",
    );

    const report = await exportOutputTree(db, root, undefined, { allowEmptyOverwrite: true });
    expect(report.deliveries).toBe(0);
    expect(await readFile(join(root, "publish", "deliveries.json"), "utf8")).toBe("[]\n");
  });

  it("does not flag x/items.json or lark/items.json — their write path merges rather than overwrites, so an empty database cannot wipe them", async () => {
    db = await createTestDb();
    const root = await mkdtemp(join(tmpdir(), "export-guard-merge-safe-"));
    await mkdir(join(root, "x"), { recursive: true });
    const threads = [
      {
        rootId: "1001",
        tweets: [
          {
            id: "1001",
            conversationId: "1001",
            text: "gm mantle",
            createdAt: "2026-01-01T00:00:00.000Z",
            url: "https://x.com/mantle/status/1001",
            authorUserName: "mantle_official",
            isReply: false,
            isQuote: false,
          },
        ],
        status: "active",
        firstSeenAt: "2026-01-01T00:05:00.000Z",
      },
    ];
    await writeFile(join(root, "x", "items.json"), JSON.stringify(threads, null, 2) + "\n", "utf8");

    const report = await exportOutputTree(db, root);
    expect(report.xThreads).toBe(0);
    expect(JSON.parse(await readFile(join(root, "x", "items.json"), "utf8"))).toEqual(threads);
  });

  it("does not refuse when both sides are empty — a genuinely fresh target directory exports [] normally", async () => {
    db = await createTestDb();
    const root = await mkdtemp(join(tmpdir(), "export-guard-fresh-"));
    const report = await exportOutputTree(db, root);
    expect(report.deliveries).toBe(0);
    expect(await readFile(join(root, "publish", "deliveries.json"), "utf8")).toBe("[]\n");
  });

  it("catches the hazard on a legacy-layout tree too — populated channels.json, deliveries.json entirely absent — instead of reading zero rows and permanently shadowing it", async () => {
    db = await createTestDb();
    const root = await mkdtemp(join(tmpdir(), "export-guard-legacy-"));
    await mkdir(join(root, "publish"), { recursive: true });
    const legacy = [
      { itemId: "x:1", type: "announcement", channel: "telegram", senderName: "auto", sentAt: "2026-07-29T00:00:00.000Z" },
    ];
    const legacyOriginal = JSON.stringify(legacy, null, 2) + "\n";
    await writeFile(join(root, "publish", "channels.json"), legacyOriginal, "utf8");

    await expect(exportOutputTree(db, root)).rejects.toThrow(/deliveries\.json/);

    // Refusing must leave the tree exactly as it was — in particular, must NOT write
    // deliveries.json = [], which would permanently shadow channels.json behind
    // JsonDeliveryLedger.loadAll()'s exclusive-or from this point on.
    await expect(readFile(join(root, "publish", "deliveries.json"), "utf8")).rejects.toThrow();
    expect(await readFile(join(root, "publish", "channels.json"), "utf8")).toBe(legacyOriginal);
  });

  it("reports a readable error, not a bare TypeError, when a store's file holds null instead of an array", async () => {
    db = await createTestDb();
    const root = await mkdtemp(join(tmpdir(), "export-guard-corrupt-"));
    await mkdir(join(root, "translations"), { recursive: true });
    await writeFile(join(root, "translations", "translations.json"), "null\n", "utf8");

    await expect(exportOutputTree(db, root)).rejects.toThrow(/translations\.json.*JSON array/);
  });
});

describe("previewExport", () => {
  it("reports current (on-disk) vs incoming (database) counts without writing anything", async () => {
    db = await createTestDb();
    const root = await mkdtemp(join(tmpdir(), "export-preview-"));
    await mkdir(join(root, "publish"), { recursive: true });
    await writeFile(
      join(root, "publish", "deliveries.json"),
      JSON.stringify([
        {
          itemId: "x:1",
          type: "announcement",
          outletId: "tg-community",
          status: "sent",
          at: "2026-07-29T00:00:00.000Z",
          by: "auto",
        },
      ]),
      "utf8",
    );

    const preview = await previewExport(db, root);
    expect(preview.deliveries).toEqual({ current: 1, incoming: 0 });

    // Read-only: the file on disk is untouched.
    expect(JSON.parse(await readFile(join(root, "publish", "deliveries.json"), "utf8"))).toHaveLength(1);
  });

  it("reports zero-zero for every store on an empty database and an empty tree", async () => {
    db = await createTestDb();
    const root = await mkdtemp(join(tmpdir(), "export-preview-empty-"));
    const preview = await previewExport(db, root);
    for (const key of Object.keys(preview) as (keyof typeof preview)[]) {
      expect(preview[key]).toEqual({ current: 0, incoming: 0 });
    }
  });

  it("tolerates a database whose schema was never applied, reporting 0 for every incoming count instead of creating it", async () => {
    db = await createUnmigratedTestDb();
    const root = await mkdtemp(join(tmpdir(), "export-preview-unmigrated-"));
    const preview = await previewExport(db, root);
    for (const key of Object.keys(preview) as (keyof typeof preview)[]) {
      expect(preview[key]).toEqual({ current: 0, incoming: 0 });
    }
  });

  /**
   * Pins the mechanism, not just the outcome above: a preview is reachable flagless against
   * production and against a mistyped `DATABASE_URL`, where creating eleven tables as a side effect
   * of merely computing a preview would be its own hazard. `previewExport` must reach the same
   * all-zero `incoming` counts by catching "relation ... does not exist" per store (`previewCount`,
   * `dbStores.ts`), not by calling `applySchema` — the outcome-only assertion above cannot tell a
   * caught-error path from a schema quietly created as a side effect.
   */
  it("previewExport issues no DDL — the schema is still absent after it runs", async () => {
    db = await createUnmigratedTestDb();
    const root = await mkdtemp(join(tmpdir(), "export-preview-no-ddl-"));
    await previewExport(db, root);
    await expect(db.query("select 1 from deliveries limit 1")).rejects.toThrow(/relation .* does not exist/i);
  });
});

/**
 * The entry-guard block is unreachable from a test — it is only entered when this module is the
 * process's own argv[1] — so its one line about the target is pinned as source text, the same way
 * `tests/cli/stateFiles.test.ts` pins which store the state commands build.
 *
 * Worth pinning because the two commands share `describeBackupTarget` and only one of them wants all
 * of it: `state:push` exists to protect production, so a development target there is the accident
 * the ⚠ was written for. `db:export` is the rollback path, and exporting the development database is
 * one of its intended uses — an operator who followed "point DATABASE_URL at production instead"
 * here would overwrite their local corpus files with production's, which is the loss `db:export`
 * exists to undo.
 */
describe("db:export prints the target without state:push's production advice", () => {
  const source = readFileSync(fileURLToPath(new URL("../../src/cli/db-export.ts", import.meta.url)), "utf8");

  it("opts out of the development warning", () => {
    expect(source).toContain("describeBackupTarget(cfg, { warnOnDevelopment: false })");
  });

  it("still prints the host line, which is the half both commands need", () => {
    expect(source).toMatch(/for \(const line of describeBackupTarget\(cfg, \{ warnOnDevelopment: false \}\)\) console\.log\(line\)/);
  });
});
