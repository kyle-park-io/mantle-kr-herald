import type { Db } from "./Db";

/**
 * Ordered `create table if not exists` statements — the single definition of every table this
 * project persists to. Column names are `snake_case`; the `Pg*` stores map them to the camelCase
 * fields on the domain models under `src/domain/`.
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
  // (domain/auth/attemptLimiter.ts). One row, not one per client: there is a single credential, so
  // every attempt is an attempt on the same thing, and keying by IP would only tell an attacker to
  // rotate addresses — see that file's own comment. `locked_at` null means "not locked out"; set,
  // it holds the ISO instant `PgAttemptLimiter` measures a lockout's remaining time against. No
  // `ordinal`, unlike every other table here: that column exists so `db:export` can reproduce a
  // file's insertion order (`order by ordinal`), and this table is not one of the stores `db:export`
  // moves — it is server-side operational state, never exported. Adding one anyway would cost a
  // sequence that advances on every failed login and imply an export contract that does not exist.
  `create table if not exists auth_attempts (
    id text primary key,
    failures integer not null,
    locked_at text
  )`,

  // Seeds the one row `auth_attempts` ever holds. Belt-and-braces, not load-bearing:
  // `PgAttemptLimiter.recordFailure` guarantees this same row for itself, inside its own
  // transaction, immediately before locking it with `select ... for update` — see that class's doc
  // comment for why a lock needs a pre-existing row to mean anything. This seed just means the row
  // is already there on a freshly migrated database, before any login has ever failed.
  `insert into auth_attempts (id, failures, locked_at)
   values ('singleton', 0, null)
   on conflict (id) do nothing`,
];

export async function applySchema(db: Db): Promise<void> {
  for (const statement of STATEMENTS) {
    await db.query(statement);
  }
}

/**
 * Every table name `applySchema` creates, parsed out of `STATEMENTS` above rather than maintained
 * as a second, hand-written list — the same reasoning `dbStores.ts`'s `LABEL_WIDTH` computes itself
 * from the labels it prints. `isSchemaApplied` (`src/cli/dbStores.ts`) checks every name here is an
 * existing table, so a database missing even one of them — not just `deliveries` — reports
 * unapplied. Adding a table to `STATEMENTS` above extends this list automatically; nothing here
 * needs editing when that happens.
 */
export const TABLE_NAMES: readonly string[] = STATEMENTS
  .map((statement) => /create table if not exists (\w+)/i.exec(statement)?.[1])
  .filter((name): name is string => name !== undefined);
