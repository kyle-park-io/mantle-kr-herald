import { HttpClient } from "../../shared/http/HttpClient";
import type { IHttpClient } from "../../shared/http/IHttpClient";
import type { LarkAuth } from "./LarkAuth";

// Lark auth-error codes (invalid / expired tenant_access_token).
const AUTH_ERROR_CODES = new Set([99991661, 99991663, 99991664]);

type HttpFactory = (baseUrl: string, headers: Record<string, string>) => IHttpClient;

const defaultFactory: HttpFactory = (baseUrl, headers) => new HttpClient(baseUrl, headers);

export class LarkClient {
  constructor(
    private readonly baseUrl: string,
    private readonly auth: LarkAuth,
    private readonly makeHttp: HttpFactory = defaultFactory,
  ) {}

  async get<T>(path: string, params?: Record<string, string>): Promise<T> {
    let token = await this.auth.getToken();
    let res = await this.call<T>(path, params, token);
    if (this.isAuthError(res)) {
      token = await this.auth.getToken(true);
      res = await this.call<T>(path, params, token);
    }
    return res;
  }

  private call<T>(path: string, params: Record<string, string> | undefined, token: string): Promise<T> {
    const http = this.makeHttp(this.baseUrl, { Authorization: `Bearer ${token}` });
    return http.get<T>(path, params);
  }

  private isAuthError(res: unknown): boolean {
    const code = (res as { code?: number })?.code;
    return typeof code === "number" && AUTH_ERROR_CODES.has(code);
  }
}
