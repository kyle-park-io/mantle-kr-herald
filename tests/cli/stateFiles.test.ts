import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { describeKeptFiles, describeProvisionedFolder, describeStateDiff, trackedStateFiles } from "../../src/cli/stateFiles";
import { diffRowCounts } from "../../src/domain/state/snapshot";
import { paths } from "../../src/paths";
import { JsonConversionStore } from "../../src/adapters/store/JsonConversionStore";
import { JsonDeliveryLedger } from "../../src/adapters/store/JsonDeliveryLedger";
import { JsonOutletOverrideStore } from "../../src/adapters/store/JsonOutletOverrideStore";
import { JsonPublishStore } from "../../src/adapters/store/JsonPublishStore";
import { JsonTranslationStore } from "../../src/adapters/store/JsonTranslationStore";
import { JsonXArticleLedger } from "../../src/adapters/store/JsonXArticleLedger";

describe("the operational-state manifest", () => {
  // Pipeline order (translate → convert → format → send), because this is the order the dry-run
  // preview prints for an operator deciding what to overwrite.
  it("tracks exactly the non-regenerable files, repo-relative", () => {
    expect(trackedStateFiles().map((f) => f.rel)).toEqual([
      "output/translations/translations.json",
      "output/variants/variants.json",
      "output/formatted/overrides.json",
      "output/publish/deliveries.json",
      "output/publish/channels.json",
      "output/publish/x-article.json",
      "output/publish/state.json",
    ]);
  });

  it("points at the same absolute paths as src/paths.ts", () => {
    expect(trackedStateFiles().map((f) => f.abs)).toEqual([
      paths.translationsStore,
      paths.variantsStore,
      paths.formattedOverrides,
      paths.publishDeliveries,
      paths.publishChannelsLegacy,
      paths.publishXArticle,
      paths.publishState,
    ]);
  });

  it("includes the legacy channels.json — a pre-outlet install's only send history", () => {
    // Omitting it means a pre-#80 machine pushes a snapshot with no send history in it at all, and
    // restores to a tree where every already-sent room reads as never-sent.
    expect(trackedStateFiles().map((f) => f.rel)).toContain("output/publish/channels.json");
  });

  /**
   * The two authored-text stores, and the distinction that decides membership: `format` really does
   * rebuild `renderings.json` from the variants (that is what the board's `[포맷 다시]` runs), but
   * nothing rebuilds the variants themselves — they hold what an agent wrote and a human then
   * approved. Re-running the pipeline produces *a* conversion, not *that* one, and drops every
   * approval standing on the old text.
   *
   * Asserted as a pair with the exclusion, so "add renderings.json too, for symmetry" fails here
   * with the reason attached rather than looking like an oversight.
   */
  it("tracks the authored text and not the text that regenerates from it", () => {
    const rel = trackedStateFiles().map((f) => f.rel);
    expect(rel).toContain("output/translations/translations.json");
    expect(rel).toContain("output/variants/variants.json");
    expect(rel).not.toContain("output/formatted/renderings.json");
    expect(rel).not.toContain("output/x/items.json");
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

  it("renders real file contents end to end — countRows joined to the printed line", () => {
    // The two halves are tested apart everywhere else: the domain test builds diffs and checks
    // numbers, this file builds diffs by hand and checks strings. Nothing pins them together, so a
    // change to `countRows`' shape handling could stop reaching the operator's screen unnoticed.
    // Start from file *contents* and assert on the finished lines.
    const local = [
      { path: "output/publish/deliveries.json", content: JSON.stringify([{ a: 1 }, { a: 2 }]) },
      { path: "output/publish/state.json", content: '{"published":["x:1:approved:gdrive"]}' }, // legacy shape
      { path: "output/publish/x-article.json", content: "corrupt {{{" },
    ];
    const incoming = [
      { path: "output/publish/deliveries.json", content: JSON.stringify([{ a: 1 }]) },
      { path: "output/publish/state.json", content: '{"entries":[{"itemId":"x:1"},{"itemId":"x:2"}]}' },
      { path: "output/formatted/overrides.json", content: JSON.stringify([{ a: 1 }, { a: 2 }, { a: 3 }]) },
    ];

    expect(describeStateDiff(diffRowCounts(local, incoming))).toEqual([
      "  덮어씀  output/publish/deliveries.json — 현재 2행 → 스냅샷 1행",
      "  덮어씀  output/publish/state.json — 현재 1행 → 스냅샷 2행",
      "  복원    output/formatted/overrides.json — 현재 없음 → 스냅샷 3행",
      "  유지    output/publish/x-article.json — 현재 행 수 알 수 없음 (스냅샷에 없음, 그대로 둡니다)",
    ]);
  });

  it("never shows an uncountable file as empty", () => {
    // "0행" would read as "nothing to lose" for a file we simply failed to parse.
    const [line] = describeStateDiff([{ path: "output/publish/state.json", current: undefined, incoming: 2, change: "overwrite" }]);
    expect(line).toContain("현재 행 수 알 수 없음");
    expect(line).not.toContain("0행");
  });
});

describe("what the operator is told after a --yes run", () => {
  it("says nothing extra when the restore covered every file", () => {
    expect(
      describeKeptFiles([
        { path: "output/publish/deliveries.json", current: 1, incoming: 2, change: "overwrite" },
        { path: "output/formatted/overrides.json", incoming: 3, change: "restore" },
      ]),
    ).toBeUndefined();
  });

  it("names the kept files, because the summary line alone reads like a complete restore", () => {
    const msg = describeKeptFiles([
      { path: "output/publish/deliveries.json", current: 1, incoming: 2, change: "overwrite" },
      { path: "output/publish/x-article.json", current: 9, change: "keep" },
      { path: "output/publish/channels.json", current: 4, change: "keep" },
    ]);
    expect(msg).toContain("2개 파일");
    expect(msg).toContain("output/publish/x-article.json");
    expect(msg).toContain("output/publish/channels.json");
    expect(msg).toContain("섞여");
  });
});

describe("what state:push says about the folder it provisioned", () => {
  it("distinguishes a folder it created from one it merely found", () => {
    const created = describeProvisionedFolder({ created: true, name: "operational-state", id: "F1", parentName: "Mantle KR Herald" });
    const found = describeProvisionedFolder({ created: false, name: "operational-state", id: "F1", parentName: "Mantle KR Herald" });
    expect(created).toContain("새로 만들었습니다");
    expect(created).not.toContain("찾았습니다");
    // The .env-lost-but-Drive-intact recovery: months of snapshots are sitting there already.
    expect(found).toContain("찾았습니다");
    expect(found).toContain("기존 스냅샷이 그대로 있습니다");
    expect(found).not.toContain("만들었습니다");
  });

  it("mentions the parent only when there is one (drive-root fallback)", () => {
    expect(describeProvisionedFolder({ created: true, name: "operational-state", id: "F1" })).not.toContain("상위");
    expect(describeProvisionedFolder({ created: true, name: "operational-state", id: "F1", parentName: "P" })).toContain('상위: "P"');
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

  it("translations.json is what JsonTranslationStore writes", async () => {
    await new JsonTranslationStore(dir).upsert({
      itemId: "x:1",
      source: "x",
      sourceText: "source",
      koreanText: "번역",
      status: "approved",
      translatedAt: "2026-07-29T00:00:00.000Z",
    });
    expect(await written()).toEqual([basename(paths.translationsStore)]);
  });

  it("variants.json is what JsonConversionStore writes", async () => {
    await new JsonConversionStore(dir).upsert({
      itemId: "x:1",
      type: "explainer",
      sourceKorean: "번역",
      convertedText: "해설",
      status: "converted",
      createdAt: "2026-07-29T00:00:00.000Z",
    });
    expect(await written()).toEqual([basename(paths.variantsStore)]);
  });

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

  it("channels.json is the file JsonDeliveryLedger still falls back to", async () => {
    // Nothing writes this any more, so it cannot be checked by driving a store. Drive the *read*
    // instead: a legacy row placed at the manifest's path must come back migrated, which is only
    // true if the ledger's private legacy path is that same file name.
    await writeFile(
      join(dir, basename(paths.publishChannelsLegacy)),
      JSON.stringify([{ itemId: "x:1", type: "announcement", channel: "telegram", senderName: "bot", sentAt: "2026-07-29T00:00:00.000Z" }]),
      "utf8",
    );
    const rows = await new JsonDeliveryLedger(dir).loadAll();
    expect(rows).toHaveLength(1);
    expect(rows[0].status).toBe("sent");
    expect(rows[0].itemId).toBe("x:1");
  });

  it("state.json is what JsonPublishStore writes", async () => {
    await new JsonPublishStore(dir).record({ itemId: "x:1", stage: "translation", status: "approved", target: "gdrive" });
    expect(await written()).toEqual([basename(paths.publishState)]);
  });
});
