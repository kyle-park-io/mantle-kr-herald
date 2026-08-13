import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { Db } from "../adapters/db/Db";
import type { StateFile, RowCountDiff } from "../domain/state/snapshot";
import type { StateFileStore } from "../ports/StateFileStore";
import { jsonFileText } from "../shared/store/jsonFile";
import { PgTranslationStore } from "../adapters/store/PgTranslationStore";
import { PgConversionStore } from "../adapters/store/PgConversionStore";
import { PgFormattingStore } from "../adapters/store/PgFormattingStore";
import { PgOutletOverrideStore } from "../adapters/store/PgOutletOverrideStore";
import { PgDeliveryLedger } from "../adapters/store/PgDeliveryLedger";
import { PgXArticleLedger } from "../adapters/store/PgXArticleLedger";
import { PgPublishStore } from "../adapters/store/PgPublishStore";
import { PgFewShotStore, fewShotStoresByType } from "../adapters/store/PgFewShotStore";
import { ALL_TYPES } from "../domain/conversion/models";
import { FEW_SHOT_REL, assertRestorableFewShot, fewShotScopeFor } from "../domain/state/fewShot";
import type { Translation } from "../domain/translation/models";
import type { FewShotExample } from "../domain/translation/models";
import type { ContentVariant } from "../domain/conversion/models";
import type { ChannelRendering } from "../domain/formatting/models";
import type { OutletOverride } from "../domain/outlet/override";
import type { DeliveryEntry } from "../domain/delivery/models";
import type { XArticleSentEntry } from "../ports/XArticleLedger";
import type { SyncEntry } from "../domain/publish/syncLedger";

/**
 * The files `state:push` snapshots: everything the database holds that cannot be rebuilt by
 * re-running the pipeline.
 *
 * **"Rebuildable" means the pipeline reproduces the same file, not that it can produce *a* file.**
 * That distinction is the whole membership test, and getting it wrong in the permissive direction
 * costs work nobody can recover:
 *
 * - `x/items.json` re-collects — same source, same output. Out.
 * - `translations/translations.json` and `variants/variants.json` do **not**. They hold text an
 *   agent wrote and a human then read and approved. Re-running `translate:save`/`convert:save`
 *   yields *a* translation and *a* conversion — a different one, non-deterministically, at the cost
 *   of another agent pass — and every 1차/2차 approval on top of the old text is gone with it. The
 *   pipeline can redo the work; it cannot restore the artifact. In.
 * - `lineage/` stays out, but the reason is narrower than it looks: it is an append-only record of
 *   stores that are themselves in here, and it grows without bound. It does hold the only other copy
 *   of an authored text, which is exactly why the two stores above must be tracked rather than left
 *   leaning on it — the lineage is a record, not a rollback.
 *
 * **`formatted/renderings.json` joins the bundle here, reversing this doc comment's own earlier
 * call.** The reasoning that used to exclude it — `format` regenerates it, pure code over the
 * already-tracked `variants` — is true of the *text*, and only the text. It does not cover
 * `ChannelRendering.status`/`approvedAt` (the §7 second-review approval gate) or `refined` (whether
 * a reviewer hand-edited the rendered copy beyond what `format` produced): a fresh `format` run
 * always emits `status: "rendered"`, `refined: false` — it can reproduce the *group* text, never the
 * fact that a human read a specific rendering and approved it, or hand-refined it. That is the same
 * class of irreplaceable reviewer work `translations`/`variants` are tracked for, just riding inside
 * a file whose *other* field genuinely does regenerate. A snapshot that dropped `renderings.json`
 * on the "format regenerates it" argument would restore a rebuilt machine's approvals to nothing —
 * every previously-approved room reading as unapproved — which is exactly the class of loss this
 * feature exists to prevent for the two stores above.
 *
 * The seven:
 *
 * - `translations/translations.json` — the 1차 Korean text plus its approval state. See above.
 * - `variants/variants.json` — the per-type converted copy, and the source `format` renders from.
 * - `formatted/renderings.json` — the rendered per-channel copy and its §7 approval gate. See above.
 * - `formatted/overrides.json` — per-room forked copy. `format` produces the group text, not a
 *   reviewer's fork, so a lost row silently reverts every forked room.
 * - `publish/deliveries.json` — the send ledger. Losing it makes sent items read as never-sent.
 * - `publish/x-article.json` — the X article send ledger, same hazard.
 * - `publish/state.json` — the Drive sync ledger.
 *
 * That is seven names, and seven rows in `TRACKED_REL` below — the pre-outlet `publish/channels.json`
 * that used to make an eighth is **not** one of them any more. Before the Postgres cutover it earned
 * its place by being `JsonDeliveryLedger`'s own fallback read (deliveries.json absent → read
 * channels.json instead), so a snapshot that dropped it could back up a pre-outlet machine's send
 * history as nothing at all. `PgDeliveryLedger` has no such fallback, and cannot: `pnpm db:import`
 * is the one place a legacy `channels.json` is ever read post-cutover, and it reads it through
 * `JsonDeliveryLedger.loadAll()` — the exact same exclusive-or — so by the time this snapshot runs
 * against a migrated database, whatever a `channels.json` once held is already inside `deliveries`.
 * There is no separate legacy shape left in Postgres to snapshot. `tracked()` below (the compatibility
 * surface `state:pull`'s `unknownStatePaths` guard checks incoming snapshots against) deliberately
 * does **not** carry `output/publish/channels.json` forward for this reason: a snapshot taken by a
 * pre-Task-19, file-based `state:push` that still names it is from before this cutover, and
 * `unknownStatePaths` refusing it outright ("upgrade before restoring") is the correct outcome, not
 * a regression to route around.
 *
 * Push and pull share this one list, so the two can never disagree about what a snapshot holds.
 *
 * Restoring an OLDER snapshot is the mirror case and needs no special handling: a snapshot written
 * before an entry joined this list simply has no key for it, so `diffRowCounts` marks the local file
 * `유지` and `describeKeptFiles` says out loud that the tree is now mixed.
 *
 * Listed in pipeline order — translate → convert → format → send — because that is the order the
 * dry-run preview prints, and an operator reading "what am I about to overwrite" is reading a
 * pipeline, not an alphabet.
 *
 * **The source changed from disk to database (Task 19); the judgement above did not.** Every entry
 * here used to be `new Json*Store(paths.*).loadAll()`/`.listEntries()` against a file; now it is the
 * matching `Pg*Store` against a table. `DbStateFileStore` below is the only thing that changed —
 * `PushState`/`PullState`/`diffRowCounts`/`describeStateDiff` never knew the difference, since all
 * four only ever depended on the `StateFileStore` port.
 */
const TRACKED_REL = [
  "output/translations/translations.json",
  "output/variants/variants.json",
  "output/formatted/renderings.json",
  "output/formatted/overrides.json",
  "output/publish/deliveries.json",
  "output/publish/x-article.json",
  "output/publish/state.json",
] as const;

/**
 * The eighth tracked item, kept in its own list rather than appended to `TRACKED_REL` because that
 * array is indexed positionally by `snapshotFromDb` and `write()` below — an eighth literal there
 * would be fine, but eight *derived* entries would not, and splitting the two keeps the seven's
 * indices unarguable. `tracked()` concatenates them.
 *
 * `few_shot_examples` passes this file's own membership test — "everything the database holds that
 * cannot be rebuilt by re-running the pipeline." A few-shot row copies text that is already tracked
 * (`translations`, `variants`), but *which approvals became examples* is not reproducible and no
 * command re-derives the corpus from approved text. Re-running the pipeline yields no corpus at all.
 */
const FEW_SHOT_TRACKED = FEW_SHOT_REL;

/**
 * Reads the seven tracked stores and serialises each to the exact bytes the matching `Json*` store
 * would have written to its file (`jsonFileText` — 2-space `JSON.stringify` plus a trailing
 * newline), keyed by the same repo-relative path `TRACKED_REL` names. This is `db:export`'s own
 * read side, reused rather than re-derived: same stores, same `loadAll()`/`listEntries()`, same
 * `order by ordinal` — the difference from `db-export.ts` is only the sink, a buffer here instead of
 * a file tree.
 *
 * A store with zero rows is **omitted**, not written as an empty shape — mirroring
 * `FsStateFileStore.list()`'s "a file that was never written is simply absent," the state this
 * function's predecessor used to represent a store nothing has touched yet. This is what keeps
 * `PushState.run()`'s "nothing to push" refusal meaningful for a freshly provisioned, still-empty
 * database: every store empty means `snapshotFromDb` returns `[]`, exactly like a fresh checkout's
 * `output/` tree returned no files.
 */
export interface SnapshotFile {
  /** Repo-relative path, POSIX-separated — one of `TRACKED_REL`. */
  rel: string;
  /** The exact bytes the matching `Json*` store would have written to `rel`. */
  body: string;
}

export async function snapshotFromDb(db: Db): Promise<SnapshotFile[]> {
  const files: SnapshotFile[] = [];
  const addArray = (rel: string, rows: readonly unknown[]) => {
    if (rows.length > 0) files.push({ rel, body: jsonFileText(rows) });
  };

  addArray(TRACKED_REL[0], await new PgTranslationStore(db).loadAll());
  addArray(TRACKED_REL[1], await new PgConversionStore(db).loadAll());
  addArray(TRACKED_REL[2], await new PgFormattingStore(db).loadAll());
  addArray(TRACKED_REL[3], await new PgOutletOverrideStore(db).loadAll());
  addArray(TRACKED_REL[4], await new PgDeliveryLedger(db).loadAll());
  addArray(TRACKED_REL[5], await new PgXArticleLedger(db).loadAll());

  // Synchronous, like `addArray` above it — the `await`s below are on the `load()` calls only.
  const addFewShot = (rel: string, scope: string, rows: readonly FewShotExample[]) => {
    assertRestorableFewShot(rows, scope);
    if (rows.length > 0) files.push({ rel, body: jsonFileText(rows) });
  };

  addFewShot("output/few-shot/translation.json", "translation", await new PgFewShotStore(db, "translation").load());
  const fewShotByType = fewShotStoresByType(db);
  for (const type of ALL_TYPES) {
    addFewShot(`output/few-shot/conversion.${type}.json`, `conversion:${type}`, await fewShotByType[type].load());
  }

  const publishEntries = await new PgPublishStore(db).listEntries();
  if (publishEntries.length > 0) {
    files.push({ rel: TRACKED_REL[6], body: jsonFileText({ entries: publishEntries }) });
  }

  return files;
}

/**
 * `StateFileStore` backed by the database. `list()` is `snapshotFromDb` above; `write()` is the
 * restore side, one tracked path at a time — `PullState.run()` calls it once per file in the
 * snapshot after the operator has confirmed the preview.
 *
 * **`write()` imports, it does not replace.** `FsStateFileStore.write()` used to overwrite a file's
 * bytes outright, so a row present locally but absent from the snapshot was gone after a restore.
 * The database equivalent upserts each incoming row by its store's natural key instead — the same
 * behaviour `pnpm db:import` already has, and the plan's own words for this step ("restores by
 * *importing* into the database") name deliberately. In practice this is not a weaker guarantee for
 * `state:pull`'s actual use — a rebuilt machine's database is empty going in, so "upsert the
 * snapshot's rows" and "replace the table's rows" land on the same result — but it is a real,
 * intentional difference from the old file-based restore for an already-populated database, recorded
 * here rather than left implicit: a row that exists in the database but not in the snapshot survives
 * a `state:pull` where it would previously have been deleted along with the whole file.
 */
export class DbStateFileStore implements StateFileStore {
  constructor(private readonly db: Db) {}

  async list(): Promise<StateFile[]> {
    return (await snapshotFromDb(this.db)).map((f) => ({ path: f.rel, content: f.body }));
  }

  tracked(): readonly string[] {
    return [...TRACKED_REL, ...FEW_SHOT_TRACKED];
  }

  async write(path: string, content: string): Promise<void> {
    // Asked before the switch because the corpora are derived from ALL_TYPES, not literals a `case`
    // can name. `fewShotScopeFor` returns undefined for anything else, so an unrecognised path falls
    // through to the switch's own `default:` refusal and there is still exactly one refusal message.
    //
    // Replaying `add()` in array order is what preserves ordinal order: `ordinal` is a bigserial
    // assigned on insert, and `load()` reads `order by ordinal`. That order is prompt content — see
    // `assertRestorableFewShot`'s comment for why the same replay is also safe to run twice.
    const fewShotScope = fewShotScopeFor(path);
    if (fewShotScope !== undefined) {
      const store = new PgFewShotStore(this.db, fewShotScope);
      for (const ex of JSON.parse(content) as FewShotExample[]) await store.add(ex);
      return;
    }

    switch (path) {
      case TRACKED_REL[0]: {
        const store = new PgTranslationStore(this.db);
        for (const t of JSON.parse(content) as Translation[]) await store.upsert(t);
        return;
      }
      case TRACKED_REL[1]: {
        const store = new PgConversionStore(this.db);
        for (const v of JSON.parse(content) as ContentVariant[]) await store.upsert(v);
        return;
      }
      case TRACKED_REL[2]: {
        const store = new PgFormattingStore(this.db);
        for (const r of JSON.parse(content) as ChannelRendering[]) await store.upsert(r);
        return;
      }
      case TRACKED_REL[3]: {
        const store = new PgOutletOverrideStore(this.db);
        for (const o of JSON.parse(content) as OutletOverride[]) await store.upsert(o);
        return;
      }
      case TRACKED_REL[4]: {
        const store = new PgDeliveryLedger(this.db);
        for (const d of JSON.parse(content) as DeliveryEntry[]) await store.add(d);
        return;
      }
      case TRACKED_REL[5]: {
        const store = new PgXArticleLedger(this.db);
        for (const x of JSON.parse(content) as XArticleSentEntry[]) await store.add(x);
        return;
      }
      case TRACKED_REL[6]: {
        const store = new PgPublishStore(this.db);
        const { entries } = JSON.parse(content) as { entries: SyncEntry[] };
        for (const e of entries) await store.record(e);
        return;
      }
      default:
        throw new Error(`refusing to restore untracked operational-state file: ${path}`);
    }
  }

  /** A real, local, on-disk copy of the current database content — the operator's rollback if a
   *  `state:pull --yes` needs to be undone by hand. Written the same way `FsStateFileStore.backup`
   *  always did: everything `list()` returns, under `destDir`, preserving relative paths. */
  async backup(destDir: string): Promise<void> {
    for (const f of await this.list()) {
      const abs = join(destDir, f.path);
      await mkdir(dirname(abs), { recursive: true });
      await writeFile(abs, f.content, "utf8");
    }
  }
}

export function createStateFileStore(db: Db): DbStateFileStore {
  return new DbStateFileStore(db);
}

/** Names this bundle in `GoogleConfigDrive`'s failure messages — a stale `GDRIVE_STATE_FOLDER_ID`
 *  must not report itself as a *config* download failure. */
export const DRIVE_LABEL = "operational-state";

/** "행 수 알 수 없음" rather than "0행": see `countRows` — a shape we failed to read must not look empty. */
const rows = (n: number | undefined): string => (n === undefined ? "행 수 알 수 없음" : `${n}행`);

/**
 * What `state:pull` prints for each file. Lives here rather than in the entry script because it is
 * the thing the operator decides on — a preview that showed only file names would be asking them to
 * approve an overwrite sight unseen.
 */
export function describeStateDiff(diff: readonly RowCountDiff[]): string[] {
  return diff.map((d) => {
    if (d.change === "keep") return `  유지    ${d.path} — 현재 ${rows(d.current)} (스냅샷에 없음, 그대로 둡니다)`;
    if (d.change === "restore") return `  복원    ${d.path} — 현재 없음 → 스냅샷 ${rows(d.incoming)}`;
    return `  덮어씀  ${d.path} — 현재 ${rows(d.current)} → 스냅샷 ${rows(d.incoming)}`;
  });
}

/**
 * The warning after a `--yes` run, or `undefined` when the restore covered everything.
 *
 * A `유지` row prints at the same weight as every other row in the preview above, and the closing
 * summary ("4개 파일을 복원했습니다") reads like a complete restore on its own. A kept file means the
 * tree is now mixed — a ledger from the snapshot's date beside one from today — which is the
 * operator's to reconcile, so the count gets said out loud rather than left to be inferred.
 */
export function describeKeptFiles(diff: readonly RowCountDiff[]): string | undefined {
  const kept = diff.filter((d) => d.change === "keep");
  if (kept.length === 0) return undefined;
  return `⚠ ${kept.length}개 파일은 스냅샷에 없어 그대로 뒀습니다(${kept.map((d) => d.path).join(", ")}) — 지금 트리는 스냅샷 시점과 현재가 섞여 있습니다. 발송 원장이 섞였다면 보드에서 한 번 확인하세요.`;
}

/**
 * What `state:push` says about the folder it is about to use. `findFolder(...) ?? createFolder(...)`
 * covers two very different situations in one line, and the found branch is the ordinary
 * `.env`-lost-but-Drive-intact recovery — being told a folder holding months of snapshots was just
 * "created" is precisely the wrong signal there.
 */
export function describeProvisionedFolder(f: {
  created: boolean;
  name: string;
  id: string;
  parentName?: string;
}): string {
  const where = `"${f.name}"${f.parentName ? ` (상위: "${f.parentName}")` : ""}`;
  return f.created
    ? `운영 상태 폴더 ${where} 를 새로 만들었습니다 — ${f.id}`
    : `이미 있는 운영 상태 폴더 ${where} 를 찾았습니다 — ${f.id} (기존 스냅샷이 그대로 있습니다)`;
}
