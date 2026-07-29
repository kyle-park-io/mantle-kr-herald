import { parseStorageMode, tryParseStorageMode, type StorageMode } from "./storage/mode";
import { X_MAX_WEIGHTED, X_PREMIUM_MAX_WEIGHTED } from "./domain/formatting/weightedLength";
import { ALL_OUTLETS } from "./domain/outlet/models";

export interface Config {
  apiKey: string;
}

export function loadConfig(): Config {
  const apiKey = process.env.TWITTERAPI_IO_KEY;
  if (!apiKey) {
    throw new Error("Missing required environment variable: TWITTERAPI_IO_KEY");
  }
  return { apiKey };
}

export interface LarkAppConfig {
  appId: string;
  appSecret: string;
  baseUrl: string;
}

export interface LarkConfig extends LarkAppConfig {
  chatIds: string[];
}

/** App credentials + base URL only (no chat ids) — for commands that discover or take an explicit chat. */
export function loadLarkAppConfig(): LarkAppConfig {
  const appId = process.env.LARK_APP_ID;
  const appSecret = process.env.LARK_APP_SECRET;
  if (!appId) throw new Error("Missing required environment variable: LARK_APP_ID");
  if (!appSecret) throw new Error("Missing required environment variable: LARK_APP_SECRET");
  const baseUrl = process.env.LARK_BASE_URL?.trim() || "https://open.larksuite.com";
  return { appId, appSecret, baseUrl };
}

export function loadLarkConfig(): LarkConfig {
  const app = loadLarkAppConfig();
  const chatIds = (process.env.LARK_CHAT_IDS ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
  if (chatIds.length === 0) {
    throw new Error("Missing required environment variable: LARK_CHAT_IDS (comma-separated chat_id list)");
  }
  return { ...app, chatIds };
}

export interface GoogleDriveConfig {
  reviewFolderId: string;
  approvedFolderId: string;
  sentFolderId?: string;
}

export function loadGoogleDriveConfig(): GoogleDriveConfig {
  const reviewFolderId = process.env.GDRIVE_REVIEW_FOLDER_ID;
  const approvedFolderId = process.env.GDRIVE_APPROVED_FOLDER_ID;
  if (!reviewFolderId) throw new Error("Missing required environment variable: GDRIVE_REVIEW_FOLDER_ID");
  if (!approvedFolderId) throw new Error("Missing required environment variable: GDRIVE_APPROVED_FOLDER_ID");
  return { reviewFolderId, approvedFolderId, sentFolderId: process.env.GDRIVE_SENT_FOLDER_ID?.trim() || undefined };
}

export interface GoogleDriveInitConfig {
  shareEmails: string[];
  parentFolderName: string;
}

export function loadGoogleDriveInitConfig(): GoogleDriveInitConfig {
  const shareEmails = (process.env.GDRIVE_SHARE_EMAILS ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
  const parentFolderName = process.env.GDRIVE_PARENT_FOLDER_NAME?.trim() || "Mantle KR Herald";
  return { shareEmails, parentFolderName };
}

export type GoogleAuthConfig =
  | { mode: "service_account"; saKeyFile: string }
  | { mode: "oauth"; clientId: string; clientSecret: string; refreshToken: string };

// Selection: explicit GOOGLE_AUTH_MODE wins; otherwise infer (refresh token → oauth, else SA key → service_account).
export function loadGoogleAuthConfig(): GoogleAuthConfig {
  const explicit = process.env.GOOGLE_AUTH_MODE?.trim();
  if (explicit && explicit !== "oauth" && explicit !== "service_account") {
    throw new Error(`Invalid GOOGLE_AUTH_MODE: ${explicit} (expected "oauth" or "service_account")`);
  }
  const refreshToken = process.env.GOOGLE_OAUTH_REFRESH_TOKEN?.trim();
  const saKeyFile = process.env.GOOGLE_SA_KEY_FILE?.trim();
  const mode = explicit || (refreshToken ? "oauth" : saKeyFile ? "service_account" : "");
  if (mode === "oauth") {
    const clientId = process.env.GOOGLE_OAUTH_CLIENT_ID?.trim();
    const clientSecret = process.env.GOOGLE_OAUTH_CLIENT_SECRET?.trim();
    if (!clientId) throw new Error("Missing required environment variable: GOOGLE_OAUTH_CLIENT_ID");
    if (!clientSecret) throw new Error("Missing required environment variable: GOOGLE_OAUTH_CLIENT_SECRET");
    if (!refreshToken) throw new Error("Missing required environment variable: GOOGLE_OAUTH_REFRESH_TOKEN");
    return { mode, clientId, clientSecret, refreshToken };
  }
  if (mode === "service_account") {
    if (!saKeyFile) throw new Error("Missing required environment variable: GOOGLE_SA_KEY_FILE");
    return { mode, saKeyFile };
  }
  throw new Error("No Google auth configured: set GOOGLE_OAUTH_REFRESH_TOKEN (OAuth) or GOOGLE_SA_KEY_FILE (service account).");
}

export interface LarkDriveConfig {
  appId: string;
  appSecret: string;
  baseUrl: string;
  reviewFolderToken: string;
  approvedFolderToken: string;
  sentFolderToken?: string;
  /** Lark workspace (tenant) origin, e.g. https://<tenant>.larksuite.com — for building
   *  "open in Lark" folder/file links in the review dashboard. Undefined = no Lark links. */
  workspaceUrl?: string;
}

export function loadLarkDriveConfig(): LarkDriveConfig {
  const appId = process.env.LARK_APP_ID;
  const appSecret = process.env.LARK_APP_SECRET;
  if (!appId) throw new Error("Missing required environment variable: LARK_APP_ID");
  if (!appSecret) throw new Error("Missing required environment variable: LARK_APP_SECRET");
  const reviewFolderToken = process.env.LARK_DRIVE_REVIEW_FOLDER_TOKEN;
  const approvedFolderToken = process.env.LARK_DRIVE_APPROVED_FOLDER_TOKEN;
  if (!reviewFolderToken) throw new Error("Missing required environment variable: LARK_DRIVE_REVIEW_FOLDER_TOKEN");
  if (!approvedFolderToken) throw new Error("Missing required environment variable: LARK_DRIVE_APPROVED_FOLDER_TOKEN");
  const baseUrl = process.env.LARK_BASE_URL?.trim() || "https://open.larksuite.com";
  return {
    appId,
    appSecret,
    baseUrl,
    reviewFolderToken,
    approvedFolderToken,
    sentFolderToken: process.env.LARK_DRIVE_SENT_FOLDER_TOKEN?.trim() || undefined,
    workspaceUrl: process.env.LARK_WORKSPACE_URL?.trim()?.replace(/\/+$/, "") || undefined,
  };
}

export interface GoogleSheetConfig {
  spreadsheetId: string;
}

export function loadGoogleSheetConfig(): GoogleSheetConfig {
  const spreadsheetId = process.env.GSHEET_ID?.trim();
  if (!spreadsheetId) throw new Error("Missing required environment variable: GSHEET_ID");
  return { spreadsheetId };
}

/**
 * The workbooks the dashboard header links to: the data hub and, optionally, the hand-kept QA
 * workbook. Ids rather than URLs in `.env`, so they read the same as `GSHEET_ID` and cannot drift
 * from the format `sheet:init` prints; the URL is built here, in one place.
 *
 * Never throws — a missing id hides its link rather than taking the whole dashboard down over a
 * convenience feature.
 */
export interface SheetLink {
  url: string;
  /** The workbook's own title, so the header names the sheet rather than saying "시트". */
  title: string;
}

export function loadSheetLinks(): { data?: SheetLink; qa?: SheetLink } {
  const link = (id: string | undefined, fallback: string): SheetLink | undefined =>
    id?.trim() ? { url: `https://docs.google.com/spreadsheets/d/${id.trim()}/edit`, title: fallback } : undefined;
  // Titles are filled in by `resolveSheetTitles` once the API answers; these stand in until then,
  // and stay if it never does — a header link is not worth failing the dashboard over.
  return { data: link(process.env.GSHEET_ID, "데이터 시트"), qa: link(process.env.GSHEET_QA_ID, "QA 시트") };
}

export interface TelegramConfig {
  botToken: string;
}
export function loadTelegramConfig(): TelegramConfig {
  const botToken = process.env.TELEGRAM_BOT_TOKEN;
  if (!botToken) throw new Error("Missing required environment variable: TELEGRAM_BOT_TOKEN");
  return { botToken };
}

/**
 * Chat id per auto Telegram outlet, from that outlet's own `chatIdEnv`. A room with no id set is
 * simply absent from the map — callers skip it and name the missing variable.
 *
 * There is no single-room fallback: every send addresses one room, so a config that cannot name the
 * room has nothing to fall back *to*. The one that used to exist pointed at 맨틀 한국 커뮤니티, which
 * meant a half-migrated `.env` silently sent 데브방's copy to the community room.
 */
export function loadTelegramChatIds(): Record<string, string> {
  const out: Record<string, string> = {};
  for (const outlet of ALL_OUTLETS) {
    if (!outlet.chatIdEnv) continue;
    const own = process.env[outlet.chatIdEnv];
    if (own) out[outlet.id] = own;
  }
  return out;
}

export interface AuthConfig {
  username: string;
  /** A `scrypt$...` encoding produced by `pnpm auth:hash` — never the password itself. */
  passwordHash: string;
}

/**
 * The dashboard's one account, or `undefined` when it is not configured.
 *
 * Deliberately a `try` loader with no throwing counterpart: the dashboard predates having any
 * credential and still runs bound to loopback without one, so requiring the pair would stop every
 * existing install at startup. An unconfigured server serves as before and refuses every login.
 */
export function tryLoadAuthConfig(): AuthConfig | undefined {
  const username = process.env.HERALD_AUTH_USERNAME?.trim();
  const passwordHash = process.env.HERALD_AUTH_PASSWORD_HASH?.trim();
  if (!username || !passwordHash) return undefined;
  return { username, passwordHash };
}

export interface TypefullyConfig {
  apiKey: string;
  socialSetId: string;
}
export function loadTypefullyConfig(): TypefullyConfig {
  const apiKey = process.env.TYPEFULLY_API_KEY;
  const socialSetId = process.env.TYPEFULLY_SOCIAL_SET_ID;
  if (!apiKey) throw new Error("Missing required environment variable: TYPEFULLY_API_KEY");
  if (!socialSetId) throw new Error("Missing required environment variable: TYPEFULLY_SOCIAL_SET_ID");
  return { apiKey, socialSetId };
}

export function loadGoogleConfigFolder(): string | undefined {
  return process.env.GDRIVE_CONFIG_FOLDER_ID?.trim() || undefined;
}

/** Folder for `state:push`/`state:pull` snapshots. Separate from the steering-config folder on
 *  purpose: that one is shared with the team, and this one holds a record of what this machine has
 *  already sent. Auto-provisioned by the first `state:push`. */
export function loadGoogleStateFolder(): string | undefined {
  return process.env.GDRIVE_STATE_FOLDER_ID?.trim() || undefined;
}

export type { StorageMode };

export function loadStorageMode(): StorageMode {
  return parseStorageMode(process.env.HERALD_STORAGE_MODE);
}

export function tryLoadStorageMode(): StorageMode | undefined {
  return tryParseStorageMode(process.env.HERALD_STORAGE_MODE);
}

/** The x-channel weighted limit for this run: X Premium (25,000) when X_PREMIUM=true, else the
 *  standard 280. One flag for the whole pipeline — it serves a single brand account. */
export function loadXMaxWeighted(): number {
  return process.env.X_PREMIUM?.trim() === "true" ? X_PREMIUM_MAX_WEIGHTED : X_MAX_WEIGHTED;
}

export interface DbConfig {
  url: string;
  env: "production" | "development";
}

const DB_ENV_VALUES = ["production", "development"] as const;

/**
 * Never inferred from which credentials happen to be present: a `DATABASE_URL` looks the same
 * whether it points at a laptop's scratch database or the team's shared one, so guessing from the
 * URL — or defaulting when `HERALD_DB_ENV` is unset — is the one failure this must not allow. A
 * wrong guess either strands a day of approvals in a database nobody reads, or puts a local
 * experiment on the team's live board.
 */
const DB_REMEDY = "Add DATABASE_URL and HERALD_DB_ENV=development (or \"production\") to .env.";

export function loadDbConfig(): DbConfig {
  const url = process.env.DATABASE_URL?.trim();
  if (!url) {
    throw new Error(`Missing required environment variable: DATABASE_URL. ${DB_REMEDY}`);
  }
  const env = process.env.HERALD_DB_ENV?.trim();
  if (!env) {
    throw new Error(`Missing required environment variable: HERALD_DB_ENV. ${DB_REMEDY}`);
  }
  if (!DB_ENV_VALUES.includes(env as (typeof DB_ENV_VALUES)[number])) {
    throw new Error(
      `Invalid HERALD_DB_ENV: ${env} (expected "production" or "development"). ${DB_REMEDY}`,
    );
  }
  return { url, env: env as "production" | "development" };
}

/** `"host[:port]/dbname"` — never the credentials embedded in `DATABASE_URL`. Shared by `doctor`
 *  and `status` so the two can never print the target two different ways. */
export function describeDbTarget(cfg: DbConfig): string {
  const url = new URL(cfg.url);
  const database = url.pathname.replace(/^\//, "");
  return `${url.hostname}${url.port ? `:${url.port}` : ""}/${database}`;
}
