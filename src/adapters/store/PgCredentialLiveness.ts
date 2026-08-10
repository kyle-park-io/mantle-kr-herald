import type { Db } from "../db/Db";
import type { LivenessObservation, StoredProbe } from "../../status/liveness";

interface Row {
  probes: string;
  observed_at: string;
}

/** Same spelling as `PgAttemptLimiter`'s and `PgTranslateFloorReport`'s global row, and for the same
 *  reason: a single-row table still needs a primary key for `on conflict` to conflict on. */
const ROW_ID = "singleton";

/** `value` as a stored probe list, or `undefined` if it is not one. Total over its input on purpose:
 *  the column is text this code wrote, but a row can also be hand-edited or left behind by a build
 *  whose shape has since changed, and the caller is `/api/status` on every board load. */
function parseProbes(value: string): StoredProbe[] | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    return undefined;
  }
  if (!Array.isArray(parsed)) return undefined;
  const probes: StoredProbe[] = [];
  for (const entry of parsed) {
    if (entry === null || typeof entry !== "object") return undefined;
    const { key, status, detail } = entry as { key?: unknown; status?: unknown; detail?: unknown };
    if (typeof key !== "string" || key === "") return undefined;
    if (status !== "ok" && status !== "dead" && status !== "skipped") return undefined;
    if (typeof detail !== "string") return undefined;
    probes.push({ key: key as StoredProbe["key"], status, detail });
  }
  return probes;
}

/**
 * Reads and writes the deployment's last credential observation — one upserted row in
 * `credential_liveness`.
 *
 * **One writer, and it is the deployment itself.** `createDeps`'s `probeLiveness`, immediately after
 * running the probes, on whichever request asked. Not `pnpm creds:check`: that command talks to the
 * deployment over HTTP precisely because the deployment's credentials cannot be read from outside,
 * and a CLI reaching into production Postgres to record what it learned over HTTP would re-open the
 * coupling the HTTP call exists to avoid. Not `pnpm doctor --live` either — it probes the LOCAL
 * `.env`, a different set of objects, and must never land in a row the board reads as the
 * deployment's.
 *
 * **Reader** is `/api/status`, degrading to `undefined` rather than taking the header down — see
 * `createDeps`'s `readLiveness`.
 *
 * Constructed at the call site rather than added to `createStores`, the same treatment
 * `PgAttemptLimiter` and `PgTranslateFloorReport` get: `Stores` is the reviewed-content set that
 * `db:export`/`db:import` move, and this is operational state neither touches.
 */
export class PgCredentialLiveness {
  constructor(private readonly db: Db) {}

  async read(): Promise<LivenessObservation | undefined> {
    const rows = await this.db.query<Row>(
      `select probes, observed_at from credential_liveness where id = $1`,
      [ROW_ID],
    );
    const row = rows[0];
    if (row === undefined) return undefined;
    const probes = parseProbes(row.probes);
    if (probes === undefined) return undefined;
    return { probes, observedAt: row.observed_at };
  }

  async write(observation: LivenessObservation): Promise<void> {
    await this.db.query(
      `insert into credential_liveness (id, probes, observed_at)
       values ($1, $2, $3)
       on conflict (id) do update set probes = excluded.probes, observed_at = excluded.observed_at`,
      [ROW_ID, JSON.stringify(observation.probes), observation.observedAt],
    );
  }
}
