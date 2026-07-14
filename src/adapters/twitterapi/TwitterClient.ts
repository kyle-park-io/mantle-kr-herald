import { HttpClient } from "../../shared/http/HttpClient";
import type { IHttpClient } from "../../shared/http/IHttpClient";

const BASE_URL = "https://api.twitterapi.io";

export class TwitterClient implements IHttpClient {
  private readonly client: HttpClient;

  constructor(apiKey: string) {
    this.client = new HttpClient(BASE_URL, { "x-api-key": apiKey });
  }

  get<T>(path: string, params?: Record<string, string>): Promise<T> {
    return this.client.get<T>(path, params);
  }
  post<T>(path: string, body?: unknown): Promise<T> {
    return this.client.post<T>(path, body);
  }
  patch<T>(path: string, body?: unknown): Promise<T> {
    return this.client.patch<T>(path, body);
  }
  delete<T>(path: string, body?: unknown): Promise<T> {
    return this.client.delete<T>(path, body);
  }
}
