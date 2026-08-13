import { describe, it, expect, afterEach } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import {
  describeKeptFiles,
  describeProvisionedFolder,
  describeStateDiff,
  snapshotFromDb,
  DbStateFileStore,
  createStateFileStore,
} from "../../src/cli/stateFiles";
import { diffRowCounts } from "../../src/domain/state/snapshot";
import { createTestDb } from "../support/testDb";
import { PgTranslationStore } from "../../src/adapters/store/PgTranslationStore";
import { PgConversionStore } from "../../src/adapters/store/PgConversionStore";
import { PgFormattingStore } from "../../src/adapters/store/PgFormattingStore";
import { PgOutletOverrideStore } from "../../src/adapters/store/PgOutletOverrideStore";
import { PgDeliveryLedger } from "../../src/adapters/store/PgDeliveryLedger";
import { PgXArticleLedger } from "../../src/adapters/store/PgXArticleLedger";
import { PgPublishStore } from "../../src/adapters/store/PgPublishStore";
import { PgFewShotStore, fewShotStoresByType } from "../../src/adapters/store/PgFewShotStore";
import { FEW_SHOT_REL } from "../../src/domain/state/fewShot";

let db: Awaited<ReturnType<typeof createTestDb>> | undefined;
afterEach(async () => {
  await db?.close();
  db = undefined;
});

describe("the operational-state manifest", () => {
  // Pipeline order (translate → convert → format → send), because this is the order the dry-run
  // preview prints for an operator deciding what to overwrite.
  it("tracks exactly the non-regenerable stores, repo-relative", async () => {
    db = await createTestDb();
    // The seven pipeline stores, plus one few-shot path per corpus (`FEW_SHOT_REL` —
    // `translation` plus one per `ALL_TYPES` member): a few-shot row is authored text no
    // command re-derives, same membership test as the seven above it.
    expect(new DbStateFileStore(db).tracked()).toEqual([
      "output/translations/translations.json",
      "output/variants/variants.json",
      "output/formatted/renderings.json",
      "output/formatted/overrides.json",
      "output/publish/deliveries.json",
      "output/publish/x-article.json",
      "output/publish/state.json",
      ...FEW_SHOT_REL,
    ]);
  });

  it("does not carry the pre-outlet publish/channels.json forward — its rows are already inside deliveries by the time a database exists to snapshot", async () => {
    // Unlike the old file-based manifest, channels.json is never produced by this store and is not
    // in its tracked() list: db:import already folded any legacy row into `deliveries` (via
    // JsonDeliveryLedger's own exclusive-or), so there is no separate legacy shape left in Postgres.
    // An old snapshot that still names it hits `unknownStatePaths`'s "upgrade before restoring"
    // refusal instead — the correct outcome for a pre-cutover snapshot, not a gap to route around.
    db = await createTestDb();
    expect(new DbStateFileStore(db).tracked()).not.toContain("output/publish/channels.json");
  });

  /**
   * `renderings.json` now joins the tracked set, reversing this file's own former exclusion: the
   * regeneration argument ("format is pure code over variants") only ever covered the rendered
   * *text*, never `ChannelRendering.status`/`approvedAt` (the §7 second-review approval gate) or
   * `refined` — real reviewer work a fresh `format` run cannot reproduce.
   */
  it("tracks the authored text and the reviewer's rendering approval alike", async () => {
    db = await createTestDb();
    const rel = new DbStateFileStore(db).tracked();
    expect(rel).toContain("output/translations/translations.json");
    expect(rel).toContain("output/variants/variants.json");
    expect(rel).toContain("output/formatted/renderings.json");
  });
});

describe("snapshotFromDb", () => {
  it("snapshots the database through the same seven-file bundle", async () => {
    db = await createTestDb();
    await new PgTranslationStore(db).upsert({
      itemId: "x:1", source: "x", sourceText: "s", koreanText: "ko",
      status: "approved", translatedAt: "2026-01-01T00:00:00.000Z",
    });
    const files = await snapshotFromDb(db);
    const translations = files.find((f) => f.rel === "output/translations/translations.json");
    expect(translations).toBeDefined();
    expect(JSON.parse(translations!.body)).toHaveLength(1);
  });

  it("returns [] for a freshly provisioned, still-empty database — nothing to push", async () => {
    db = await createTestDb();
    expect(await snapshotFromDb(db)).toEqual([]);
  });

  it("omits a store with zero rows rather than writing an empty shape", async () => {
    db = await createTestDb();
    await new PgTranslationStore(db).upsert({
      itemId: "x:1", source: "x", sourceText: "s", koreanText: "ko",
      status: "approved", translatedAt: "2026-01-01T00:00:00.000Z",
    });
    const files = await snapshotFromDb(db);
    expect(files.map((f) => f.rel)).toEqual(["output/translations/translations.json"]);
  });

  it("serialises each tracked store to the exact bytes its Json* store would have written", async () => {
    db = await createTestDb();
    await new PgTranslationStore(db).upsert({
      itemId: "x:1", source: "x", sourceText: "s", koreanText: "ko",
      status: "approved", translatedAt: "2026-01-01T00:00:00.000Z",
    });
    await new PgConversionStore(db).upsert({
      itemId: "x:1", type: "explainer", sourceKorean: "ko", convertedText: "conv",
      status: "converted", createdAt: "2026-01-01T00:00:00.000Z",
    });
    await new PgFormattingStore(db).upsert({
      itemId: "x:1", type: "explainer", channel: "telegram", text: "t",
      refined: false, createdAt: "2026-01-01T00:00:00.000Z", status: "approved",
    });
    await new PgOutletOverrideStore(db).upsert({
      itemId: "x:1", type: "announcement", outletId: "tg-dev", text: "fork",
      status: "rendered", createdAt: "2026-01-01T00:00:00.000Z",
    });
    await new PgDeliveryLedger(db).add({
      itemId: "x:1", type: "announcement", outletId: "tg-dev",
      status: "sent", at: "2026-01-01T00:00:00.000Z", by: "auto",
    });
    await new PgXArticleLedger(db).add({ itemId: "x:1", sentAt: "2026-01-01T00:00:00.000Z" });
    await new PgPublishStore(db).record({ itemId: "x:1", stage: "translation", status: "approved", target: "gdrive" });

    const files = await snapshotFromDb(db);
    const byRel = new Map(files.map((f) => [f.rel, f.body]));

    expect(JSON.parse(byRel.get("output/translations/translations.json")!)).toEqual(
      await new PgTranslationStore(db).loadAll(),
    );
    expect(JSON.parse(byRel.get("output/variants/variants.json")!)).toEqual(await new PgConversionStore(db).loadAll());
    expect(JSON.parse(byRel.get("output/formatted/renderings.json")!)).toEqual(await new PgFormattingStore(db).loadAll());
    expect(JSON.parse(byRel.get("output/formatted/overrides.json")!)).toEqual(await new PgOutletOverrideStore(db).loadAll());
    expect(JSON.parse(byRel.get("output/publish/deliveries.json")!)).toEqual(await new PgDeliveryLedger(db).loadAll());
    expect(JSON.parse(byRel.get("output/publish/x-article.json")!)).toEqual(await new PgXArticleLedger(db).loadAll());
    expect(JSON.parse(byRel.get("output/publish/state.json")!)).toEqual({
      entries: await new PgPublishStore(db).listEntries(),
    });
    // 2-space indent, trailing newline — the same shape writeJsonFileAtomic produces on disk.
    expect(byRel.get("output/translations/translations.json")!.endsWith("\n")).toBe(true);
  });
});

describe("snapshotFromDb — few-shot corpora", () => {
  it("omits a corpus with no rows, like every other empty store", async () => {
    db = await createTestDb();
    const files = await snapshotFromDb(db);
    expect(files.map((f) => f.rel)).not.toContain("output/few-shot/translation.json");
  });

  it("writes the translation corpus at its tracked path", async () => {
    db = await createTestDb();
    const store = new PgFewShotStore(db, "translation");
    await store.add({ source: "a", target: "가", itemId: "x:1" });
    await store.add({ source: "b", target: "나", itemId: "x:2" });

    const files = await snapshotFromDb(db);
    const file = files.find((f) => f.rel === "output/few-shot/translation.json");
    expect(file).toBeDefined();
    expect(JSON.parse(file!.body)).toEqual([
      { source: "a", target: "가", itemId: "x:1" },
      { source: "b", target: "나", itemId: "x:2" },
    ]);
  });

  it("preserves ordinal order, which is what the prompt reads", async () => {
    // PgFewShotStore.load() is `order by ordinal`, and translate:prepare / convert:prepare lay that
    // order straight into the prompt. A snapshot that recovers the right SET in the wrong ORDER
    // silently changes what the model sees, with nothing failing to say so.
    db = await createTestDb();
    const store = new PgFewShotStore(db, "translation");
    for (const n of ["1", "2", "3", "4"]) await store.add({ source: n, target: n, itemId: `x:${n}` });

    const files = await snapshotFromDb(db);
    const body = files.find((f) => f.rel === "output/few-shot/translation.json")!.body;
    expect((JSON.parse(body) as { source: string }[]).map((e) => e.source)).toEqual(["1", "2", "3", "4"]);
  });

  it("writes each conversion type at its own tracked path", async () => {
    db = await createTestDb();
    const byType = fewShotStoresByType(db);
    await byType.x.add({ source: "sx", target: "tx", itemId: "x:1" });
    await byType.announcement.add({ source: "sa", target: "ta", itemId: "x:2" });

    const rels = (await snapshotFromDb(db)).map((f) => f.rel);
    expect(rels).toContain("output/few-shot/conversion.x.json");
    expect(rels).toContain("output/few-shot/conversion.announcement.json");
    expect(rels).not.toContain("output/few-shot/conversion.kol.json");
  });

  it("snapshots a corpus holding an itemId-less example instead of refusing", async () => {
    // This read used to throw for exactly this row, on the push path. `PgFewShotStore.replaceAll`
    // deletes the scope and replays the snapshot in one transaction, so the row restores exactly
    // once however many times you pull — the refusal was declining to back up data that restores
    // perfectly, and on `herald-backup.timer` it would have failed the unit nightly. The finding
    // itself moved to `pnpm doctor` (`src/doctor/fewShot.ts`); nothing in the snapshot path grades
    // corpus content any more.
    db = await createTestDb();
    await new PgFewShotStore(db, "translation").add({ source: "a", target: "가" });
    const files = await snapshotFromDb(db);
    expect(files.map((f) => f.rel)).toContain("output/few-shot/translation.json");
    expect(JSON.parse(files.find((f) => f.rel === "output/few-shot/translation.json")!.body)).toEqual([
      { source: "a", target: "가" },
    ]);
  });

  it("tracked() lists the seven original paths plus every few-shot path", async () => {
    db = await createTestDb();
    const tracked = createStateFileStore(db).tracked();
    expect(tracked).toContain("output/translations/translations.json");
    expect(tracked).toContain("output/publish/state.json");
    for (const rel of FEW_SHOT_REL) expect(tracked).toContain(rel);
  });
});

describe("DbStateFileStore.write", () => {
  it("upserts each row into its store, by the store's own natural key", async () => {
    db = await createTestDb();
    const store = new DbStateFileStore(db);
    await store.write(
      "output/translations/translations.json",
      JSON.stringify([
        { itemId: "x:1", source: "x", sourceText: "s", koreanText: "ko", status: "approved", translatedAt: "2026-01-01T00:00:00.000Z" },
      ]),
    );
    expect(await new PgTranslationStore(db).loadAll()).toHaveLength(1);

    // A second write with the same itemId upserts rather than duplicating.
    await store.write(
      "output/translations/translations.json",
      JSON.stringify([
        { itemId: "x:1", source: "x", sourceText: "s", koreanText: "ko2", status: "approved", translatedAt: "2026-01-01T00:00:00.000Z" },
      ]),
    );
    const all = await new PgTranslationStore(db).loadAll();
    expect(all).toHaveLength(1);
    expect(all[0].koreanText).toBe("ko2");
  });

  it("does not delete a row that exists in the database but not in the incoming content — import, not replace", async () => {
    db = await createTestDb();
    await new PgDeliveryLedger(db).add({
      itemId: "x:99", type: "announcement", outletId: "tg-dev",
      status: "sent", at: "2026-01-01T00:00:00.000Z", by: "auto",
    });
    const store = new DbStateFileStore(db);
    await store.write(
      "output/publish/deliveries.json",
      JSON.stringify([
        { itemId: "x:1", type: "announcement", outletId: "tg-community", status: "sent", at: "2026-01-02T00:00:00.000Z", by: "auto" },
      ]),
    );
    const all = await new PgDeliveryLedger(db).loadAll();
    expect(all.map((e) => e.itemId).sort()).toEqual(["x:1", "x:99"]);
  });

  it("refuses to write an untracked path", async () => {
    db = await createTestDb();
    await expect(new DbStateFileStore(db).write("output/publish/channels.json", "[]")).rejects.toThrow(/untracked/);
  });
});

describe("DbStateFileStore.write — few-shot replaces the corpus, it does not merge into it", () => {
  it("restores the snapshot's order into a NON-EMPTY corpus", async () => {
    // The reviewer's repro. `add` is `on conflict (scope, item_id) do update`, and that clause never
    // reassigns `ordinal` — so replaying alone establishes order only for rows NEW to the target. A
    // target holding {C} replayed with [A, B, C] used to come back C, A, B: right set, wrong order,
    // and nothing said so. `load()` is `order by ordinal` and that order is laid straight into the
    // model's prompt, so this is a silent content change, not a bookkeeping one.
    //
    // Not hypothetical: this project runs two divergent databases (production 30 rows, development
    // 23), and pulling production's snapshot onto development is the case the feature exists for.
    db = await createTestDb();
    await new PgFewShotStore(db, "translation").add({ source: "C", target: "다", itemId: "x:3" });

    await new DbStateFileStore(db).write(
      "output/few-shot/translation.json",
      JSON.stringify([
        { source: "A", target: "가", itemId: "x:1" },
        { source: "B", target: "나", itemId: "x:2" },
        { source: "C", target: "다", itemId: "x:3" },
      ]),
    );

    const restored = await new PgFewShotStore(db, "translation").load();
    expect(restored.map((e) => e.source)).toEqual(["A", "B", "C"]);
  });

  it("drops a row the snapshot's corpus does not hold — the one place a restore is a replace", async () => {
    // The deliberate exception to `write()`'s "imports, does not replace" rule. For the seven the
    // snapshot is a bag of rows keyed by a natural key; for few-shot it is the WHOLE corpus for a
    // scope, in order, and the preview already promises the operator `덮어씀`. A leftover local row
    // sitting in the middle of a restored corpus is a prompt nobody wrote.
    db = await createTestDb();
    await new PgFewShotStore(db, "translation").add({ source: "local", target: "로컬", itemId: "x:99" });

    await new DbStateFileStore(db).write(
      "output/few-shot/translation.json",
      JSON.stringify([{ source: "A", target: "가", itemId: "x:1" }]),
    );

    expect(await new PgFewShotStore(db, "translation").load()).toEqual([{ source: "A", target: "가", itemId: "x:1" }]);
  });

  it("leaves a scope the snapshot does not carry alone", async () => {
    // Scope by scope, not table-wide. A snapshot omits a corpus with zero rows, and `diffRowCounts`
    // marks such a path `유지` — deleting the whole table would silently contradict the preview the
    // operator just approved.
    db = await createTestDb();
    await fewShotStoresByType(db).kol.add({ source: "keep", target: "유지", itemId: "x:7" });

    await new DbStateFileStore(db).write(
      "output/few-shot/conversion.x.json",
      JSON.stringify([{ source: "A", target: "가", itemId: "x:1" }]),
    );

    expect(await fewShotStoresByType(db).kol.load()).toEqual([{ source: "keep", target: "유지", itemId: "x:7" }]);
  });

  it("stays idempotent — a second write of the same corpus neither grows nor reorders it", async () => {
    db = await createTestDb();
    const store = new DbStateFileStore(db);
    const body = JSON.stringify([
      { source: "A", target: "가", itemId: "x:1" },
      { source: "B", target: "나", itemId: "x:2" },
    ]);
    await store.write("output/few-shot/translation.json", body);
    await store.write("output/few-shot/translation.json", body);

    expect((await new PgFewShotStore(db, "translation").load()).map((e) => e.source)).toEqual(["A", "B"]);
  });

  it("restores an itemId-less row without duplicating it, however many times it runs", async () => {
    // This is the property that retired the push-time refusal (`pnpm doctor` reports such a row
    // now). Delete-then-replay is what makes even a null-item_id corpus idempotent — the `on
    // conflict` clause never could, because Postgres does not consider one null equal to another.
    db = await createTestDb();
    const store = new DbStateFileStore(db);
    const body = JSON.stringify([{ source: "A", target: "가" }, { source: "B", target: "나" }]);
    await store.write("output/few-shot/translation.json", body);
    await store.write("output/few-shot/translation.json", body);

    expect((await new PgFewShotStore(db, "translation").load()).map((e) => e.source)).toEqual(["A", "B"]);
  });
});

describe("createStateFileStore", () => {
  it("builds a DbStateFileStore bound to the given db", async () => {
    db = await createTestDb();
    expect(createStateFileStore(db)).toBeInstanceOf(DbStateFileStore);
  });

  it("reads a corpus holding an itemId-less row — a read is a read, on either path", async () => {
    db = await createTestDb();
    await new PgFewShotStore(db, "translation").add({ source: "a", target: "가" });
    await expect(createStateFileStore(db).list()).resolves.toHaveLength(1);
  });
});

/**
 * Neither command grades corpus content, read out of the entry scripts themselves.
 *
 * Neither script can be imported by a test — both are top-level-`await` programs that open Google
 * auth and a real database on load — so this is the same source-text pin `tests/cli/serve.ts`'s and
 * `translate-check.ts`'s suites use. It is worth having because the failure it pins is silent and
 * scheduled: `state:push` runs nightly from `herald-backup.service` against production, where a
 * refusal is a failed unit and a Telegram alert rather than something anybody reads on a terminal.
 */
describe("neither state command refuses on few-shot corpus content", () => {
  const source = (cli: string): string =>
    readFileSync(fileURLToPath(new URL(`../../src/cli/${cli}`, import.meta.url)), "utf8");

  it("state:push builds the same plain store state:pull does", () => {
    expect(source("state-push.ts")).toContain("createStateFileStore(db)");
    expect(source("state-push.ts")).not.toContain("assertRestorable");
  });

  it("state:pull does too, so a legacy row cannot block a restore or its preview", () => {
    expect(source("state-pull.ts")).toContain("createStateFileStore(db)");
    expect(source("state-pull.ts")).not.toContain("assertRestorable");
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
