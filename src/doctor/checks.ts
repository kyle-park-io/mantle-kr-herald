import type { CheckResult } from "./report";
import { describeDbTarget, type DbConfig } from "../config";
import type { Db } from "../adapters/db/Db";

/** Run a config loader: ok if it doesn't throw, fail with its own message otherwise. */
export function configCheck(name: string, run: () => void, okDetail = "configured"): CheckResult {
  try {
    run();
    return { name, status: "ok", detail: okDetail };
  } catch (err) {
    return { name, status: "fail", detail: err instanceof Error ? err.message : String(err) };
  }
}

/**
 * A config check for a credential that cloud mode requires but local mode doesn't. A success is
 * still reported ok (the check is still meaningful information either way); a failure is
 * downgraded from fail to warn when `local` is true, so a fresh local-mode clone doesn't exit
 * non-zero over credentials it genuinely doesn't need — `localDetail` explains why not.
 */
export function cloudCheck(
  name: string,
  run: () => void,
  local: boolean,
  localDetail: string,
  okDetail?: string,
): CheckResult {
  const result = configCheck(name, run, okDetail);
  if (local && result.status === "fail") {
    return { name, status: "warn", detail: `${localDetail} (${result.detail})` };
  }
  return result;
}

/**
 * A credential whose absence is never a failure, in either storage mode — an opt-in publish target
 * (Lark Drive), an optional data hub (Google Sheet §9a), or a source credential only needed if you
 * actually collect from that source (twitterapi, Lark app). Present → ok; absent → warn with
 * `absentDetail` (why it's optional / when you'd need it). Unlike cloudCheck, it takes no `local`
 * flag, because its optionality does not depend on the mode.
 */
export function optionalCheck(name: string, run: () => void, absentDetail: string, okDetail?: string): CheckResult {
  const result = configCheck(name, run, okDetail);
  if (result.status === "fail") {
    return { name, status: "warn", detail: `${absentDetail} (${result.detail})` };
  }
  return result;
}

/**
 * Runs `probe` (a real connectivity check, e.g. `select 1`) against the configured database and
 * reports it — `ok`/`detail` rather than the `CheckResult` shape above, since this also backs
 * `status.ts`'s first line, which is not a check report. The caller wraps this into a `CheckResult`
 * for `doctor`.
 *
 * Never prints the password. `describeDbTarget` itself only ever returns host and database name,
 * but `loadDbConfig` does not validate that `DATABASE_URL` parses as a URL at all, so
 * `describeDbTarget`'s own `new URL(cfg.url)` can throw for a malformed value — and a `URL`
 * constructor's error message is not guaranteed, across engines, not to echo the invalid input back
 * (which could still contain `user:password@`). That parse step is therefore its own try/catch,
 * reported with a fixed, generic message rather than whatever the thrown error says. Only once a
 * `target` string has been safely built does the probe run, and only *that* branch's failure
 * message (a driver error like `ECONNREFUSED`, never derived from `cfg.url`) is shown as-is — this
 * must never throw past the caller, or one malformed value takes down the whole `doctor` report.
 */
export async function runDbCheck(cfg: DbConfig, probe: () => Promise<boolean>): Promise<{ ok: boolean; detail: string }> {
  let target: string;
  try {
    target = `${cfg.env} · ${describeDbTarget(cfg)}`;
  } catch {
    return { ok: false, detail: `${cfg.env} — DATABASE_URL is not a valid URL` };
  }
  try {
    await probe();
    return { ok: true, detail: target };
  } catch (err) {
    return { ok: false, detail: `${target} — ${err instanceof Error ? err.message : String(err)}` };
  }
}

/**
 * The literal line to paste, matching `storage/mode.ts`'s `REMEDY` register: a command, not a
 * pointer to another command. `pnpm db:import --yes` (not a separate `pnpm db:schema`) is the fix
 * because `importOutputTree` applies `applySchema` itself — every statement there is `create table
 * if not exists`, so this is safe to run even against a database that already has the tables, and
 * safe on one with no `output/` tree to import from (it creates the tables and imports zero rows).
 * `--yes` is required in the text itself: the flagless preview path (`previewImport`/`previewExport`,
 * `src/cli/db-import.ts`/`db-export.ts`) deliberately does **not** apply the schema any more — a
 * preview must stay side-effect-free, reachable against production or a read-only role without
 * risking a `CREATE` — so pointing an operator at a flagless `pnpm db:import` here would not
 * actually apply it.
 */
export const SCHEMA_REMEDY = "Run pnpm db:import --yes to apply the schema (safe on an empty database — it also imports output/ into it once you are ready).";

/**
 * `select 1` — `doctor`'s probe before this function existed — passes on a database that has never
 * had `applySchema` run against it, so `doctor` reported "ok" on exactly the database `db:import`
 * cannot use. Only a Postgres "relation ... does not exist" error is rewritten to name the remedy;
 * any other probe failure (bad credentials, network, TLS) is passed through unchanged so its real
 * cause — not a schema guess — stays visible.
 */
export function describeSchemaProbeError(err: unknown): Error {
  const message = err instanceof Error ? err.message : String(err);
  if (/relation .* does not exist/i.test(message)) {
    return new Error(`Schema not applied — ${message}. ${SCHEMA_REMEDY}`);
  }
  return err instanceof Error ? err : new Error(message);
}

/**
 * The real connectivity probe `doctor` runs, as a `runDbCheck`-shaped closure over an already-built
 * `Db`. Touches an actual table (`deliveries` — any of the eleven `applySchema` creates would do;
 * the check only cares that the query fails with "relation ... does not exist" when the schema was
 * never applied) rather than `select 1`, which cannot tell a migrated database from a table-less
 * one. Zero rows is not a failure — only the query itself throwing is.
 */
export function databaseProbe(db: Db): () => Promise<boolean> {
  return async () => {
    try {
      await db.query("select 1 from deliveries limit 1");
    } catch (err) {
      throw describeSchemaProbeError(err);
    }
    return true;
  };
}

/** A space-separated OAuth scope string → array (empties dropped). */
export function parseScopes(scope: string | undefined): string[] {
  return (scope ?? "").split(/\s+/).filter((s) => s.length > 0);
}

const shortScope = (scope: string) => scope.replace("https://www.googleapis.com/auth/", "");

/** ok if `needed` is in the granted scopes, else warn with a fix hint. */
export function scopeCheck(name: string, granted: string[], needed: string, hint: string): CheckResult {
  return granted.includes(needed)
    ? { name, status: "ok", detail: `scope ${shortScope(needed)} granted` }
    : { name, status: "warn", detail: `scope ${shortScope(needed)} NOT granted — ${hint}` };
}

/** Interpret a Drive file-metadata fetch: ok if reachable, fail (404 → re-init hint). */
export function accessResult(name: string, res: { ok: boolean; status: number; fileName?: string }): CheckResult {
  if (res.ok) return { name, status: "ok", detail: `accessible${res.fileName ? ` (${res.fileName})` : ""}` };
  const detail =
    res.status === 404
      ? "not found under this token — re-run pnpm drive:init (drive.file only sees files the app created)"
      : `HTTP ${res.status}`;
  return { name, status: "fail", detail };
}

/**
 * Interpret a Sheets-API spreadsheet fetch. Unlike Drive files (checked with drive.file, which only
 * sees app-created files), a spreadsheet is reached with the `spreadsheets` scope, so this correctly
 * verifies a sheet the operator created themselves (e.g. the performance-tracker workbook).
 * 403 → the Sheets API is disabled in the GCP project, or the account can't access the sheet;
 * 404 → wrong id, or an uploaded `.xlsx` rather than a native Google Sheet.
 */
export function sheetAccessResult(name: string, res: { ok: boolean; status: number; title?: string }): CheckResult {
  if (res.ok) return { name, status: "ok", detail: `accessible${res.title ? ` (${res.title})` : ""}` };
  const detail =
    res.status === 403
      ? "403 — enable the Google Sheets API in the GCP project, or confirm this account can access the sheet"
      : res.status === 404
        ? "not found — check GSHEET_ID (it must be a native Google Sheet, not an uploaded .xlsx)"
        : `HTTP ${res.status}`;
  return { name, status: "fail", detail };
}

/**
 * Below this many remaining publishes, say so. Roughly a day's sends at the current cadence — late
 * enough not to nag, early enough to upgrade or reschedule before a batch is refused outright.
 * Shared with the dashboard banner so the CLI and the screen never disagree about when to worry.
 */
export const LOW_PUBLISHING_QUOTA = 3;

/**
 * The social set's monthly publishing quota. Never `fail`: an account at its plan's ceiling is
 * working exactly as sold, and doctor exiting non-zero over it would be wrong.
 *
 * This answers "is the integration healthy", not "can I send right now" — it is the raw account
 * total, not corrected for drafts scheduled minutes ago that have not yet been confirmed published
 * (the board's banner does that correction; reading the delivery ledger from doctor would be a new
 * dependency for little gain here). "on the account" says so, rather than implying this is what a
 * send would be gated against.
 */
export function quotaResult(
  name: string,
  q: { used: number; remaining: number; resetsAt: string },
): CheckResult {
  const resets = q.resetsAt ? ` · resets ${q.resetsAt.slice(0, 10)}` : "";
  return {
    name,
    status: q.remaining <= LOW_PUBLISHING_QUOTA ? "warn" : "ok",
    detail: `publishing quota ${q.remaining} left of ${q.used + q.remaining} on the account${resets}`,
  };
}

/**
 * Whichever output root is actually in effect — the invariant `src/paths.ts`'s OUTPUT_DIR doc
 * comment names directly: "a non-default root is never silent." Pulled out of `doctor.ts` (which
 * has no test coverage of its own — it's a top-level script with real side effects at import time)
 * so this can be asserted and mutation-tested the same way every other check in this file already
 * is, rather than shipping as an inline `results.push({...})` nothing ever exercises. Always `ok`:
 * this states a fact, it never fails or warns on its own.
 */
export function outputRootResult(outputDir: string, override: string | undefined): CheckResult {
  return {
    name: "Output root",
    status: "ok",
    detail: override ? `${outputDir} (HERALD_OUTPUT_DIR override)` : `${outputDir} (default)`,
  };
}

/**
 * `deploy/herald-notify-failure.sh` needs BOTH `TELEGRAM_BOT_TOKEN` and `TELEGRAM_CHAT_ID_OPS` to
 * post anything at all — checking only one would let this say "configured — will post here" while
 * the hook still silently sends nothing for lack of the other. Warn, never fail: `pnpm doctor`
 * itself never talks to Telegram, so missing either one doesn't stop doctor from being useful; it
 * just means the watch scheduler's `OnFailure=` hook will exit 0 without telling anyone until both
 * are set.
 */
export function telegramOpsChatResult(botToken: string | undefined, chatIdOps: string | undefined): CheckResult {
  const configured = Boolean(botToken) && Boolean(chatIdOps);
  return {
    name: "Telegram ops chat (watch failures)",
    status: configured ? "ok" : "warn",
    detail: configured
      ? "configured — deploy/herald-notify-failure.sh will post here"
      : "not set — pnpm watch's OnFailure hook will run silently until TELEGRAM_BOT_TOKEN and TELEGRAM_CHAT_ID_OPS are both set",
  };
}
