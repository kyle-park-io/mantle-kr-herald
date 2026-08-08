import type { Db } from "../db/Db";
import type { TranslateFloorReport } from "../../status/translateFloor";

/** The shape a row from `translate_floor_reports` (see `src/adapters/db/schema.ts`) comes back as. */
interface ReportRow {
  floor: string | null;
  reported_at: string;
}

/**
 * The one row id. Same spelling as `PgAttemptLimiter`'s global row, and for the same reason: a
 * single-row table still needs a primary key for `on conflict` to have something to conflict on,
 * and a fixed literal is what makes the upsert idempotent instead of appending forever.
 *
 * One row, not one per tick, deliberately. A history of every floor a tick ever ran with would be a
 * second event log beside `lineage`, growing by twelve rows a day, answering a question nobody has
 * asked — and `lineage` is already the place this project keeps append-only history. What a reader
 * needs is the latest observation and how old it is; that is exactly one row.
 */
const ROW_ID = "singleton";

/**
 * Reads and writes the scheduler's translation-floor report — one upserted row in
 * `translate_floor_reports`.
 *
 * **One writer.** `WatchTick`, on the machine that owns the floor, at the start of every tick. That
 * is what keeps `herald-watch.service`'s `HERALD_TRANSLATE_SINCE=` the single source of truth: this
 * row is an observation of that unit, never an input to anything. Nothing in the pipeline reads it
 * to decide what to translate — see `translateFloor.ts`'s `collectedReach` for the precedence rule
 * that keeps a live `systemctl` answer ahead of it wherever one can be had.
 *
 * **Readers** are `pnpm status` and the hosted dashboard, over the same Postgres they already read
 * everything else from. The hosted one is the reason this exists at all: a Vercel function has no
 * systemd, so before this it could only say "cannot be read from here" — honest, and useless to the
 * people who mostly use that screen.
 *
 * Constructed at each call site rather than being added to `createStores` — the same treatment
 * `PgAttemptLimiter`/`auth_attempts` gets, and for the same reason: `Stores` is the reviewed-content
 * store set that `db:export`/`db:import` move, and this is operational state that neither touches.
 */
export class PgTranslateFloorReport {
  constructor(private readonly db: Db) {}

  /**
   * The scheduler's last report, or `undefined` when it has never written one.
   *
   * `undefined` and "a report with no floor" are different answers and both are representable: a
   * null `floor` column comes back as a report whose `floor` is absent, which readers render as the
   * alarming "the scheduler ran with no floor at all" — never as "nothing was reported". Collapsing
   * the two would let a scheduler draining the whole backlog oldest-first read as a screen that
   * simply could not ask.
   */
  async read(): Promise<TranslateFloorReport | undefined> {
    const rows = await this.db.query<ReportRow>(
      `select floor, reported_at from translate_floor_reports where id = $1`,
      [ROW_ID],
    );
    const row = rows[0];
    if (row === undefined) return undefined;
    return row.floor === null ? { at: row.reported_at } : { floor: row.floor, at: row.reported_at };
  }

  /**
   * Records what this tick ran with, replacing whatever the last one recorded.
   *
   * `floor ?? null` rather than letting `undefined` through: `pg` would send it as null anyway, but
   * writing it out is what makes "the tick ran with no floor" an explicit, reviewable state of this
   * column instead of an accident of driver behaviour.
   */
  async write(report: TranslateFloorReport): Promise<void> {
    await this.db.query(
      `insert into translate_floor_reports (id, floor, reported_at)
       values ($1, $2, $3)
       on conflict (id) do update set floor = excluded.floor, reported_at = excluded.reported_at`,
      [ROW_ID, report.floor ?? null, report.at],
    );
  }
}
