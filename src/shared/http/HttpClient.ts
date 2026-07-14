import type { IHttpClient } from "./IHttpClient";

export class HttpClient implements IHttpClient {
  constructor(
    private readonly baseUrl: string,
    private readonly defaultHeaders: Record<string, string> = {},
  ) {}

  private async request<T>(
    method: string,
    path: string,
    options: { params?: Record<string, string>; body?: unknown } = {},
  ): Promise<T> {
    const url = new URL(`${this.baseUrl}${path}`);
    if (options.params) {
      for (const [k, v] of Object.entries(options.params)) {
        if (v !== undefined && v !== "") url.searchParams.set(k, v);
      }
    }

    const headers: Record<string, string> = {
      "Content-Type": "application/json",
      ...this.defaultHeaders,
    };

    const init: RequestInit = { method, headers };
    if (options.body !== undefined) init.body = JSON.stringify(options.body);

    for (let attempt = 0; attempt < 3; attempt++) {
      const res = await fetch(url.toString(), init);

      if (res.status === 429 || res.status >= 500) {
        await new Promise((r) => setTimeout(r, 1000 * 2 ** attempt));
        continue;
      }

      if (!res.ok) {
        let detail = res.statusText;
        try {
          const body = (await res.json()) as Record<string, unknown>;
          if (typeof body["detail"] === "string") detail = body["detail"];
          else if (typeof body["msg"] === "string") detail = body["msg"];
        } catch {
          // ignore parse error
        }
        if (res.status === 401) throw new Error(`HTTP 401: unauthorized — ${detail}`);
        if (res.status === 402) throw new Error(`HTTP 402: payment required — ${detail}`);
        throw new Error(`HTTP ${res.status}: ${detail}`);
      }

      return res.json() as Promise<T>;
    }

    throw new Error(`Request failed after 3 attempts: ${method} ${path}`);
  }

  get<T>(path: string, params?: Record<string, string>): Promise<T> {
    return this.request<T>("GET", path, { params });
  }
  post<T>(path: string, body?: unknown): Promise<T> {
    return this.request<T>("POST", path, { body });
  }
  patch<T>(path: string, body?: unknown): Promise<T> {
    return this.request<T>("PATCH", path, { body });
  }
  delete<T>(path: string, body?: unknown): Promise<T> {
    return this.request<T>("DELETE", path, { body });
  }
}
