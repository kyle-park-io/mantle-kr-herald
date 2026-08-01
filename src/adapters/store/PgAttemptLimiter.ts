import type { Db } from "../db/Db";
import type { AttemptLimiter } from "../../domain/auth/attemptLimiter";

/** The shape a row from `auth_attempts` (see `src/adapters/db/schema.ts`) comes back as. */
interface AttemptsRow {
  failures: number;
  locked_at: string | null;
}

/** The one row `PgAttemptLimiter` used before per-IP rows existed — still the global backstop's id. */
const GLOBAL_ROW_ID = "singleton";

/** Prefix every per-IP row's id carries — see `ipRowId` and this class's own comment. */
const IP_ROW_PREFIX = "ip:";

/**
 * The `auth_attempts` row id a per-IP `PgAttemptLimiter` keys on for `ip`. Exported so the
 * composition root (`serve.ts`) and this file's own tests build the same key a stored row would
 * have, rather than each hand-rolling the `"ip:" + address` convention separately and risking the
 * two drifting apart.
 */
export function ipRowId(ip: string): string {
  return `${IP_ROW_PREFIX}${ip}`;
}

/**
 * How long a per-IP row may sit untouched before `recordFailure` sweeps it away, on the next write
 * that runs the sweep. An hour, not the 60s lockout window itself: the sweep must never delete a row
 * that is still actively enforcing a lockout, and an hour is generously past that with room to
 * spare. It is also, independent of lockouts, the actual bound on how many per-IP rows can
 * accumulate: `POST /api/login` runs through `singleFlight` (`serve.ts`) — at most one credential
 * check in flight for the whole process at a time, each taking scrypt's ~100–300ms — so even under
 * sustained, maximally concurrent abuse this table cannot grow by more than roughly one row every
 * hundred milliseconds, comfortably bounded within any one-hour window regardless of how many
 * distinct addresses an attacker rotates through.
 */
const PER_IP_ROW_RETENTION_MS = 60 * 60 * 1000;

/**
 * `AttemptLimiter` backed by the `auth_attempts` table.
 *
 * `attemptLimiter.ts`'s own doc comment explains why this exists: state kept in memory resets per
 * process, so a serverless deployment — a fresh instance per invocation, or several running at
 * once — gets a fresh five-attempt allowance on every request. The lockout that is supposed to
 * protect the one shared credential becomes, in effect, unlimited.
 *
 * One row per scope, not one per client-and-scope: `id` (default `'singleton'`, the global
 * backstop) is a constructor option, and the composition root builds a second instance per request
 * with `id: ipRowId(clientIp)` for the per-IP layer — see `attemptLimiter.ts`'s comment for why both
 * layers exist together. Either way, `recordFailure` locks its own row with `select ... for update`
 * inside `db.tx()`, and a lock only serializes concurrent transactions against a row that is already
 * there: locking zero rows locks nothing, so `recordFailure` guarantees the row itself — via an
 * `insert ... on conflict do nothing` right before the locking select, inside the same transaction —
 * rather than depending on it having been seeded elsewhere. `schema.ts` also seeds the global row,
 * but that is belt-and-braces, not load-bearing: without the in-transaction guarantee, a row missing
 * for any reason (a dump restored from before the seed existed, an operator clearing a lockout with
 * `delete` instead of a reset) would silently degrade the lock to nothing, and two concurrent first
 * failures would both read "no row", both compute `failures = 1`, and one write would overwrite the
 * other — exactly the lost update the transaction exists to prevent. Per-IP rows have no seed at
 * all — they do not exist until a first failure from that address creates one, and the same
 * in-transaction guarantee covers that creation.
 *
 * Per-IP rows also need eviction, which the global row never did: an attacker (or ordinary churn
 * across many real addresses) can create one per address, and nothing else ever removes them.
 * `recordFailure` sweeps stale ones — see `PER_IP_ROW_RETENTION_MS`'s own comment for why that sweep
 * keys on `last_attempt_at`, a plain staleness clock, rather than "the lockout it once held has
 * lapsed": a row whose failures never reached the threshold has a `locked_at` that was never set, so
 * a sweep that only looked at expired lockouts would never touch it, and an attacker who
 * deliberately stays under the per-IP threshold on every address (or simple background noise doing
 * the same) would leave one permanent row per address it ever touched.
 */
export class PgAttemptLimiter implements AttemptLimiter {
  private readonly id: string;
  private readonly maxFailures: number;
  private readonly lockoutMs: number;

  constructor(
    private readonly db: Db,
    options: { id?: string; maxFailures?: number; lockoutMs?: number } = {},
  ) {
    this.id = options.id ?? GLOBAL_ROW_ID;
    this.maxFailures = options.maxFailures ?? 5;
    this.lockoutMs = options.lockoutMs ?? 60_000;
  }

  /** Milliseconds left on a lockout recorded at `lockedAt`, or 0 once it has elapsed (or there is none). */
  private remainingMs(lockedAt: string | null, now: Date): number {
    if (lockedAt === null) return 0;
    const remaining = this.lockoutMs - (now.getTime() - new Date(lockedAt).getTime());
    return remaining > 0 ? remaining : 0;
  }

  async retryAfterMs(now: Date): Promise<number> {
    const rows = await this.db.query<AttemptsRow>(
      `select failures, locked_at from auth_attempts where id = $1`,
      [this.id],
    );
    return this.remainingMs(rows[0]?.locked_at ?? null, now);
  }

  async recordFailure(now: Date): Promise<void> {
    const nowIso = now.toISOString();
    await this.db.tx(async (tx) => {
      // Guarantees the row inside THIS transaction, before locking it — `for update` on a row that
      // does not exist yet locks nothing, and two concurrent first failures would both read "no
      // row" and both compute failures = 1, losing one. `on conflict do nothing` makes this a
      // no-op once the row exists, so it never resets a count already in progress.
      await tx.query(
        `insert into auth_attempts (id, failures, locked_at, last_attempt_at) values ($1, 0, null, $2) on conflict (id) do nothing`,
        [this.id, nowIso],
      );
      const rows = await tx.query<AttemptsRow>(
        `select failures, locked_at from auth_attempts where id = $1 for update`,
        [this.id],
      );
      // The insert above guarantees exactly one row — no `?? 0` fallback here, so a regression that
      // somehow left the row missing fails loudly (rows[0] is undefined, and this throws) rather
      // than quietly recording a fresh count as if nothing had happened before.
      let failures = rows[0].failures;
      let lockedAt = rows[0].locked_at;

      // Serving the lockout buys back the whole allowance. Without this the count carries over, so
      // the first typo after the wait re-locks immediately and the operator never gets back in —
      // the same rule, for the same reason, as the in-memory limiter.
      if (lockedAt !== null && this.remainingMs(lockedAt, now) === 0) {
        failures = 0;
        lockedAt = null;
      }
      failures += 1;
      if (failures >= this.maxFailures) lockedAt = nowIso;

      await tx.query(
        `insert into auth_attempts (id, failures, locked_at, last_attempt_at)
         values ($1, $2, $3, $4)
         on conflict (id) do update set failures = excluded.failures, locked_at = excluded.locked_at, last_attempt_at = excluded.last_attempt_at`,
        [this.id, failures, lockedAt, nowIso],
      );

      // Eviction, scoped to the per-IP layer only — the global row is one fixed id, never multiplies,
      // and needs no sweep. Runs from the per-IP path because that is the only path that ever CREATES
      // a new row (a failure); a success only ever updates a row that already exists. `id <> $1`
      // leaves the row this same call just wrote alone, so a very slow clock or a huge retention
      // window can never make a call delete the very row it is in the middle of recording.
      if (this.id.startsWith(IP_ROW_PREFIX)) {
        const cutoff = new Date(now.getTime() - PER_IP_ROW_RETENTION_MS).toISOString();
        await tx.query(
          `delete from auth_attempts where id like $1 and id <> $2 and last_attempt_at < $3`,
          [`${IP_ROW_PREFIX}%`, this.id, cutoff],
        );
      }
    });
  }

  async recordSuccess(): Promise<void> {
    await this.db.query(
      `insert into auth_attempts (id, failures, locked_at, last_attempt_at)
       values ($1, 0, null, $2)
       on conflict (id) do update set failures = excluded.failures, locked_at = excluded.locked_at, last_attempt_at = excluded.last_attempt_at`,
      [this.id, new Date().toISOString()],
    );
  }
}
