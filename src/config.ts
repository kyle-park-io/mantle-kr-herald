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

export interface LarkConfig {
  appId: string;
  appSecret: string;
  baseUrl: string;
  chatIds: string[];
}

export function loadLarkConfig(): LarkConfig {
  const appId = process.env.LARK_APP_ID;
  const appSecret = process.env.LARK_APP_SECRET;
  if (!appId) throw new Error("Missing required environment variable: LARK_APP_ID");
  if (!appSecret) throw new Error("Missing required environment variable: LARK_APP_SECRET");

  const chatIds = (process.env.LARK_CHAT_IDS ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
  if (chatIds.length === 0) {
    throw new Error("Missing required environment variable: LARK_CHAT_IDS (comma-separated chat_id list)");
  }

  const baseUrl = process.env.LARK_BASE_URL?.trim() || "https://open.larksuite.com";
  return { appId, appSecret, baseUrl, chatIds };
}

export interface GoogleDriveConfig {
  saKeyFile: string;
  reviewFolderId: string;
  approvedFolderId: string;
}

export function loadGoogleDriveConfig(): GoogleDriveConfig {
  const saKeyFile = process.env.GOOGLE_SA_KEY_FILE;
  const reviewFolderId = process.env.GDRIVE_REVIEW_FOLDER_ID;
  const approvedFolderId = process.env.GDRIVE_APPROVED_FOLDER_ID;
  if (!saKeyFile) throw new Error("Missing required environment variable: GOOGLE_SA_KEY_FILE");
  if (!reviewFolderId) throw new Error("Missing required environment variable: GDRIVE_REVIEW_FOLDER_ID");
  if (!approvedFolderId) throw new Error("Missing required environment variable: GDRIVE_APPROVED_FOLDER_ID");
  return { saKeyFile, reviewFolderId, approvedFolderId };
}

export interface GoogleDriveInitConfig {
  saKeyFile: string;
  shareEmails: string[];
  parentFolderName: string;
}

export function loadGoogleDriveInitConfig(): GoogleDriveInitConfig {
  const saKeyFile = process.env.GOOGLE_SA_KEY_FILE;
  if (!saKeyFile) throw new Error("Missing required environment variable: GOOGLE_SA_KEY_FILE");
  const shareEmails = (process.env.GDRIVE_SHARE_EMAILS ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
  const parentFolderName = process.env.GDRIVE_PARENT_FOLDER_NAME?.trim() || "Mantle KR Herald";
  return { saKeyFile, shareEmails, parentFolderName };
}

export interface LarkDriveConfig {
  appId: string;
  appSecret: string;
  baseUrl: string;
  reviewFolderToken: string;
  approvedFolderToken: string;
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
  return { appId, appSecret, baseUrl, reviewFolderToken, approvedFolderToken };
}
