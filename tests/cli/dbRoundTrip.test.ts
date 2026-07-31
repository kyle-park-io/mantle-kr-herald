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
  // Generous, not the default 5000ms: this test pays for a fresh PGlite instance plus an
  // import *and* an export, each doing real file I/O — under the full suite's parallel load
  // (every other Pg*Store test spinning up its own PGlite instance at the same time) that can
  // comfortably exceed the default. Same rationale as the explicit timeouts in
  // `tests/adapters/drive/drive.probe.test.ts`.
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
  }, 20000);
});
