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
} from "../config";
import { createGoogleAuth } from "../adapters/drive/createGoogleAuth";
import { LarkAuth } from "../adapters/lark/LarkAuth";
import { HttpClient } from "../shared/http/HttpClient";
import { paths } from "../paths";
import { steeringFiles, missingSteeringFiles, skeletonSteeringFiles } from "../doctor/steering";
import { configCheck, cloudCheck, parseScopes, scopeCheck, accessResult } from "../doctor/checks";
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

// --- config checks (offline) ---
results.push(configCheck("Storage mode", () => loadStorageMode(), `mode: ${process.env.HERALD_STORAGE_MODE?.trim() ?? "(unset)"}`));
// twitterapi.io / Lark app double as source credentials for `collect` / `collect-lark`, which run
// in both modes — so local mode doesn't mean "never needed", just "not needed unless you collect
// from this source".
results.push(
  cloudCheck("twitterapi.io (A)", () => loadConfig(), local, "not needed unless you collect from this source", "TWITTERAPI_IO_KEY set"),
);
results.push(cloudCheck("Lark app (B)", () => loadLarkConfig(), local, "not needed unless you collect from this source"));
// Lark Drive / Google auth / Google Drive / Google Sheet are purely cloud-publish credentials —
// genuinely not needed until you promote to cloud mode.
results.push(cloudCheck("Lark Drive (D)", () => loadLarkDriveConfig(), local, "not needed in local mode"));
results.push(cloudCheck("Google auth", () => loadGoogleAuthConfig(), local, "not needed in local mode", authMode()));
results.push(cloudCheck("Google Drive (D)", () => loadGoogleDriveConfig(), local, "not needed in local mode"));
results.push(cloudCheck("Google Sheet (§9a)", () => loadGoogleSheetConfig(), local, "not needed in local mode"));

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
    try {
      const g = loadGoogleDriveConfig();
      await fileAccess("Google Drive review   live", g.reviewFolderId);
      await fileAccess("Google Drive approved  live", g.approvedFolderId);
    } catch {
      // Drive folders not configured — the offline config check already reported it.
    }
    try {
      const gs = loadGoogleSheetConfig();
      await fileAccess("Google Sheet file  live", gs.spreadsheetId);
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
}

console.log(formatReport(results, { live }));
if (results.some((r) => r.status === "fail")) process.exitCode = 1;
