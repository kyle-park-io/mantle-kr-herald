import { describe, it, expect, afterEach } from "vitest";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createTestDb } from "../support/testDb";
import { importOutputTree } from "../../src/cli/db-import";
import { PgTranslationStore } from "../../src/adapters/store/PgTranslationStore";

let db: Awaited<ReturnType<typeof createTestDb>> | undefined;
afterEach(async () => { await db?.close(); db = undefined; });

async function tree(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "import-"));
  await mkdir(join(root, "translations"), { recursive: true });
  await writeFile(join(root, "translations", "translations.json"), JSON.stringify([
    { itemId: "x:1", source: "x", sourceText: "s", koreanText: "ko",
      status: "approved", translatedAt: "2026-01-01T00:00:00.000Z", approvedAt: "2026-01-02T00:00:00.000Z" },
  ], null, 2) + "\n", "utf8");
  return root;
}

// A generous per-test timeout, not the default 5000ms: each test here pays for a fresh
// PGlite instance (schema applied fresh — see `createTestDb`) *and* real file I/O, which under
// the full suite's parallel load (every other Pg*Store test spinning up its own PGlite
// instance at the same time) can comfortably exceed the default. Same rationale as the
// explicit timeouts in `tests/adapters/drive/drive.probe.test.ts`.
const SLOW = 20000;

describe("importOutputTree", () => {
  it("loads a translation from the output tree into the database", async () => {
    db = await createTestDb();
    await importOutputTree(db, await tree());
    const all = await new PgTranslationStore(db).loadAll();
    expect(all).toHaveLength(1);
    expect(all[0]?.approvedAt).toBe("2026-01-02T00:00:00.000Z");
  }, SLOW);

  it("is idempotent — importing the same tree twice leaves one row", async () => {
    db = await createTestDb();
    const root = await tree();
    await importOutputTree(db, root);
    await importOutputTree(db, root);
    expect(await new PgTranslationStore(db).loadAll()).toHaveLength(1);
  }, SLOW);

  it("treats an absent file as empty rather than failing", async () => {
    db = await createTestDb();
    const root = await mkdtemp(join(tmpdir(), "import-empty-"));
    await expect(importOutputTree(db, root)).resolves.not.toThrow();
  }, SLOW);
});
