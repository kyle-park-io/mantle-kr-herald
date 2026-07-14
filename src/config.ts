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
