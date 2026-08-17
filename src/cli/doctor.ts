import "./registerErrorHandler";
import { join } from "node:path";
import { statSync, type Stats } from "node:fs";
import {
  loadConfig,
  loadLarkConfig,
  loadLarkDriveConfig,
  loadGoogleAuthConfig,
  loadGoogleDriveConfig,
  loadGoogleSheetConfig,
  loadStorageMode,
  loadTypefullyConfig,
  loadDbConfig,
  loadAuthConfig,
  loadSessionConfig,
  type DbConfig,
} from "../config";
import { createDb } from "../adapters/db/createDb";
import { paths, OUTPUT_DIR, REPO_ROOT } from "../paths";
import { steeringFiles, missingSteeringFiles, skeletonSteeringFiles } from "../doctor/steering";
import { unkeyedFewShotScopes, unkeyedFewShotResult, FEW_SHOT_KEY_CHECK } from "../doctor/fewShot";
import { resolveDeployTree, deploySteeringStatus, deploySteeringResult } from "../doctor/deploySteering";
import { deployEnvStatus, deployEnvResult } from "../doctor/deployEnv";
import { realDeployTreeShow } from "./systemdShow";
import {
  configCheck,
  cloudCheck,
  optionalCheck,
  scopeCheck,
  accessResult,
  sheetAccessResult,
  quotaResult,
  runDbCheck,
  databaseProbe,
  outputRootResult,
  telegramOpsChatResult,
  envModeResult,
} from "../doctor/checks";
import { formatReport, type CheckResult } from "../doctor/report";
import { tryLoadStorageMode } from "../config";
import { runLiveProbes, buildLiveProbeInput, type LiveProbeResult } from "../doctor/liveProbes";

const DRIVE_SCOPE = "https://www.googleapis.com/auth/drive.file";
const SHEETS_SCOPE = "https://www.googleapis.com/auth/spreadsheets";

const live = process.argv.includes("--live");
const results: CheckResult[] = [];

// Best-effort: an unset/invalid mode is already reported by the "Storage mode" check below: this
// only decides whether the cloud-only checks may downgrade fail → warn, so treat "can't tell" the
// same as cloud (the current, unchanged, strict behaviour).
const local = tryLoadStorageMode() === "local";

/** `undefined` for a `.env` that is not there, which `--env-file-if-exists` makes a valid state. */
function statSyncSafe(path: string): Stats | undefined {
  try {
    return statSync(path);
  } catch {
    return undefined;
  }
}

function authMode(): string {
  try {
    return `mode: ${loadGoogleAuthConfig().mode}`;
  } catch {
    return "configured";
  }
}

/** Real connectivity, not gated by `--live`: unlike the third-party integrations below, every
 *  command now needs a working database connection to do anything at all, so this is core
 *  infrastructure rather than an optional network check. Never prints the password — see
 *  `runDbCheck`. Probes a real table (`databaseProbe`), not `select 1` — a database that connects
 *  fine but has never had the schema applied must fail this check, not report ok. */
async function runDatabaseCheck(): Promise<CheckResult> {
  let cfg: DbConfig;
  try {
    cfg = loadDbConfig();
  } catch (err) {
    return { name: "Database", status: "fail", detail: err instanceof Error ? err.message : String(err) };
  }
  const db = createDb(cfg);
  try {
    const check = await runDbCheck(cfg, databaseProbe(db));
    return { name: "Database", status: check.ok ? "ok" : "fail", detail: check.detail };
  } finally {
    await db.close();
  }
}

/** Corpus hygiene, not connectivity: an itemId-less `few_shot_examples` row is unreachable by
 *  `add`'s `on conflict (scope, item_id)` key, so re-approving that example appends a second copy
 *  instead of replacing it. See `src/doctor/fewShot.ts` for the whole argument, including why this
 *  is a `doctor` line and no longer a `state:push` refusal. Opens its own connection the same way
 *  `runDatabaseCheck` above does. Never `fail`, and never a second report of a database that is
 *  simply unreachable — the check above owns that finding, and this one says "not checked" and
 *  points at it rather than printing the same cause twice. */
async function runFewShotKeyCheck(): Promise<CheckResult> {
  let cfg: DbConfig;
  try {
    cfg = loadDbConfig();
  } catch {
    return { name: FEW_SHOT_KEY_CHECK, status: "warn", detail: "not checked — see the Database line above" };
  }
  const db = createDb(cfg);
  try {
    return unkeyedFewShotResult(await unkeyedFewShotScopes(db));
  } catch (err) {
    return {
      name: FEW_SHOT_KEY_CHECK,
      status: "warn",
      detail: `not checked — could not read few_shot_examples (${err instanceof Error ? err.message : String(err)})`,
    };
  } finally {
    await db.close();
  }
}

// --- config checks (offline) ---
// Always reported, override or not: an invisible HERALD_OUTPUT_DIR would recreate the "silently
// created a second output/ tree" trap src/paths.ts's REPO_ROOT comment warns about — see the
// override's own doc comment there for the incident that made this required.
results.push(outputRootResult(OUTPUT_DIR, process.env.HERALD_OUTPUT_DIR));
// Graded here rather than left to the operator's memory for the same reason `deploy-freeze.ts`
// writes its copy at 0o600 instead of preserving whatever it found: `cp .env.example .env` hands a
// file full of credentials the mode of the tracked skeleton it came from, and nothing else in the
// setup path ever looks at it again. `statSync` and not `existsSync` + a second call — a file
// deleted between the two would throw where a missing one is a valid state.
results.push(envModeResult(statSyncSafe(join(REPO_ROOT, ".env"))?.mode));
results.push(configCheck("Storage mode", () => loadStorageMode(), `mode: ${process.env.HERALD_STORAGE_MODE?.trim() ?? "(unset)"}`));
results.push(await runDatabaseCheck());
results.push(await runFewShotKeyCheck());
// The dashboard's gate. Graded `fail` like DATABASE_URL above, and for the same reason: both carry
// `●` in every profile of `.env.example`'s table, and `serve.ts` loads all three before it binds
// anything. Without these lines `doctor` could report `0 fail` on a setup where `pnpm serve` dies
// on startup — which is what a fresh `cp .env.example .env` produces, so the report would be
// reassuring exactly when it should not be. Neither loader is given the storage-mode downgrade:
// there is no mode in which the dashboard runs without an account and a signing key.
results.push(
  configCheck("Dashboard account", () => loadAuthConfig(), `user: ${process.env.HERALD_AUTH_USERNAME?.trim() ?? ""}`),
);
results.push(configCheck("Session secret", () => loadSessionConfig(), "set — dashboard sessions can be signed"));
// twitterapi.io / Lark app are source credentials — you need one only if you collect from that
// source, in either mode. Absence is a warn, never a fail: a Google+X operator has no Lark, and a
// Lark-only operator has no twitterapi, and both are valid.
results.push(
  optionalCheck("twitterapi.io (A)", () => loadConfig(), "only needed to collect from X (source A)", "TWITTERAPI_IO_KEY set"),
);
results.push(optionalCheck("Lark app (B)", () => loadLarkConfig(), "only needed to collect from Lark (source B)"));
// Cloud-publish credentials. Google auth + Google Drive are the core cloud path (the default
// publish target), so they hard-fail in cloud mode. Lark Drive is opt-in and Google Sheet (§9a) is
// an optional data hub, so their absence is only ever a warn — cloud mode without them is a valid
// Google-only setup, not a broken one.
results.push(optionalCheck("Lark Drive (D)", () => loadLarkDriveConfig(), "opt-in — only if you publish to Lark Drive"));
results.push(cloudCheck("Google auth", () => loadGoogleAuthConfig(), local, "not needed in local mode", authMode()));
results.push(cloudCheck("Google Drive (D)", () => loadGoogleDriveConfig(), local, "not needed in local mode"));
results.push(optionalCheck("Google Sheet (§9a)", () => loadGoogleSheetConfig(), "optional — only for the Sheet data hub (§9a)"));
// X delivery is opt-in — a Telegram-only install is a valid setup, not a broken one.
results.push(optionalCheck("Typefully (X)", () => loadTypefullyConfig(), "only needed to send to X"));
// Read directly rather than through a config loader: these are `deploy/herald-notify-failure.sh`'s
// variables, not any TypeScript command's, so there is no `load*Config` for them to go through —
// this line is the only thing in `src/` that ever reads TELEGRAM_CHAT_ID_OPS (TELEGRAM_BOT_TOKEN
// is also read by src/config.ts, for the unrelated `send:channels` credential).
results.push(telegramOpsChatResult(process.env.TELEGRAM_BOT_TOKEN, process.env.TELEGRAM_CHAT_ID_OPS));

// Presence is not enough: `config:init` writes empty skeletons, so a file can exist and steer
// nothing. Reporting ok there would hide exactly the failure that matters — translating with an
// empty glossary, silently. Look at the content too.
const missing = await missingSteeringFiles(steeringFiles(paths.translationConfigDir, paths.conversionConfigDir));
const skeletons = missing.length === 0 ? await skeletonSteeringFiles(paths.translationConfigDir, paths.conversionConfigDir) : [];
results.push(
  missing.length > 0
    ? {
        name: "Steering config",
        status: "fail",
        detail: `missing ${missing.length} file(s) — fresh install: pnpm config:init · had them before: docs/ko/setup/steering.md`,
      }
    : skeletons.length > 0
      ? {
          name: "Steering config",
          status: "warn",
          detail: `present but empty: ${skeletons.join(", ")} — skeletons steer nothing (docs/ko/setup/steering.md)`,
        }
      : { name: "Steering config", status: "ok", detail: "translation/ + conversion/ present" },
);

// The check above grades the files in THIS checkout. On the machine that runs the timers there is a
// second copy of all of them — `deploy/herald-deploy.sh` copies this tree's into the deploy checkout
// the units set as their WorkingDirectory — and only that script ever moves it. So a `pnpm glossary
// add` with no deploy after it leaves the two graded ✓ and the scheduler translating with the old
// one, which is the failure this line reports and nothing else does.
//
// `REPO_ROOT`, not a constant: doctor's own tree is wherever this module was loaded from, so running
// the command in the deploy checkout asks the question the other way round — see `same-tree`. The
// deploy tree's location is never in `src/` at all; it is systemd's answer, or this variable.
//
// Spelled out here rather than indexed with `deploySteering.ts`'s own constant, even though that is
// the one place the name is defined: `tests/config/envExample.test.ts` finds a variable by scanning
// source text for a literal `process.env.<NAME>` read, so an indexed one would be invisible to it
// and `.env.example`'s entry would be reported as documenting a variable nothing reads.
const deployTree = resolveDeployTree({
  override: process.env.HERALD_DEPLOY_DIR,
  unitShow: realDeployTreeShow(),
});
results.push(deploySteeringResult(deploySteeringStatus(REPO_ROOT, deployTree)));

// The same two-tree question for `.env`, which had no line at all until it was noticed that the
// steering half has been reported since 2026-08-09 while credentials — copied by the same script, at
// the same moment, into the same tree — had nothing watching them. Rotating a key here without
// running the deploy leaves the timers authenticating with the old one, and every symptom of that
// is a downstream authentication error attributed to the credential rather than to the copy.
//
// Shares `deployTree` with the check above rather than resolving it twice: two systemd queries could
// disagree (a `daemon-reload` between them), and a report where one line says "not applicable" while
// the next names a directory would be read as a bug in doctor, not in the machine.
results.push(deployEnvResult(deployEnvStatus(REPO_ROOT, deployTree)));

// --- live checks (network, read-only) ---
if (live) {
  // The environment → `LiveProbeInput` step lives in the probe module, not here: `createDeps.ts`
  // needs the identical thing for `GET /api/diagnostics/live`, and this block used to be its
  // verbatim twin.
  const probes = await runLiveProbes(buildLiveProbeInput());
  const byKey = (key: string): LiveProbeResult | undefined => probes.find((p) => p.key === key);
  /**
   * For a probe that never reached the network at all — not configured (`skipped`), or blocked on a
   * Google token that never came (`dead` with no `httpStatus`) — there is no HTTP response for
   * accessResult/sheetAccessResult to interpret, so fall back to the probe's own status and detail
   * verbatim rather than inventing one.
   *
   * **`skipped` maps to `warn`, where the pre-module code pushed a `fail` from its catch.** That is
   * deliberate, and it is the one live-block verdict this branch changed on the unhappy path:
   *
   * - Presence is graded once already, offline, and with the mode-awareness this line cannot have.
   *   `cloudCheck("Google auth", …)` above fails a missing Google credential in cloud mode and
   *   reports "not needed in local mode" in local mode; `optionalCheck` grades a missing Lark app or
   *   Typefully key a `warn` because a Google+X operator has no Lark and a Telegram-only operator
   *   has no Typefully. The old live `fail` contradicted every one of those judgements — including
   *   itself: `pnpm doctor --live` in local mode exited 1 over a credential the same report, four
   *   lines earlier, called not needed.
   * - It cannot turn a red into a green. Every configuration where a probe reports `skipped` is one
   *   where the offline check above has already graded the same absence, so nothing that used to
   *   fail now passes silently — only the double-count is gone.
   * - "Not configured" and "configured but dead" are different findings with different remedies, and
   *   `liveProbes.ts` returns them as different statuses precisely so a reader can tell them apart.
   *   `checkLiveness` (`smokeChecks.ts`) draws the same line for the same reason.
   *
   * A `dead` probe is still a `fail`, unchanged — including the case the old code could not
   * distinguish at all: Google auth configured but its service-account key file unreadable, which
   * `buildLiveProbeInput` now surfaces as `dead` rather than as an absent probe.
   */
  const passthrough = (name: string, probe: LiveProbeResult): CheckResult => ({
    name,
    status: probe.status === "ok" ? "ok" : probe.status === "skipped" ? "warn" : "fail",
    detail: probe.detail,
  });
  const viaHttp = (name: string, probe: LiveProbeResult, render: (ok: boolean, status: number) => CheckResult): CheckResult =>
    probe.status === "ok" || (probe.status === "dead" && probe.httpStatus !== undefined)
      ? render(probe.status === "ok", probe.httpStatus ?? 0)
      : passthrough(name, probe);

  const auth = byKey("google_auth");
  if (auth) {
    if (auth.status === "ok") {
      // Same construction the module's own tokeninfo call used to feed straight into `doctor.ts`
      // before Task 2: the granted-scopes summary on the auth line, and the two scope checks below it.
      const granted = auth.grantedScopes ?? [];
      const shown = granted.map((s) => s.replace("https://www.googleapis.com/auth/", "")).join(", ") || "(none reported)";
      results.push({ name: "Google auth  live", status: "ok", detail: `token OK · scopes: ${shown}` });
      results.push(scopeCheck("Google Drive  live", granted, DRIVE_SCOPE, "run pnpm google:auth"));
      results.push(
        scopeCheck("Google Sheet  live", granted, SHEETS_SCOPE, "add spreadsheets to GOOGLE_OAUTH_SCOPE + pnpm google:auth"),
      );

      const driveReview = byKey("google_drive_review");
      if (driveReview) {
        results.push(
          viaHttp("Google Drive review   live", driveReview, (ok, status) =>
            accessResult("Google Drive review   live", { ok, status, fileName: driveReview.resourceName }),
          ),
        );
      }
      const driveApproved = byKey("google_drive_approved");
      if (driveApproved) {
        results.push(
          viaHttp("Google Drive approved  live", driveApproved, (ok, status) =>
            accessResult("Google Drive approved  live", { ok, status, fileName: driveApproved.resourceName }),
          ),
        );
      }
      const sheets = byKey("google_sheets");
      if (sheets) {
        results.push(
          viaHttp("Google Sheet file  live", sheets, (ok, status) =>
            // The scope check two lines up already knows this; pass it along so a 404 can say which
            // of its two causes applies instead of always blaming the id.
            sheetAccessResult("Google Sheet file  live", {
              ok,
              status,
              title: sheets.resourceName,
              spreadsheetsScopeGranted: granted.includes(SHEETS_SCOPE),
            }),
          ),
        );
      }
    } else {
      // No token was ever obtained — nothing downstream of one was checked, so (like the
      // pre-module implementation) only this one line is reported, not five absent/blamed ones.
      results.push(passthrough("Google auth  live", auth));
    }
  }

  const lark = byKey("lark");
  if (lark) results.push(passthrough("Lark  live", lark));

  const typefully = byKey("typefully");
  if (typefully) {
    results.push(
      typefully.status === "ok" && typefully.quota
        ? quotaResult("Typefully  live", {
            used: typefully.quota.limit - typefully.quota.remaining,
            remaining: typefully.quota.remaining,
            resetsAt: typefully.quota.resetsAt ?? "",
          })
        : passthrough("Typefully  live", typefully),
    );
  }

  // New — did not exist before this module: a gap in the old output, not a regression.
  const telegram = byKey("telegram");
  if (telegram) results.push(passthrough("Telegram  live", telegram));
}

console.log(formatReport(results, { live }));
if (results.some((r) => r.status === "fail")) process.exitCode = 1;
