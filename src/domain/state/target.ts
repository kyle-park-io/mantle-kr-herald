import { describeDbTarget, type DbConfig } from "../../config";

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
 */
export function describeBackupTarget(cfg: DbConfig): string[] {
  const lines = [`데이터베이스: ${describeDbTarget(cfg)}  (HERALD_DB_ENV=${cfg.env})`];
  if (cfg.env === "development") {
    lines.push(
      "  ⚠ development 데이터베이스입니다. 프로덕션(Neon)을 백업하려면 DATABASE_URL과 " +
        "HERALD_DB_ENV=production 을 주고 돌리세요 — 스케줄 유닛은 ~/.herald/prod.env 로 그렇게 합니다.",
    );
  }
  return lines;
}
