import "./registerErrorHandler";
import { join } from "node:path";
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
  type DbConfig,
} from "../config";
import { createDb } from "../adapters/db/createDb";
import { createGoogleAuth } from "../adapters/drive/createGoogleAuth";
import { LarkAuth } from "../adapters/lark/LarkAuth";
import { TypefullyQuota } from "../adapters/send/TypefullyQuota";
import { HttpClient } from "../shared/http/HttpClient";
import { paths, OUTPUT_DIR } from "../paths";
import { steeringFiles, missingSteeringFiles, skeletonSteeringFiles } from "../doctor/steering";
import {
  configCheck,
  cloudCheck,
  optionalCheck,
  parseScopes,
  scopeCheck,
  accessResult,
  sheetAccessResult,
  quotaResult,
  runDbCheck,
  databaseProbe,
  outputRootResult,
  telegramOpsChatResult,
} from "../doctor/checks";
import { formatReport, type CheckResult } from "../doctor/report";
import { tryLoadStorageMode } from "../config";

const DRIVE_SCOPE = "https://www.googleapis.com/auth/drive.file";
const SHEETS_SCOPE = "https://www.googleapis.com/auth/spreadsheets";

const live = process.argv.includes("--live");
const results: CheckResult[] = [];

// Best-effort: an unset/invalid mode is already reported by the "Storage mode" check below: this
// only decides whether the cloud-only checks may downgrade fail → warn, so treat "can't tell" the
// same as cloud (the current, unchanged, strict behaviour).
const local = tryLoadStorageMode() === "local";

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

// --- config checks (offline) ---
// Always reported, override or not: an invisible HERALD_OUTPUT_DIR would recreate the "silently
// created a second output/ tree" trap src/paths.ts's REPO_ROOT comment warns about — see the
// override's own doc comment there for the incident that made this required.
results.push(outputRootResult(OUTPUT_DIR, process.env.HERALD_OUTPUT_DIR));
results.push(configCheck("Storage mode", () => loadStorageMode(), `mode: ${process.env.HERALD_STORAGE_MODE?.trim() ?? "(unset)"}`));
results.push(await runDatabaseCheck());
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

// --- live checks (network, read-only) ---
if (live) {
  try {
    const auth = await createGoogleAuth(loadGoogleAuthConfig());
    const token = await auth.getToken();
    const info = (await fetch(
      `https://oauth2.googleapis.com/tokeninfo?access_token=${encodeURIComponent(token)}`,
    ).then((r) => r.json())) as { scope?: string };
    const granted = parseScopes(info.scope);
    const shown = granted.map((s) => s.replace("https://www.googleapis.com/auth/", "")).join(", ") || "(none reported)";
    results.push({ name: "Google auth  live", status: "ok", detail: `token OK · scopes: ${shown}` });
    results.push(scopeCheck("Google Drive  live", granted, DRIVE_SCOPE, "run pnpm google:auth"));
    results.push(
      scopeCheck("Google Sheet  live", granted, SHEETS_SCOPE, 'add spreadsheets to GOOGLE_OAUTH_SCOPE + pnpm google:auth'),
    );

    // Are the configured Drive folders / Sheet actually reachable with this token?
    // (drive.file only sees files the app created — a stale folder id gives 404.)
    const fileAccess = async (label: string, id: string): Promise<void> => {
      const r = await fetch(`https://www.googleapis.com/drive/v3/files/${id}?fields=id,name`, {
        headers: { Authorization: `Bearer ${token}` },
      });
      const fileName = r.ok ? ((await r.json()) as { name?: string }).name : undefined;
      results.push(accessResult(label, { ok: r.ok, status: r.status, fileName }));
    };
    // The Sheet is reached with the spreadsheets scope via the Sheets API — not drive.file — so this
    // verifies a sheet the operator created themselves (unlike fileAccess, which only sees app-created files).
    const sheetAccess = async (label: string, id: string): Promise<void> => {
      const r = await fetch(`https://sheets.googleapis.com/v4/spreadsheets/${id}?fields=spreadsheetId,properties.title`, {
        headers: { Authorization: `Bearer ${token}` },
      });
      const title = r.ok ? ((await r.json()) as { properties?: { title?: string } }).properties?.title : undefined;
      // The scope check two lines up already knows this; pass it along so a 404 can say which of its
      // two causes applies instead of always blaming the id.
      results.push(
        sheetAccessResult(label, { ok: r.ok, status: r.status, title, spreadsheetsScopeGranted: granted.includes(SHEETS_SCOPE) }),
      );
    };
    try {
      const g = loadGoogleDriveConfig();
      await fileAccess("Google Drive review   live", g.reviewFolderId);
      await fileAccess("Google Drive approved  live", g.approvedFolderId);
    } catch {
      // Drive folders not configured — the offline config check already reported it.
    }
    try {
      const gs = loadGoogleSheetConfig();
      await sheetAccess("Google Sheet file  live", gs.spreadsheetId);
    } catch {
      // GSHEET_ID not set — the offline config check already reported it.
    }
  } catch (err) {
    results.push({ name: "Google auth  live", status: "fail", detail: err instanceof Error ? err.message : String(err) });
  }

  try {
    const l = loadLarkConfig();
    const auth = new LarkAuth(new HttpClient(l.baseUrl), l.appId, l.appSecret);
    const token = await auth.getToken();
    const chats = (await fetch(`${l.baseUrl}/open-apis/im/v1/chats?page_size=100`, {
      headers: { Authorization: `Bearer ${token}` },
    }).then((r) => r.json())) as { data?: { items?: unknown[] } };
    const n = chats.data?.items?.length ?? 0;
    results.push({
      name: "Lark  live",
      status: "ok",
      detail: `tenant token OK · bot in ${n} chat(s) (im:message.group_msg verified by pnpm collect-lark)`,
    });
  } catch (err) {
    results.push({ name: "Lark  live", status: "fail", detail: err instanceof Error ? err.message : String(err) });
  }

  let typefully: ReturnType<typeof loadTypefullyConfig> | undefined;
  try {
    typefully = loadTypefullyConfig();
  } catch {
    // TYPEFULLY_* not set — the offline check above already reported it as a warn.
  }
  if (typefully) {
    const t = typefully;
    try {
      // Two calls on purpose: /me proves the key, the social set proves the id and carries the quota.
      // Reporting "quota unreadable" for what is really a bad key would send the operator the wrong way.
      const me = await fetch("https://api.typefully.com/v2/me", { headers: { Authorization: `Bearer ${t.apiKey}` } });
      if (!me.ok) {
        // 401/403 mean the key itself was rejected — anything else (5xx, 429, ...) is Typefully's
        // side failing, and sending the operator to re-check a perfectly good key during an outage
        // is the wrong remedy.
        const detail =
          me.status === 401 || me.status === 403
            ? `GET /v2/me → HTTP ${me.status} — check TYPEFULLY_API_KEY`
            : `GET /v2/me → HTTP ${me.status} — Typefully upstream failure, not necessarily your key`;
        results.push({ name: "Typefully  live", status: "fail", detail });
      } else {
        try {
          results.push(quotaResult("Typefully  live", await new TypefullyQuota(t.apiKey, t.socialSetId).read()));
        } catch (err) {
          results.push({
            name: "Typefully  live",
            status: "fail",
            detail: `key OK, social set unreadable — check TYPEFULLY_SOCIAL_SET_ID (${(err as Error).message})`,
          });
        }
      }
    } catch (err) {
      // fetch() rejects on network-level failures (DNS, connection refused, TLS, timeout) — distinct
      // from an HTTP error status, which is handled above via `!me.ok`. Both must be visible.
      results.push({ name: "Typefully  live", status: "fail", detail: `unreachable — ${(err as Error).message}` });
    }
  }
}

console.log(formatReport(results, { live }));
if (results.some((r) => r.status === "fail")) process.exitCode = 1;
