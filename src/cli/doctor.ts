import "./registerErrorHandler";
import { access } from "node:fs/promises";
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
import { configCheck, parseScopes, scopeCheck, accessResult } from "../doctor/checks";
import { formatReport, type CheckResult } from "../doctor/report";

const DRIVE_SCOPE = "https://www.googleapis.com/auth/drive.file";
const SHEETS_SCOPE = "https://www.googleapis.com/auth/spreadsheets";

const live = process.argv.includes("--live");
const results: CheckResult[] = [];

function authMode(): string {
  try {
    return `mode: ${loadGoogleAuthConfig().mode}`;
  } catch {
    return "configured";
  }
}

// --- config checks (offline) ---
results.push(configCheck("Storage mode", () => loadStorageMode(), `mode: ${process.env.HERALD_STORAGE_MODE?.trim() ?? "(unset)"}`));
results.push(configCheck("twitterapi.io (A)", () => loadConfig(), "TWITTERAPI_IO_KEY set"));
results.push(configCheck("Lark app (B)", () => loadLarkConfig()));
results.push(configCheck("Lark Drive (D)", () => loadLarkDriveConfig()));
results.push(configCheck("Google auth", () => loadGoogleAuthConfig(), authMode()));
results.push(configCheck("Google Drive (D)", () => loadGoogleDriveConfig()));
results.push(configCheck("Google Sheet (§9a)", () => loadGoogleSheetConfig()));

const steeringFiles = [
  join(paths.translationConfigDir, "glossary.json"),
  join(paths.translationConfigDir, "style-guide.md"),
  join(paths.translationConfigDir, "locale.json"),
  join(paths.conversionConfigDir, "x.md"),
];
const missingSteeringFiles: string[] = [];
for (const f of steeringFiles) {
  try {
    await access(f);
  } catch {
    missingSteeringFiles.push(f);
  }
}
results.push(
  missingSteeringFiles.length === 0
    ? { name: "Steering config", status: "ok", detail: "translation/ + conversion/ present" }
    : { name: "Steering config", status: "fail", detail: `missing ${missingSteeringFiles.length} file(s) — run pnpm config:init` },
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
