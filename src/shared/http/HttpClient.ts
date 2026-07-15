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

    const MAX_ATTEMPTS = 3;
    const backoff = (attempt: number) => new Promise((r) => setTimeout(r, 1000 * 2 ** attempt));
    let lastStatus = 0;
    let lastError: unknown;

    for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
      let res: Response;
      try {
        res = await fetch(url.toString(), init);
      } catch (err) {
        // Network-level failure (DNS, reset, timeout) — retry like a 5xx.
        lastError = err;
        lastStatus = 0;
        if (attempt < MAX_ATTEMPTS - 1) await backoff(attempt);
        continue;
      }

      if (res.status === 429 || res.status >= 500) {
        lastStatus = res.status;
        lastError = undefined;
        // Don't sleep after the final attempt — it just delays the throw.
        if (attempt < MAX_ATTEMPTS - 1) await backoff(attempt);
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

    const reason = lastError ? "network error" : `last HTTP ${lastStatus}`;
    throw new Error(
      `Request failed after ${MAX_ATTEMPTS} attempts (${reason}): ${method} ${path}`,
      lastError ? { cause: lastError } : undefined,
    );
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
