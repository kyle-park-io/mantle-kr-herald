import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { buildConsentUrl, exchangeCodeForTokens } from "../adapters/drive/googleOAuthFlow";
import { DRIVE_FILE_SCOPE } from "../adapters/drive/GoogleOAuthAuth";

const clientId = process.env.GOOGLE_OAUTH_CLIENT_ID?.trim();
const clientSecret = process.env.GOOGLE_OAUTH_CLIENT_SECRET?.trim();
if (!clientId || !clientSecret) {
  console.error(
    "Missing GOOGLE_OAUTH_CLIENT_ID / GOOGLE_OAUTH_CLIENT_SECRET.\n" +
      "Create an OAuth client (type: Desktop app) and set both in .env — see docs/guides/google-drive-setup-guide.md.",
  );
  process.exit(1);
}
// Least-privilege by default; override with GOOGLE_OAUTH_SCOPE only if you need broader access.
const scope = process.env.GOOGLE_OAUTH_SCOPE?.trim() || DRIVE_FILE_SCOPE;

// Fixed once the server is listening. The handler must NOT call server.address():
// after server.close() it returns null, which crashed on late requests (e.g. favicon).
let redirectUri = "";
let handled = false;

const server = createServer(async (req, res) => {
  const url = new URL(req.url ?? "/", redirectUri || "http://127.0.0.1");
  const code = url.searchParams.get("code");
  const error = url.searchParams.get("error");

  if (handled || (!code && !error)) {
    res.writeHead(204, { Connection: "close" }).end(); // ignore favicon, retries, and post-completion hits
    return;
  }
  handled = true;

  if (error) {
    res.writeHead(200, { "Content-Type": "text/plain", Connection: "close" }).end(`Authorization failed: ${error}. You can close this tab.`);
    console.error(`Authorization failed: ${error}`);
    server.close(() => process.exit(1));
    return;
  }
  try {
    const { refreshToken } = await exchangeCodeForTokens({
      code: code!,
      clientId,
      clientSecret,
      redirectUri,
    });
    res.writeHead(200, { "Content-Type": "text/plain", Connection: "close" }).end("Authorized. You can close this tab and return to the terminal.");
    console.log("\nSuccess! Add this line to your .env:\n");
    console.log(`GOOGLE_OAUTH_REFRESH_TOKEN=${refreshToken}\n`);
    server.close(() => process.exit(0));
  } catch (e) {
    res.writeHead(200, { "Content-Type": "text/plain", Connection: "close" }).end("Token exchange failed. Check the terminal.");
    console.error(e instanceof Error ? e.message : String(e));
    server.close(() => process.exit(1));
  }
});

server.listen(0, "127.0.0.1", () => {
  const port = (server.address() as AddressInfo).port;
  redirectUri = `http://127.0.0.1:${port}`;
  const consentUrl = buildConsentUrl({ clientId, redirectUri, scope });
  console.log("1. Open this URL in a browser on THIS machine and approve access:\n");
  console.log(consentUrl + "\n");
  console.log(`2. Google will redirect to ${redirectUri}; the refresh token then prints below.`);
  console.log("   Waiting for authorization… (Ctrl-C to cancel)");
});
