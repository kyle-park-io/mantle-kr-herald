import type { Db } from "./Db";

/**
 * Every column `applySchema` adds to a table that already existed before that column did —
 * declared as data, the single source of truth, rather than parsed out of hand-written SQL.
 *
 * Task 4.5 review: an earlier version of this file kept `alter table ... add column if not
 * exists ...` as hand-written SQL in `STATEMENTS` below and *parsed* this list back out of it with
 * a regex, mirroring how `TABLE_NAMES` further down derives itself from `create table` statements.
 * Mutation testing broke that: a multi-line `alter table translations\n  add column if not exists
 * posted_at text`, a quoted identifier, or two columns added in one statement all parsed silently
 * wrong, and — because the probe's expected list and the derivation regex were reading the same
 * flawed parse — the two agreed with each other while both were wrong. A regex over free-form SQL
 * cannot be trusted to keep up with every shape a future author might write.
 *
 * So this list is declared first, as plain data, and the SQL is *generated* from it
 * (`alterColumnStatement` below) rather than the other way around. There is no parse step left to
 * under-match: `isSchemaApplied` below and the statements `applySchema` runs both read this exact
 * array, so a new altered column becomes one entry here, full stop — the DDL and the probe cannot
 * drift apart, because there is only one place the shape of an altered column is ever written down.
 *
 * `TABLE_NAMES` further down is deliberately **not** converted the same way — see its own doc
 * comment for why a `create table` statement does not carry the same risk.
 */
export const ALTERED_COLUMNS: readonly { table: string; column: string; type: string }[] = [
  // `last_attempt_at` did not exist when `auth_attempts` was first created — see that table's own
  // comment in `STATEMENTS` below for what it's for.
  { table: "auth_attempts", column: "last_attempt_at", type: "text" },
  // `posted_url`/`posted_at` did not exist when `translations` was first created — Task 4.5's own
  // motivating case (see this file's `alterColumnStatement` and `isSchemaApplied` below).
  { table: "translations", column: "posted_url", type: "text" },
  { table: "translations", column: "posted_at", type: "text" },
  // `published_text` — the live post's body, filled in by the same reconcile match that fills in
  // `posted_url`/`posted_at` above; a later task backfills existing rows, so this starts null.
  { table: "translations", column: "published_text", type: "text" },
];

/**
 * `{ table: "translations", column: "posted_url", type: "text" }` → `alter table translations add
 * column if not exists posted_url text`. The *only* place this SQL shape is written in this file —
 * `STATEMENTS` below never spells out an `alter table ... add column` statement by hand; it always
 * goes through this, driven by `ALTERED_COLUMNS` above.
 */
function alterColumnStatement({ table, column, type }: (typeof ALTERED_COLUMNS)[number]): string {
  return `alter table ${table} add column if not exists ${column} ${type}`;
}

/**
 * Ordered `create table if not exists` statements, plus the generated `alter table ... add column`
 * statements (see `alterColumnStatement` above) — together, the single definition of every table
 * and every later-added column this project persists to. Column names are `snake_case`; the `Pg*`
 * stores map them to the camelCase fields on the domain models under `src/domain/`.
 *
 * Every table carries a monotonic `ordinal`, set once on insert and never touched by an update.
 * The `Json*` stores it replaces append to a file, so a file's row order is insertion order;
 * `ordinal` is how a `Pg*` store's `loadAll()` reproduces that order (`order by ordinal`, never
 * key order) — later work asserts `db:export` reproduces the original file byte for byte, and key
 * order would silently reorder rows that a plain append never would.
 *
 * Timestamps are `text`, holding the ISO string the domain models already carry — never
 * `timestamptz`, whose round trip through Postgres would not reproduce those bytes.
 *
 * No table declares a foreign key: rows are keyed by the same string ids the `Json*` stores
 * already use (`itemId`, etc.), and nothing here enforces referential integrity between tables —
 * that matches the files being replaced, which never did either.
 */
const STATEMENTS: readonly string[] = [
  // x_threads — CollectedThread (domain/models.ts). Key: root_id — CollectionRepository.upsert
  // merges by rootId. `tweets` is stored whole as `json`, not `jsonb`: `jsonb` parses to a binary
  // form that normalizes key order and drops insignificant whitespace, so a round trip would not
  // reproduce the original file's bytes — the same reasoning the brief already applies to
  // timestamps. `json` stores (and returns) the exact input text. The merge rules that touch this
  // column (see LocalJsonStore.mergeTweet) stay in TypeScript, not SQL.
  `create table if not exists x_threads (
    root_id text primary key,
    tweets json not null,
    status text not null,
    first_seen_at text not null,
    deleted_at text,
    ordinal bigserial unique
  )`,

  // lark_items — LarkMessage (domain/larkMessage.ts). Key: id — holds messageId; LarkRepository
  // merges "by messageId".
  `create table if not exists lark_items (
    id text primary key,
    chat_id text not null,
    msg_type text not null,
    created_at text not null,
    sender_id text,
    thread_id text,
    parent_id text,
    text text not null,
    raw_content text not null,
    ordinal bigserial unique
  )`,

  // translations — Translation (domain/translation/models.ts). Key: item_id —
  // TranslationStore.upsert, "by itemId".
  `create table if not exists translations (
    item_id text primary key,
    source text not null,
    source_text text not null,
    korean_text text not null,
    status text not null,
    translated_at text not null,
    approved_at text,
    is_reply boolean,
    ref_url text,
    ordinal bigserial unique
  )`,

  // variants — ContentVariant (domain/conversion/models.ts). Key: (item_id, type) —
  // ConversionStore.listConvertedKeys.
  `create table if not exists variants (
    item_id text not null,
    type text not null,
    source_korean text not null,
    converted_text text not null,
    status text not null,
    created_at text not null,
    approved_at text,
    ordinal bigserial unique,
    primary key (item_id, type)
  )`,

  // renderings — ChannelRendering (domain/formatting/models.ts). Key: (item_id, type, channel) —
  // FormattingStore.listRenderedKeys.
  `create table if not exists renderings (
    item_id text not null,
    type text not null,
    channel text not null,
    text text not null,
    refined boolean not null,
    created_at text not null,
    status text not null,
    approved_at text,
    ordinal bigserial unique,
    primary key (item_id, type, channel)
  )`,

  // outlet_overrides — OutletOverride (domain/outlet/override.ts). Key: (item_id, type, outlet_id).
  `create table if not exists outlet_overrides (
    item_id text not null,
    type text not null,
    outlet_id text not null,
    text text not null,
    status text not null,
    created_at text not null,
    approved_at text,
    ordinal bigserial unique,
    primary key (item_id, type, outlet_id)
  )`,

  // deliveries — DeliveryEntry (domain/delivery/models.ts). Key: (item_id, type, outlet_id) —
  // deliveryKey() in domain/delivery/models.ts.
  `create table if not exists deliveries (
    item_id text not null,
    type text not null,
    outlet_id text not null,
    status text not null,
    at text not null,
    by text not null,
    post_id text,
    url text,
    sender_name text,
    ordinal bigserial unique,
    primary key (item_id, type, outlet_id)
  )`,

  // x_article_deliveries — XArticleSentEntry (adapters/store/JsonXArticleLedger.ts). Key: item_id
  // — both loadKeys() and add() key their Map by e.itemId.
  `create table if not exists x_article_deliveries (
    item_id text primary key,
    post_id text,
    url text,
    sent_at text not null,
    dropped_at text,
    ordinal bigserial unique
  )`,

  // publish_entries — SyncEntry (domain/publish/syncLedger.ts). Key: (item_id, status, target) —
  // PublishStore.listEntries doc comment.
  `create table if not exists publish_entries (
    item_id text not null,
    stage text not null,
    status text not null,
    target text not null,
    file_name text,
    remote_id text,
    url text,
    content_hash text,
    uploaded_at text,
    ordinal bigserial unique,
    primary key (item_id, status, target)
  )`,

  // few_shot_examples — FewShotExample (domain/translation/models.ts) plus a synthetic `scope`
  // ("translation" | "conversion:<type>") that distinguishes translation/few-shot.json from
  // conversion/few-shot.<type>.json. `item_id` is nullable — FewShotExample.itemId is optional —
  // so it cannot anchor a primary key; `ordinal` is the surrogate primary key instead, and the
  // natural key is a unique constraint. Postgres treats every null item_id as distinct, so two
  // itemId-less examples in the same scope never collide.
  `create table if not exists few_shot_examples (
    ordinal bigserial primary key,
    scope text not null,
    item_id text,
    source text not null,
    target text not null,
    unique (scope, item_id)
  )`,

  // lineage — LineageEntry (domain/lineage/models.ts). No natural key — append-only
  // (LineageStore.append). `ordinal` doubles as the surrogate primary key.
  `create table if not exists lineage (
    ordinal bigserial primary key,
    item_id text not null,
    stage text not null,
    variant text,
    content text not null,
    status text,
    source_text text,
    at text not null
  )`,

  // auth_attempts — the failed-login counter behind the dashboard's one shared credential
  // (domain/auth/attemptLimiter.ts). Two layers share this one table, distinguished by `id`: the
  // 'singleton' row is the global backstop (every attempt counts against it, whatever its source),
  // and any number of `ip:<address>` rows are the per-IP counters `PgAttemptLimiter` keys on when a
  // caller supplies a trustworthy client IP — see that class's own comment, and
  // `domain/auth/attemptLimiter.ts`'s, for why both exist rather than one or the other. `locked_at`
  // null means "not locked out"; set, it holds the ISO instant a lockout's remaining time is measured
  // against. `last_attempt_at` is what `PgAttemptLimiter.recordFailure` evicts stale `ip:%` rows by —
  // see its own comment for why `locked_at` alone cannot drive that (a row that never reached its
  // failure threshold has a `locked_at` that was never set, so a sweep keyed only on an elapsed
  // lockout would never touch it and the table would grow without bound as an attacker — or just
  // churn — touches new addresses). No `ordinal`, unlike every other table here: that column exists
  // so `db:export` can reproduce a file's insertion order (`order by ordinal`), and this table is not
  // one of the stores `db:export` moves — it is server-side operational state, never exported. Adding
  // one anyway would cost a sequence that advances on every failed login and imply an export contract
  // that does not exist.
  `create table if not exists auth_attempts (
    id text primary key,
    failures integer not null,
    locked_at text,
    last_attempt_at text
  )`,

  // `last_attempt_at` — declared in `ALTERED_COLUMNS` above, generated here rather than
  // hand-written (see that constant's own doc comment for why): a database that already has the
  // table (every install predating this column) still gets it applied via `add column if not
  // exists`, the same idempotent-migration shape every other `if not exists` statement here relies
  // on. Must run before the seed insert just below, which writes to this column.
  ...ALTERED_COLUMNS.filter((c) => c.table === "auth_attempts").map(alterColumnStatement),

  // Seeds the one row `auth_attempts` held before per-IP rows existed. Belt-and-braces, not
  // load-bearing: `PgAttemptLimiter.recordFailure` guarantees this same row for itself, inside its
  // own transaction, immediately before locking it with `select ... for update` — see that class's
  // doc comment for why a lock needs a pre-existing row to mean anything. This seed just means the
  // row is already there on a freshly migrated database, before any login has ever failed. Per-IP
  // rows need no equivalent seed: they do not exist until the first failure from that address creates
  // one, the same in-transaction guarantee covers them, and there is no fixed set of them to seed.
  `insert into auth_attempts (id, failures, locked_at, last_attempt_at)
   values ('singleton', 0, null, null)
   on conflict (id) do nothing`,

  // `posted_url`/`posted_at` — declared in `ALTERED_COLUMNS` above, generated here too (Task 4.5).
  ...ALTERED_COLUMNS.filter((c) => c.table === "translations").map(alterColumnStatement),

  // translate_floor_reports — TranslateFloorReport (status/translateFloor.ts). One row, id
  // 'singleton', upserted by the watch tick (`PgTranslateFloorReport`).
  //
  // What it is for: the translation floor lives in `herald-watch.service`'s
  // `HERALD_TRANSLATE_SINCE=` and nowhere else, and the hosted dashboard is a Vercel function with
  // no systemd to ask — so it showed "cannot be read from here" forever. This is the scheduler
  // *reporting* what it actually ran with, so that screen can read it from the database it already
  // reads everything else from. The unit stays the single source of truth: nothing here is ever
  // consulted to decide what to translate, and `collectedReach` (translateFloor.ts) gives a live
  // `systemctl` answer precedence over this row wherever one can be had.
  //
  // Why its own table rather than a `lineage` row: `lineage` is `item_id NOT NULL, content NOT
  // NULL` and models per-item content events, so a config observation would have to fabricate both
  // — and `pnpm lineage --activity` is a date × stage rollup that would then grow a row on every
  // date forever, burying the content history it exists to show.
  //
  // `floor` is nullable and that is load-bearing: null means the tick genuinely ran with no floor
  // (the alarming state, the whole backlog oldest-first), which is a different fact from the row
  // being absent because nothing has ever reported. `reported_at` is never null — the value is an
  // observation with an age, and a reader that could not tell a fresh report from a three-week-old
  // one would be back to stating a number as though it had been checked.
  //
  // No `ordinal`, for the same reason `auth_attempts` has none: that column exists so `db:export`
  // can reproduce a file's insertion order, and this table is operational state that `db:export`
  // never moves.
  `create table if not exists translate_floor_reports (
    id text primary key,
    floor text,
    reported_at text not null
  )`,

  // credential_liveness — LivenessObservation (status/liveness.ts). One row, id 'singleton',
  // upserted by whatever last called `GET /api/diagnostics/live` (the daily `creds:check`, a
  // `deploy:smoke`, or the board's own [지금 확인]).
  //
  // What it is for: liveness is observable from exactly one place — inside the deployment, where the
  // credential is — and the board renders later, somewhere else. On 2026-08-10 the deployment's
  // Google, Typefully and Telegram credentials answered 401 for four days while the header showed
  // every key `설정됨`, because presence is all `/api/status` could see. This is the deployment
  // *recording* what it observed so that screen can read it.
  //
  // Why not a field computed at read time: the probes are ~11 outbound requests under a five-second
  // deadline, and `/api/status` is called on every board load and after every 1차 mutation.
  // `apiHandlers.ts`'s own comment on the diagnostics route refuses that trade in writing.
  //
  // Why its own table rather than `lineage`: `lineage` is `item_id NOT NULL, content NOT NULL` and
  // models per-item content events; a credential observation has neither, and `pnpm lineage
  // --activity` would grow a row per date forever.
  //
  // One row, not one per probe run, for the reason `translate_floor_reports` gives for its own: what
  // a reader needs is the latest observation and how old it is. `probes` is JSON text — `[{ key,
  // status, detail }]`, the three fields the board renders — and every string in it was already
  // redacted by `liveProbes.ts` before it left that module. `observed_at` is never null: a status
  // without its instant reads as though it had just been checked.
  `create table if not exists credential_liveness (
    id text primary key,
    probes text not null,
    observed_at text not null
  )`,
];

export async function applySchema(db: Db): Promise<void> {
  for (const statement of STATEMENTS) {
    await db.query(statement);
  }
}

/**
 * Every table name `applySchema` creates, parsed out of `STATEMENTS` above rather than maintained
 * as a second, hand-written list — the same reasoning `dbStores.ts`'s `LABEL_WIDTH` computes itself
 * from the labels it prints. `isSchemaApplied` below checks every name here is an existing table, so
 * a database missing even one of them — not just `deliveries` — reports unapplied. Adding a table to
 * `STATEMENTS` above extends this list automatically; nothing here needs editing when that happens.
 *
 * This still parses SQL, unlike `ALTERED_COLUMNS` above — deliberately, and for a reason specific to
 * the shape of a `create table` statement, not because the risk that broke `ALTERED_COLUMNS` doesn't
 * apply here too in principle. Every `create table if not exists <name> (` statement in this file
 * names its table as one bare identifier, in the same fixed position, with no variation across all
 * eleven of them — there is no multi-line spelling of *that* opening clause, no quoting, and a table
 * only ever gets one name. `alter table ... add column ...` has none of those guarantees: it can wrap
 * across lines, quote its identifier, or add several columns in one statement, and a regex tuned for
 * the common case silently under-matched every one of those (see `ALTERED_COLUMNS`'s doc comment for
 * the mutation-tested proof). A narrow, genuinely-fixed-shape parse stays a parse; a parse over a
 * SQL clause with real structural freedom became data instead.
 */
export const TABLE_NAMES: readonly string[] = STATEMENTS
  .map((statement) => /create table if not exists (\w+)/i.exec(statement)?.[1])
  .filter((name): name is string => name !== undefined);

/**
 * Standalone, one-shot check: has this database ever had the FULL schema applied? Checks every
 * table `applySchema` creates (`TABLE_NAMES` above) against `information_schema.tables` — not just
 * `deliveries`. A single-table probe answers "yes" the moment the oldest table exists, which is
 * wrong the instant a later table is added to this file and an already-migrated database never gets
 * it: that database would report "applied" forever, right up until the first read against the new
 * table fails at runtime with no earlier warning. (`auth_attempts`, added after the tables this
 * probe used to check, is exactly that case.)
 *
 * Also checks every `(table, column)` pair `applySchema` adds via `alter table ... add column`
 * (`ALTERED_COLUMNS` above) against `information_schema.columns` — the same argument one level down,
 * for a table that already exists but is missing a column added to it later. A table-only probe
 * cannot see that gap at all: the table read above already reports "every table present" while a
 * `select` against the missing column fails at runtime. Task 4.5 hit exactly this against the real
 * production database (`translations.posted_url`/`posted_at`) — see `ALTERED_COLUMNS`'s own doc
 * comment for the full story. The table check runs first and short-circuits before the column query
 * when it already fails, since a table that does not exist has no columns worth asking
 * `information_schema.columns` about.
 *
 * Lives beside `TABLE_NAMES` and `ALTERED_COLUMNS` — its two inputs — rather than in `src/cli/
 * dbStores.ts` (Task 4.5 review): every other cross-reference between `src/cli` and `src/doctor`
 * goes from `cli` importing out of `doctor/checks.ts`, never the other way, and `doctor`'s own
 * `databaseProbe` (`src/doctor/checks.ts`) needs this function too — putting it here, next to the
 * schema it describes, lets both `src/cli/db-import.ts`/`db-export.ts` and `src/doctor/checks.ts`
 * import it from the same neutral place instead of one importing "up" into the other.
 *
 * `previewCount` (`src/cli/dbStores.ts`) reports 0 for a missing table the same way it would for a
 * genuinely empty, migrated one, so the two cannot be told apart from a preview's counts alone.
 * `db-import.ts`'s and `db-export.ts`'s entry scripts call this once, before printing the preview, to
 * print an explicit "schema not applied yet" line when that is why every count reads 0.
 */
export async function isSchemaApplied(db: Db): Promise<boolean> {
  const tableRows = await db.query<{ table_name: string }>(
    "select table_name from information_schema.tables where table_schema = 'public'",
  );
  const existingTables = new Set(tableRows.map((r) => r.table_name));
  if (!TABLE_NAMES.every((name) => existingTables.has(name))) return false;

  const columnRows = await db.query<{ table_name: string; column_name: string }>(
    "select table_name, column_name from information_schema.columns where table_schema = 'public'",
  );
  const existingColumns = new Set(columnRows.map((r) => `${r.table_name}.${r.column_name}`));
  return ALTERED_COLUMNS.every(({ table, column }) => existingColumns.has(`${table}.${column}`));
}
