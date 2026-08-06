import { fileURLToPath } from "node:url";
import type { Db } from "../adapters/db/Db";
import { createDb } from "../adapters/db/createDb";
import { applySchema } from "../adapters/db/schema";
import { loadDbConfig, describeDbTarget } from "../config";
import { isSchemaApplied } from "./dbStores";

/**
 * `pnpm db:migrate` — the one command whose entire job is to run `applySchema` against the
 * configured database, for an operator who wants to migrate it explicitly.
 *
 * Task 4.5: before this file existed, `applySchema` was reachable from exactly three places —
 * `serve.ts`, `db-import.ts`, `db-export.ts` — and nothing else. Every command that reads or writes
 * the database (`pnpm watch`, `pnpm collect`, `pnpm x:reconcile`, ...) opens its own connection and
 * never applies the schema itself. That never mattered before this branch, because every earlier
 * schema change added a whole new *table*, and a database nobody had migrated always failed loudly
 * with `relation ... does not exist` on the very first read. This branch's `translations.posted_url`/
 * `posted_at` — a column added to a table that already existed on every prior install — broke that:
 * `pnpm x:reconcile` failed against the real production database with `column "posted_url" does not
 * exist`, and `isSchemaApplied` (`dbStores.ts`) still reported "applied", because it only ever
 * checked table names (see `ALTERED_COLUMNS`'s own doc comment in `schema.ts` for the full story, and
 * `isSchemaApplied`'s for how that gap was closed). `db:migrate` is the fix for the other half: a
 * command an operator can run *before* any of those other commands ever touch a database that has
 * drifted this way, rather than relying on one of them to apply the schema as an incidental side
 * effect.
 *
 * `applySchema` is idempotent — every statement is `create table if not exists` / `alter table ...
 * add column if not exists` / `insert ... on conflict do nothing` — so `migrate` is always safe to
 * re-run: a database that is already fully migrated gets a no-op, and one that is missing a table or
 * a column gets exactly that added, and nothing else. There is no `--yes` gate here the way
 * `db-import.ts`/`db-export.ts` have one: those commands can delete or overwrite data; this one only
 * ever adds schema that was always going to be there.
 */
export async function migrate(db: Db): Promise<void> {
  await applySchema(db);
}

/**
 * The runnable entry point. Guarded so `tests/cli/dbMigrate.test.ts` can `import { migrate }` from
 * this same file without also running this block — see `db-import.ts`'s identical guard for why
 * `process.argv[1] === fileURLToPath(import.meta.url)` is the right test.
 *
 * Names the database on its own first line, the same shape `status.ts` and `x-reconcile.ts` use
 * (`describeDbTarget`, `src/config.ts`) — never a second, differently-formatted target string — so an
 * operator previewing a production `.env` before running this sees the same line either command would
 * print.
 */
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  await import("./registerErrorHandler");
  const cfg = loadDbConfig();
  console.log(`db:migrate — ${cfg.env} · ${describeDbTarget(cfg)}`);

  const db = createDb(cfg);
  try {
    const before = await isSchemaApplied(db);
    console.log(
      before
        ? "Schema already fully applied — this run will be a no-op."
        : "Schema not fully applied yet — applying now.",
    );
    await migrate(db);
    console.log("Schema applied (safe to re-run — every statement is idempotent).");
  } finally {
    await db.close();
  }
}
