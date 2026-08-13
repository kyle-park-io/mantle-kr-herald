/**
 * Few-shot rows nothing can ever upsert — **source-database hygiene, reported on demand**.
 *
 * `few_shot_examples.item_id` is nullable, and Postgres never considers one null equal to another
 * for a unique constraint's purposes. The table depends on that: it is how the port's documented
 * "otherwise appends" behaviour is implemented (`src/adapters/db/schema.ts`, and see
 * `PgFewShotStore.add`'s own comment). The consequence for a row that carries no `item_id` is that
 * `add`'s `on conflict (scope, item_id)` key can never reach it — re-approving that same example
 * lands a second copy beside it rather than over it, so the corpus grows a near-duplicate every time
 * a reviewer touches the example again, and `translate:prepare`/`convert:prepare` lay both copies
 * into the prompt.
 *
 * **This used to refuse `pnpm state:push`, and that was the wrong place for it.** The refusal was
 * written when the restore was a replay of `add()`, where an itemId-less row really did duplicate
 * itself on every `state:pull`. `PgFewShotStore.replaceAll` ended that: it deletes the scope and
 * replays the snapshot in array order inside one transaction, so such a row restores exactly once
 * however many times you pull. What was left was a backup command refusing to back up data that
 * would restore perfectly — and once `herald-backup.timer` started running `state:push` nightly
 * (`docs/ko/schedulers.md`), that refusal would fail the unit and fire its Telegram `OnFailure=`
 * hook every night until somebody fixed a row that harms no backup at all.
 *
 * The finding itself is real, so it moved rather than being dropped: `doctor` is read on demand,
 * already grades corpus and steering health, and can say the thing without stopping a backup.
 *
 * Graded `warn`, never `fail`: nothing is broken and no command is blocked — the corpus is drifting,
 * which is a thing to go and fix, not a reason for `pnpm doctor` to exit non-zero.
 *
 * No such row exists today: both writers always supply one (`src/app/SaveTranslation.ts`,
 * `src/app/ApproveRendering.ts`), and production held 30 rows with 0 nulls when this was measured on
 * 2026-08-13. The only way one enters is a hand-edited or legacy JSON file through `pnpm db:import`,
 * which inserts corpus JSON verbatim (`ex.itemId ?? null`).
 */
import type { Db } from "../adapters/db/Db";
import type { CheckResult } from "./report";

/** The row's name in `pnpm doctor`'s report, spelled once so the test and the report cannot drift. */
export const FEW_SHOT_KEY_CHECK = "Few-shot corpus keys";

export interface UnkeyedFewShotScope {
  /** `"translation"` or `"conversion:<type>"` — `PgFewShotStore`'s own scope string, which is what
   *  names the corpus an operator has to go and look at. */
  scope: string;
  /** Rows in that scope whose `item_id` is null. */
  count: number;
}

/**
 * Every scope holding at least one itemId-less row, with how many, in scope order. Empty when the
 * corpus is clean — the ordinary answer.
 *
 * One grouped `count(*)`, not a `load()` per scope: the eight corpora live in one table
 * distinguished only by `scope`, and this asks the table the question directly rather than
 * reconstructing it from eight reads whose rows would then be thrown away. `count(*)` comes back as
 * a `bigint`, which node-postgres hands over as a string and PGlite as a number, so both are
 * normalised through `Number` here rather than at the reader.
 */
export async function unkeyedFewShotScopes(db: Db): Promise<UnkeyedFewShotScope[]> {
  const rows = await db.query<{ scope: string; count: number | string }>(
    `select scope, count(*) as count
       from few_shot_examples
      where item_id is null
      group by scope
      order by scope`,
  );
  return rows.map((r) => ({ scope: r.scope, count: Number(r.count) }));
}

/**
 * The scopes as doctor's one line. Names every affected scope and its count, because the remedy is
 * to go and look at specific rows and "some corpus somewhere" would not tell anybody which.
 */
export function unkeyedFewShotResult(scopes: readonly UnkeyedFewShotScope[]): CheckResult {
  if (scopes.length === 0) {
    return {
      name: FEW_SHOT_KEY_CHECK,
      status: "ok",
      detail: "every example carries an item_id — re-approving one replaces it in place",
    };
  }
  const total = scopes.reduce((sum, s) => sum + s.count, 0);
  const named = scopes.map((s) => `${s.scope} ${s.count}`).join(", ");
  return {
    name: FEW_SHOT_KEY_CHECK,
    status: "warn",
    detail:
      `${total} example(s) with no item_id (${named}) — unique (scope, item_id) does not constrain ` +
      `nulls, so re-approving one of those examples appends a second copy instead of replacing it. ` +
      `No command fixes this — db:export/db:import would add a corrected row BESIDE the null one, ` +
      `not replace it, so it takes SQL against few_shot_examples (docs/ko/setup/steering.md). ` +
      `Backups are unaffected: state:push snapshots them and state:pull restores them once.`,
  };
}
