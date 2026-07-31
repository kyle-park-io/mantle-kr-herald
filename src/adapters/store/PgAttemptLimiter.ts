import type { Db } from "../db/Db";
import type { AttemptLimiter } from "../../domain/auth/attemptLimiter";

/** The shape a row from `auth_attempts` (see `src/adapters/db/schema.ts`) comes back as. */
interface AttemptsRow {
  failures: number;
  locked_at: string | null;
}

/** The only row this table ever holds — see the table's comment in `schema.ts`. */
const ROW_ID = "singleton";

/**
 * `AttemptLimiter` backed by the `auth_attempts` table.
 *
 * `attemptLimiter.ts`'s own doc comment explains why this exists: state kept in memory resets per
 * process, so a serverless deployment — a fresh instance per invocation, or several running at
 * once — gets a fresh five-attempt allowance on every request. The lockout that is supposed to
 * protect the one shared credential becomes, in effect, unlimited.
 *
 * One row, not one per client: there is a single credential, so every attempt is an attempt on the
 * same thing, and keying by IP would only tell an attacker to rotate addresses — the same reasoning
 * `createAttemptLimiter` documents. `schema.ts` seeds that row so it always exists: `recordFailure`
 * locks it with `select ... for update` inside `db.tx()`, and a lock only serializes concurrent
 * transactions against a row that is already there. Without the seed, two concurrent first failures
 * would both read "no row", both compute `failures = 1`, and one write would silently overwrite the
 * other — the exact lost update the transaction exists to prevent.
 */
export class PgAttemptLimiter implements AttemptLimiter {
  private readonly maxFailures: number;
  private readonly lockoutMs: number;

  constructor(
    private readonly db: Db,
    options: { maxFailures?: number; lockoutMs?: number } = {},
  ) {
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
      [ROW_ID],
    );
    return this.remainingMs(rows[0]?.locked_at ?? null, now);
  }

  async recordFailure(now: Date): Promise<void> {
    await this.db.tx(async (tx) => {
      const rows = await tx.query<AttemptsRow>(
        `select failures, locked_at from auth_attempts where id = $1 for update`,
        [ROW_ID],
      );
      let failures = rows[0]?.failures ?? 0;
      let lockedAt = rows[0]?.locked_at ?? null;

      // Serving the lockout buys back the whole allowance. Without this the count carries over, so
      // the first typo after the wait re-locks immediately and the operator never gets back in —
      // the same rule, for the same reason, as the in-memory limiter.
      if (lockedAt !== null && this.remainingMs(lockedAt, now) === 0) {
        failures = 0;
        lockedAt = null;
      }
      failures += 1;
      if (failures >= this.maxFailures) lockedAt = now.toISOString();

      await tx.query(
        `insert into auth_attempts (id, failures, locked_at)
         values ($1, $2, $3)
         on conflict (id) do update set failures = excluded.failures, locked_at = excluded.locked_at`,
        [ROW_ID, failures, lockedAt],
      );
    });
  }

  async recordSuccess(): Promise<void> {
    await this.db.query(
      `insert into auth_attempts (id, failures, locked_at)
       values ($1, 0, null)
       on conflict (id) do update set failures = excluded.failures, locked_at = excluded.locked_at`,
      [ROW_ID],
    );
  }
}
