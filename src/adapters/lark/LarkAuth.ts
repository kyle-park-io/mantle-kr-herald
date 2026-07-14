import type { IHttpClient } from "../../shared/http/IHttpClient";

interface TokenResponse {
  code: number;
  msg?: string;
  tenant_access_token?: string;
  expire?: number; // seconds, <= 7200
}

const REFRESH_MARGIN_SECONDS = 60;

export class LarkAuth {
  private token?: string;
  private expiresAt = 0; // ms epoch

  constructor(
    private readonly http: IHttpClient,
    private readonly appId: string,
    private readonly appSecret: string,
    private readonly now: () => number = Date.now,
  ) {}

  async getToken(force = false): Promise<string> {
    if (!force && this.token && this.now() < this.expiresAt) return this.token;

    const res = await this.http.post<TokenResponse>(
      "/open-apis/auth/v3/tenant_access_token/internal",
      { app_id: this.appId, app_secret: this.appSecret },
    );
    if (res.code !== 0 || !res.tenant_access_token) {
      throw new Error(`Lark auth failed: code=${res.code} ${res.msg ?? ""}`.trim());
    }

    this.token = res.tenant_access_token;
    const ttl = (res.expire ?? 7200) - REFRESH_MARGIN_SECONDS;
    this.expiresAt = this.now() + Math.max(ttl, 0) * 1000;
    return this.token;
  }
}
