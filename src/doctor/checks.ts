import type { CheckResult } from "./report";
import { describeDbTarget, type DbConfig } from "../config";

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
 * Never prints the password: `detail` is built from `describeDbTarget` (host and database name
 * only) plus `cfg.env`, never `cfg.url` itself.
 */
export async function runDbCheck(cfg: DbConfig, probe: () => Promise<boolean>): Promise<{ ok: boolean; detail: string }> {
  const target = `${cfg.env} · ${describeDbTarget(cfg)}`;
  try {
    await probe();
    return { ok: true, detail: target };
  } catch (err) {
    return { ok: false, detail: `${target} — ${err instanceof Error ? err.message : String(err)}` };
  }
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
