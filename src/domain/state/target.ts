import { tryDescribeDbTarget, INVALID_DB_URL, type DbConfig } from "../../config";

/**
 * What a backup command prints before it does anything, so the operator can see which database it
 * actually opened.
 *
 * The warning exists because the failure is silent and the success message is identical either way.
 * `EnvironmentFile=%h/.herald/prod.env` is what points a command at Neon — not which checkout it
 * runs from — so `pnpm state:push` typed by hand in either tree opens local Docker and reports a
 * cheerful row count for a database nobody is trying to protect. Measured 2026-08-13: production
 * held 30 few-shot rows that had never been in a snapshot, while the local copy held 23.
 *
 * A warning, not a refusal. Snapshotting a development database is a legitimate deliberate act, and
 * `db:export`'s rollback path depends on exactly that. It must simply stop being the thing that
 * happens by accident.
 *
 * **`tryDescribeDbTarget`, not `describeDbTarget`** — the rule `src/config.ts` states for every
 * context whose output "ends up in a shared journal or a report". `loadDbConfig` never validates
 * that `DATABASE_URL` parses as a URL, so `describeDbTarget`'s own `new URL(cfg.url)` throws on a
 * malformed one, and a `URL` constructor's message is not guaranteed across engines not to echo the
 * invalid input back — `user:password@` included. This is the first line `state:push` prints, and
 * `herald-backup.service` runs it nightly under an `OnFailure=` hook that relays its stderr into a
 * Telegram room, so a throw here would put an unvalidated `DATABASE_URL` in front of that room and
 * the journal instead of a fixed sentence naming the real problem. The guard belongs with the call,
 * not with each caller's memory of needing it.
 */
export interface BackupTargetOptions {
  /**
   * Whether a `development` target earns the ⚠ line telling the reader to point at production.
   *
   * `true` for `state:push`, whose only purpose is protecting production and which the design spec
   * scoped this warning to. **`false` for `db:export`**, where the advice is not merely noise but
   * wrong: exporting the development database is one of that command's legitimate uses (it writes
   * the local `output/` tree and the local corpus files), so a reader who followed the ⚠ and pointed
   * at production would overwrite their local corpus with production's. The host line is printed
   * either way — knowing which database was opened is what both commands need.
   */
  readonly warnOnDevelopment?: boolean;
}

export function describeBackupTarget(cfg: DbConfig, opts: BackupTargetOptions = {}): string[] {
  const lines = [`데이터베이스: ${tryDescribeDbTarget(cfg) ?? INVALID_DB_URL}  (HERALD_DB_ENV=${cfg.env})`];
  if (cfg.env === "development" && (opts.warnOnDevelopment ?? true)) {
    lines.push(
      "  ⚠ development 데이터베이스입니다. 프로덕션(Neon)을 백업하려면 DATABASE_URL과 " +
        "HERALD_DB_ENV=production 을 주고 돌리세요 — 스케줄 유닛은 ~/.herald/prod.env 로 그렇게 합니다.",
    );
  }
  return lines;
}
