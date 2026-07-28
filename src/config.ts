import { parseStorageMode, tryParseStorageMode, type StorageMode } from "./storage/mode";
import { X_MAX_WEIGHTED, X_PREMIUM_MAX_WEIGHTED } from "./domain/formatting/weightedLength";
import { ALL_OUTLETS, PRIMARY_OUTLET_BY_CHANNEL } from "./domain/outlet/models";

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

export interface TelegramConfig {
  botToken: string;
  chatId: string;
}
export function loadTelegramConfig(): TelegramConfig {
  const botToken = process.env.TELEGRAM_BOT_TOKEN;
  const chatId = process.env.TELEGRAM_CHAT_ID;
  if (!botToken) throw new Error("Missing required environment variable: TELEGRAM_BOT_TOKEN");
  if (!chatId) throw new Error("Missing required environment variable: TELEGRAM_CHAT_ID");
  return { botToken, chatId };
}

/**
 * Chat id per auto Telegram outlet. Splitting the old single `TELEGRAM_CHAT_ID` would stop sends
 * dead on `git pull`, so the primary room (`tg-community`) still falls back to it, with a warning.
 * A room with no id resolved is simply absent from the map — callers skip it.
 */
export function loadTelegramChatIds(): Record<string, string> {
  const out: Record<string, string> = {};
  const legacy = process.env.TELEGRAM_CHAT_ID;
  for (const outlet of ALL_OUTLETS) {
    if (!outlet.chatIdEnv) continue;
    const own = process.env[outlet.chatIdEnv];
    if (own) {
      out[outlet.id] = own;
      continue;
    }
    if (legacy && outlet.id === PRIMARY_OUTLET_BY_CHANNEL.telegram) {
      out[outlet.id] = legacy;
      console.warn(
        `[config] TELEGRAM_CHAT_ID is deprecated — set ${outlet.chatIdEnv} instead. ` +
          `Using it for ${outlet.label} only; other rooms stay unconfigured.`,
      );
    }
  }
  return out;
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
