import { describe, it, expect } from "vitest";
import { HttpClient } from "../../../src/shared/http/HttpClient";
import { LarkAuth } from "../../../src/adapters/lark/LarkAuth";
import { LarkClient } from "../../../src/adapters/lark/LarkClient";
import { LarkSourceGateway } from "../../../src/adapters/lark/LarkSourceGateway";

const appId = process.env.LARK_APP_ID;
const appSecret = process.env.LARK_APP_SECRET;
const chatId = (process.env.LARK_CHAT_IDS ?? "").split(",")[0]?.trim();
const baseUrl = process.env.LARK_BASE_URL?.trim() || "https://open.larksuite.com";
const ready = Boolean(appId && appSecret && chatId);

// Skipped unless Lark credentials + a chat id are present (real network + auth).
describe.skipIf(!ready)("PROBE: Lark auth + message list shape", () => {
  it("obtains a token and reads the target chat's message shape", async () => {
    const auth = new LarkAuth(new HttpClient(baseUrl), appId!, appSecret!);
    const token = await auth.getToken();
    expect(token.length).toBeGreaterThan(0);

    const gw = new LarkSourceGateway(new LarkClient(baseUrl, auth));
    let count = 0;
    for await (const m of gw.fetchMessages(chatId!)) {
      count += 1;
      if (count >= 5) break; // cap cost
    }
    // eslint-disable-next-line no-console
    console.log(`[probe] Lark chat ${chatId}: read ${count} text/post message(s)`);
    expect(count).toBeGreaterThanOrEqual(0);
  }, 60000);
});
