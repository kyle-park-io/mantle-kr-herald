import { readFile } from "node:fs/promises";
import { createSign } from "node:crypto";

interface ServiceAccountKey {
  client_email: string;
  private_key: string;
}

const TOKEN_URL = "https://oauth2.googleapis.com/token";
const SCOPE = "https://www.googleapis.com/auth/drive.file";
const REFRESH_MARGIN_SECONDS = 60;

function base64url(input: string | Buffer): string {
  return Buffer.from(input)
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}

export class GoogleAuth {
  private token?: string;
  private expiresAt = 0; // ms epoch

  constructor(
    private readonly key: ServiceAccountKey,
    private readonly now: () => number = Date.now,
    private readonly fetchFn: typeof fetch = fetch,
  ) {}

  static async fromKeyFile(path: string): Promise<GoogleAuth> {
    const raw = JSON.parse(await readFile(path, "utf8")) as ServiceAccountKey;
    if (!raw.client_email || !raw.private_key) {
      throw new Error(`Invalid Google service account key file: ${path}`);
    }
    return new GoogleAuth(raw);
  }

  async getToken(force = false): Promise<string> {
    if (!force && this.token && this.now() < this.expiresAt) return this.token;

    const iat = Math.floor(this.now() / 1000);
    const header = base64url(JSON.stringify({ alg: "RS256", typ: "JWT" }));
    const claim = base64url(
      JSON.stringify({ iss: this.key.client_email, scope: SCOPE, aud: TOKEN_URL, iat, exp: iat + 3600 }),
    );
    const signingInput = `${header}.${claim}`;
    const signature = base64url(createSign("RSA-SHA256").update(signingInput).sign(this.key.private_key));
    const assertion = `${signingInput}.${signature}`;

    const res = await this.fetchFn(TOKEN_URL, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer",
        assertion,
      }).toString(),
    });
    if (!res.ok) throw new Error(`Google token request failed: HTTP ${res.status}`);
    const body = (await res.json()) as { access_token?: string; expires_in?: number };
    if (!body.access_token) throw new Error("Google token response missing access_token");

    this.token = body.access_token;
    this.expiresAt = this.now() + Math.max((body.expires_in ?? 3600) - REFRESH_MARGIN_SECONDS, 0) * 1000;
    return this.token;
  }
}
