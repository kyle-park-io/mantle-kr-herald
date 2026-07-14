import type { TokenSource } from "./TokenSource";

const TOKEN_URL = "https://oauth2.googleapis.com/token";
const REFRESH_MARGIN_SECONDS = 60;

/** Least-privilege scope: the app manages only files it creates in the user's Drive. */
export const DRIVE_FILE_SCOPE = "https://www.googleapis.com/auth/drive.file";

export interface OAuthClient {
  clientId: string;
  clientSecret: string;
}

/** Google auth for a personal account: exchanges a long-lived refresh token for
 *  short-lived access tokens. Files created are owned by the consenting user
 *  (who has storage quota), unlike a service account. */
export class GoogleOAuthAuth implements TokenSource {
  private token?: string;
  private expiresAt = 0; // ms epoch

  constructor(
    private readonly client: OAuthClient,
    private readonly refreshToken: string,
    private readonly now: () => number = Date.now,
    private readonly fetchFn: typeof fetch = fetch,
  ) {}

  async getToken(force = false): Promise<string> {
    if (!force && this.token && this.now() < this.expiresAt) return this.token;

    const res = await this.fetchFn(TOKEN_URL, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "refresh_token",
        refresh_token: this.refreshToken,
        client_id: this.client.clientId,
        client_secret: this.client.clientSecret,
      }).toString(),
    });
    if (!res.ok) throw new Error(`Google OAuth token refresh failed: HTTP ${res.status}`);
    const body = (await res.json()) as { access_token?: string; expires_in?: number };
    if (!body.access_token) throw new Error("Google OAuth token response missing access_token");

    this.token = body.access_token;
    this.expiresAt = this.now() + Math.max((body.expires_in ?? 3600) - REFRESH_MARGIN_SECONDS, 0) * 1000;
    return this.token;
  }
}
