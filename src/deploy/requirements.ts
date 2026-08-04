import type { CheckResult } from "../doctor/report";

/**
 * One environment-variable expectation the Vercel production deployment holds, independent of
 * whether it is currently met. `severity` is what a violation becomes — `fail` for the eight
 * `assert*` startup guards in `api/[...path].ts` (`.env.example` §6, "refuses to start"), `warn`
 * for everything that boots but degrades in silence (the §3/§4 groups `.env.example` §6 calls
 * "starts fine and is quietly wrong"). `consequence` is written in English, one line, in the same
 * register as `src/doctor/checks.ts`'s existing `detail` strings — `deploy:check` prints through
 * the same `formatReport` (`src/doctor/report.ts:21`, one `${name} ${detail}` line per result, no
 * wrapping) that `pnpm doctor` does, so a mixed-language or multi-line report would read as two
 * tools disagreeing rather than one. Korean stays for the dashboard and `docs/ko/`, not CLI output.
 * See `.env.example` §6 and `docs/ko/setup/vercel.md` §4 for the reasoning this restates.
 */
export interface EnvExpectation {
  name: string;
  severity: "fail" | "warn";
  consequence: string;
}

/**
 * Names the deployment must have set. The eight `fail` entries are `.env.example` §6's "refuses to
 * start" list (§1's `DATABASE_URL`/`HERALD_DB_ENV`, §5's auth trio, and the three §6-only values);
 * everything else is a `warn` entry from §3/§4 — present in a healthy install, but its absence never
 * stops the function from booting, only quietly turns a feature off (a Telegram-only install with no
 * Google Drive credentials is a legitimate deployment, not a broken one).
 */
export const MUST_BE_SET: readonly EnvExpectation[] = [
  {
    name: "DATABASE_URL",
    severity: "fail",
    consequence: "Function will not start — no Postgres connection string for the pipeline's record of truth.",
  },
  {
    name: "HERALD_DB_ENV",
    severity: "fail",
    consequence: "Function will not start — loadDbEnv() throws without it rather than guessing the target from the URL.",
  },
  {
    name: "HERALD_STORAGE_MODE",
    severity: "fail",
    consequence: 'Function will not start unless this is exactly "cloud" — assertCloudStorage refuses local mode on Vercel.',
  },
  {
    name: "HERALD_AUTH_USERNAME",
    severity: "fail",
    consequence: "Function will not start — every route but POST /api/login sits behind the session this account opens.",
  },
  {
    name: "HERALD_AUTH_PASSWORD_HASH",
    severity: "fail",
    consequence: "Function will not start — pairs with HERALD_AUTH_USERNAME; generate both with pnpm auth:hash.",
  },
  {
    name: "HERALD_SESSION_SECRET",
    severity: "fail",
    consequence: "Function will not start — signs the session cookie; no way to issue a session without it.",
  },
  {
    name: "HERALD_TRUST_PROXY",
    severity: "fail",
    consequence:
      'Function will not start unless this is exactly "true" — assertTrustProxy refuses to serve with no address to key the per-address login lockout on.',
  },
  {
    name: "HERALD_DEPLOYMENT_ORIGIN",
    severity: "fail",
    consequence: "Function will not start — the CSRF guard has no origin to compare state-changing requests against.",
  },
  {
    name: "GOOGLE_AUTH_MODE",
    severity: "warn",
    consequence: "Google publish target disappears silently — createDeps swallows the config error, button just goes inactive.",
  },
  {
    name: "GOOGLE_OAUTH_CLIENT_ID",
    severity: "warn",
    consequence: "Google publish target disappears silently — createDeps swallows the config error, button just goes inactive.",
  },
  {
    name: "GOOGLE_OAUTH_CLIENT_SECRET",
    severity: "warn",
    consequence: "Google publish target disappears silently — createDeps swallows the config error, button just goes inactive.",
  },
  {
    name: "GOOGLE_OAUTH_REFRESH_TOKEN",
    severity: "warn",
    consequence: "Google publish target disappears silently — createDeps swallows the config error, button just goes inactive.",
  },
  {
    name: "GDRIVE_REVIEW_FOLDER_ID",
    severity: "warn",
    consequence: "Google publish target disappears silently — no review folder id, so createDeps skips it.",
  },
  {
    name: "GDRIVE_APPROVED_FOLDER_ID",
    severity: "warn",
    consequence: "Google publish target disappears silently — no approved folder id, so createDeps skips it.",
  },
  {
    name: "GDRIVE_SENT_FOLDER_ID",
    severity: "warn",
    consequence: "No Google Drive archive copy is written after a send — delivery itself is unaffected.",
  },
  {
    name: "LARK_APP_ID",
    severity: "warn",
    consequence: "Lark publish target disappears silently — same as Google, no error, just an inactive button.",
  },
  {
    name: "LARK_APP_SECRET",
    severity: "warn",
    consequence: "Lark publish target disappears silently — same as Google, no error, just an inactive button.",
  },
  {
    name: "LARK_WORKSPACE_URL",
    severity: "warn",
    consequence: "Dashboard shows no Lark folder/file links — used only for link-building, publishing is unaffected.",
  },
  {
    name: "LARK_DRIVE_REVIEW_FOLDER_TOKEN",
    severity: "warn",
    consequence: "Lark publish target disappears silently — same as Google, no error, just an inactive button.",
  },
  {
    name: "LARK_DRIVE_APPROVED_FOLDER_TOKEN",
    severity: "warn",
    consequence: "Lark publish target disappears silently — same as Google, no error, just an inactive button.",
  },
  {
    name: "LARK_DRIVE_SENT_FOLDER_TOKEN",
    severity: "warn",
    consequence: "No Lark Drive archive copy is written after a send — delivery itself is unaffected.",
  },
  {
    name: "TELEGRAM_BOT_TOKEN",
    severity: "warn",
    consequence: "Boots fine now, but Telegram sends fail once §6 turns HERALD_SENDS_ENABLED on.",
  },
  {
    name: "TELEGRAM_CHAT_ID_COMMUNITY",
    severity: "warn",
    consequence: "Boots fine now, but sends to the community room fail once §6 opens sends.",
  },
  {
    name: "TELEGRAM_CHAT_ID_DEV",
    severity: "warn",
    consequence: "Boots fine now, but sends to the dev room fail once §6 opens sends.",
  },
  {
    name: "TYPEFULLY_API_KEY",
    severity: "warn",
    consequence: "Boots fine now, but sends to X fail once §6 opens sends.",
  },
  {
    name: "TYPEFULLY_SOCIAL_SET_ID",
    severity: "warn",
    consequence: "Boots fine now, but sends to X fail once §6 opens sends.",
  },
  {
    name: "X_PREMIUM",
    severity: "warn",
    consequence:
      "Unset defaults to the standard 280-weighted tweet limit (Korean/emoji count as 2) — a real Premium account gets long-form posts rejected on the first live send, against a 15/month quota.",
  },
  {
    name: "GSHEET_ID",
    severity: "warn",
    consequence: "Dashboard header loses its Sheet link — publishing and sends are unaffected.",
  },
  {
    name: "GSHEET_QA_ID",
    severity: "warn",
    consequence: "Dashboard header loses its QA Sheet link — no other effect.",
  },
];

/**
 * Names the deployment must NOT have set. `.env.example` §6's own two cases: a local file path
 * that can never resolve inside the function (`fail` — present is a mistake, not a preference), and
 * the flag that reopens sends the hosted board deliberately ships with closed (`warn` — present this
 * early skips the step-6 decision to open it, but does not itself break anything running today).
 */
export const MUST_BE_ABSENT: readonly EnvExpectation[] = [
  {
    name: "GOOGLE_SA_KEY_FILE",
    severity: "fail",
    consequence: "Must not be set — a local file path (e.g. keys/mantle-sa.json) that does not exist in the function.",
  },
  {
    name: "HERALD_SENDS_ENABLED",
    severity: "warn",
    consequence: "Hosted board ships with sends closed by design — already set here skips the deliberate §6 decision to open them.",
  },
];

/**
 * Checks only variable *names* — never values — against `MUST_BE_SET`/`MUST_BE_ABSENT`. One
 * `CheckResult` per expectation, in list order, and nothing else: a name present in `present` that
 * appears in neither list (Neon injects roughly sixteen of these — `PGHOST`, `POSTGRES_URL`, etc.)
 * produces no result at all, because this function has no opinion about it.
 */
export function checkEnvNames(present: readonly string[]): CheckResult[] {
  const has = new Set(present);
  const results: CheckResult[] = [];

  for (const { name, severity, consequence } of MUST_BE_SET) {
    if (has.has(name)) {
      results.push({ name, status: "ok", detail: `${name} set` });
    } else {
      results.push({ name, status: severity, detail: consequence });
    }
  }

  for (const { name, severity, consequence } of MUST_BE_ABSENT) {
    if (has.has(name)) {
      results.push({ name, status: severity, detail: consequence });
    } else {
      results.push({ name, status: "ok", detail: `${name} not set` });
    }
  }

  return results;
}
