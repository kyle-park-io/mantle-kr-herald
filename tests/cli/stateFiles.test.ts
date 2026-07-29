import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { describeStateDiff, trackedStateFiles } from "../../src/cli/stateFiles";
import { paths } from "../../src/paths";
import { JsonDeliveryLedger } from "../../src/adapters/store/JsonDeliveryLedger";
import { JsonOutletOverrideStore } from "../../src/adapters/store/JsonOutletOverrideStore";
import { JsonPublishStore } from "../../src/adapters/store/JsonPublishStore";
import { JsonXArticleLedger } from "../../src/adapters/store/JsonXArticleLedger";

describe("the operational-state manifest", () => {
  it("tracks exactly the four non-regenerable files, repo-relative", () => {
    expect(trackedStateFiles().map((f) => f.rel)).toEqual([
      "output/formatted/overrides.json",
      "output/publish/deliveries.json",
      "output/publish/x-article.json",
      "output/publish/state.json",
    ]);
  });

  it("points at the same absolute paths as src/paths.ts", () => {
    expect(trackedStateFiles().map((f) => f.abs)).toEqual([
      paths.formattedOverrides,
      paths.publishDeliveries,
      paths.publishXArticle,
      paths.publishState,
    ]);
  });
});

describe("what the dry run shows the operator", () => {
  it("puts the current row count beside the snapshot's, not just a file name", () => {
    const lines = describeStateDiff([
      { path: "output/publish/deliveries.json", current: 128, incoming: 3, change: "overwrite" },
    ]);
    expect(lines).toEqual(["  덮어씀  output/publish/deliveries.json — 현재 128행 → 스냅샷 3행"]);
  });

  it("says a restore has nothing to lose, and a kept file is left alone", () => {
    expect(
      describeStateDiff([
        { path: "output/formatted/overrides.json", incoming: 4, change: "restore" },
        { path: "output/publish/x-article.json", current: 9, change: "keep" },
      ]),
    ).toEqual([
      "  복원    output/formatted/overrides.json — 현재 없음 → 스냅샷 4행",
      "  유지    output/publish/x-article.json — 현재 9행 (스냅샷에 없음, 그대로 둡니다)",
    ]);
  });

  it("never shows an uncountable file as empty", () => {
    // "0행" would read as "nothing to lose" for a file we simply failed to parse.
    const [line] = describeStateDiff([{ path: "output/publish/state.json", current: undefined, incoming: 2, change: "overwrite" }]);
    expect(line).toContain("현재 행 수 알 수 없음");
    expect(line).not.toContain("0행");
  });
});

/**
 * The manifest names files by hand; the stores name them independently. If a store is ever renamed,
 * `state:push` would keep succeeding and quietly back up nothing — the exact silent-loss failure
 * this feature exists to close. So drive each store for real and compare file names.
 */
describe("the manifest matches what the stores actually write", () => {
  let dir: string;
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "herald-manifest-"));
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  const written = async (): Promise<string[]> => (await readdir(dir)).filter((n) => n.endsWith(".json"));

  it("overrides.json is what JsonOutletOverrideStore writes", async () => {
    await new JsonOutletOverrideStore(dir).upsert({
      itemId: "x:1",
      type: "announcement",
      outletId: "tg-dev",
      text: "포크",
      status: "rendered",
      createdAt: "2026-07-29T00:00:00.000Z",
    });
    expect(await written()).toEqual([basename(paths.formattedOverrides)]);
  });

  it("deliveries.json is what JsonDeliveryLedger writes", async () => {
    await new JsonDeliveryLedger(dir).add({
      itemId: "x:1",
      type: "announcement",
      outletId: "tg-dev",
      status: "sent",
      at: "2026-07-29T00:00:00.000Z",
      by: "auto",
    });
    expect(await written()).toEqual([basename(paths.publishDeliveries)]);
  });

  it("x-article.json is what JsonXArticleLedger writes", async () => {
    await new JsonXArticleLedger(dir).add({ itemId: "x:1", sentAt: "2026-07-29T00:00:00.000Z" });
    expect(await written()).toEqual([basename(paths.publishXArticle)]);
  });

  it("state.json is what JsonPublishStore writes", async () => {
    await new JsonPublishStore(dir).record({ itemId: "x:1", stage: "translation", status: "approved", target: "gdrive" });
    expect(await written()).toEqual([basename(paths.publishState)]);
  });
});
