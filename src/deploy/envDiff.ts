import type { CheckResult } from "../doctor/report";

/**
 * Names both this machine's `.env` and the Vercel deployment are meant to hold.
 *
 * The middle column of the ownership split `.env.example`'s profile table states per variable:
 * credentials whose readers run in both places. Deliberately not the whole of `MUST_BE_SET` —
 * `DATABASE_URL`, `HERALD_DB_ENV`, `HERALD_STORAGE_MODE`, the auth trio, `HERALD_TRUST_PROXY` and
 * `HERALD_DEPLOYMENT_ORIGIN` are the deployment's alone, and the operator machine is *supposed* to
 * differ on every one of them (local storage, a development database, its own dashboard account).
 * Listing one here would report a correct setup as broken on every run, which is how a check earns
 * being switched off. `tests/deploy/envDiff.test.ts` pins both halves of that boundary.
 *
 * `TWITTERAPI_IO_KEY` is the one entry not in `MUST_BE_SET`, and the reason is the same reason this
 * command exists. 링크 수집 is opt-in (`HERALD_INTAKE_ENABLED`), so a review-only deployment
 * legitimately has no use for the key and `deploy:check` should not nag about it forever. But when
 * both sides are meant to collect, a machine holding the key while Vercel does not is invisible
 * everywhere else: `checkEnvNames` has no opinion on a name in neither of its lists, and the only
 * symptom is the intake tab quietly staying shut.
 */
export const SHARED_WITH_DEPLOYMENT: readonly string[] = [
  "TWITTERAPI_IO_KEY",
  "GOOGLE_AUTH_MODE",
  "GOOGLE_OAUTH_CLIENT_ID",
  "GOOGLE_OAUTH_CLIENT_SECRET",
  "GOOGLE_OAUTH_REFRESH_TOKEN",
  "GDRIVE_REVIEW_FOLDER_ID",
  "GDRIVE_APPROVED_FOLDER_ID",
  "GDRIVE_SENT_FOLDER_ID",
  "LARK_APP_ID",
  "LARK_APP_SECRET",
  "LARK_WORKSPACE_URL",
  "LARK_DRIVE_REVIEW_FOLDER_TOKEN",
  "LARK_DRIVE_APPROVED_FOLDER_TOKEN",
  "LARK_DRIVE_SENT_FOLDER_TOKEN",
  "TELEGRAM_BOT_TOKEN",
  "TELEGRAM_CHAT_ID_COMMUNITY",
  "TELEGRAM_CHAT_ID_DEV",
  "TYPEFULLY_API_KEY",
  "TYPEFULLY_SOCIAL_SET_ID",
  "X_PREMIUM",
  "GSHEET_ID",
  "GSHEET_QA_ID",
];

export interface EnvNameComparison {
  /** Names with a non-empty value in this machine's `.env`. */
  local: readonly string[];
  /** Names registered in the Vercel production environment. Values are never read — see below. */
  remote: readonly string[];
  shared?: readonly string[];
}

/**
 * Compares which shared names each side holds. Names, never values.
 *
 * Values are not compared because they cannot be: Vercel returns everything stored as sensitive —
 * which is most of this list — as the literal string `[SENSITIVE]`, so a value comparison would
 * report twenty credentials as matching while telling you nothing at all about them. Whether the
 * two sides' secrets *work* is a different question, and one this repo already answers from both
 * ends: `pnpm doctor --live` for this machine, `pnpm creds:check` (which asks the deployment about
 * its own) for the other.
 *
 * A name missing from both sides is reported once, not twice. Two lines for one absence reads as
 * two problems, and this report is meant to be scanned.
 */
export function compareEnvNames({ local, remote, shared = SHARED_WITH_DEPLOYMENT }: EnvNameComparison): CheckResult[] {
  const here = new Set(local);
  const there = new Set(remote);

  return shared.map((name) => {
    const inLocal = here.has(name);
    const inRemote = there.has(name);

    if (inLocal && inRemote) return { name, status: "ok", detail: "set in both" };
    if (inLocal) {
      return {
        name,
        status: "warn",
        detail: "set here but not in Vercel production — the deployment is missing a credential this machine has.",
      };
    }
    if (inRemote) {
      return {
        name,
        status: "warn",
        detail: "set in Vercel production but not in this machine's .env — restore it before running the scheduler.",
      };
    }
    return { name, status: "warn", detail: "set in neither — nothing that needs it can run on either side." };
  });
}
