import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { JsonCollectionRunLedger } from "../../../src/adapters/store/JsonCollectionRunLedger";
import type { CollectionRun } from "../../../src/domain/coverage";

let dir: string;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "runs-"));
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

function run(target: string, ranAt: string): CollectionRun {
  return { target, ranAt, requested: { since: null, until: ranAt }, covered: null,
    threadCount: 0, tweetCount: 0, truncated: false, gap: null };
}

describe("JsonCollectionRunLedger", () => {
  it("appends records in order without clobbering prior ones", async () => {
    const path = join(dir, "runs.json");
    const ledger = new JsonCollectionRunLedger(path);
    await ledger.record(run("Mantle_Official", "2026-07-21T08:00:00.000Z"));
    await ledger.record(run("Mantle_Official", "2026-07-21T09:00:00.000Z"));

    const { readJsonFile } = await import("../../../src/shared/store/jsonFile");
    const all = await readJsonFile<CollectionRun[]>(path, []);
    expect(all).toHaveLength(2);
    expect(all.map((r) => r.ranAt)).toEqual([
      "2026-07-21T08:00:00.000Z",
      "2026-07-21T09:00:00.000Z",
    ]);
  });
});
