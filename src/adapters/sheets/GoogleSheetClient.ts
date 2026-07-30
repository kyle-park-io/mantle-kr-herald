import type { SheetClient } from "../../ports/SheetClient";

interface TokenSource {
  getToken(): Promise<string>;
}

const BASE = "https://sheets.googleapis.com/v4/spreadsheets";

/**
 * Retry policy, mirroring `src/shared/http/HttpClient.ts` rather than inventing a second one: three
 * attempts, `1000 * 2^attempt` backoff, retrying 429 and 5xx plus network-level failures. A 4xx
 * other than 429 is a request problem and is thrown immediately.
 *
 * This client had no retry at all, which mattered because Sheets allows only 60 write requests per
 * minute per user: a busy run took a 429 and threw, and for `kol-telegram:record` that abandoned the
 * rest of the channel's posts mid-way and left a partial write behind.
 */
const MAX_ATTEMPTS = 3;
const backoff = (attempt: number) => new Promise((resolve) => setTimeout(resolve, 1000 * 2 ** attempt));

export class GoogleSheetClient implements SheetClient {
  constructor(
    private readonly auth: TokenSource,
    private readonly spreadsheetId: string, // "" is fine for createSpreadsheet-only use (sheet:init)
    private readonly fetchFn: typeof fetch = fetch,
  ) {}

  private async headers(): Promise<Record<string, string>> {
    return { Authorization: `Bearer ${await this.auth.getToken()}`, "Content-Type": "application/json" };
  }

  /**
   * One request with retry. `label` names the operation so the thrown message keeps the shape
   * callers already match on (`LoadKolMap` reads `HTTP 400` out of a `getValues` failure to tell an
   * operator the `kol-map` tab does not exist).
   */
  private async send(label: string, url: string, init: RequestInit): Promise<Response> {
    let lastStatus = 0;
    let lastError: unknown;

    for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
      let res: Response;
      try {
        res = await this.fetchFn(url, init);
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

      if (!res.ok) throw new Error(`Sheets ${label} failed: HTTP ${res.status}`);
      return res;
    }

    if (lastError) {
      throw new Error(`Sheets ${label} failed after ${MAX_ATTEMPTS} attempts (network error)`, { cause: lastError });
    }
    throw new Error(`Sheets ${label} failed: HTTP ${lastStatus} (after ${MAX_ATTEMPTS} attempts)`);
  }

  async getValues(range: string): Promise<string[][]> {
    const url = `${BASE}/${this.spreadsheetId}/values/${encodeURIComponent(range)}`;
    const res = await this.send("getValues", url, { method: "GET", headers: await this.headers() });
    const data = (await res.json()) as { values?: string[][] };
    return data.values ?? [];
  }

  async appendValues(range: string, rows: string[][]): Promise<void> {
    const url = `${BASE}/${this.spreadsheetId}/values/${encodeURIComponent(range)}:append?valueInputOption=RAW`;
    await this.send("appendValues", url, {
      method: "POST",
      headers: await this.headers(),
      body: JSON.stringify({ values: rows }),
    });
  }

  async updateValues(range: string, rows: string[][]): Promise<void> {
    const url = `${BASE}/${this.spreadsheetId}/values/${encodeURIComponent(range)}?valueInputOption=RAW`;
    await this.send("updateValues", url, {
      method: "PUT",
      headers: await this.headers(),
      body: JSON.stringify({ values: rows }),
    });
  }

  async batchUpdateValues(updates: { range: string; rows: string[][] }[]): Promise<void> {
    if (updates.length === 0) return; // an empty batch is a no-op, not a wasted request
    const url = `${BASE}/${this.spreadsheetId}/values:batchUpdate`;
    await this.send("batchUpdateValues", url, {
      method: "POST",
      headers: await this.headers(),
      body: JSON.stringify({
        valueInputOption: "RAW",
        data: updates.map((u) => ({ range: u.range, values: u.rows })),
      }),
    });
  }

  async createSpreadsheet(title: string, tabs: { title: string }[]): Promise<{ spreadsheetId: string }> {
    const body = { properties: { title }, sheets: tabs.map((t) => ({ properties: { title: t.title } })) };
    const res = await this.send("createSpreadsheet", BASE, {
      method: "POST",
      headers: await this.headers(),
      body: JSON.stringify(body),
    });
    const data = (await res.json()) as { spreadsheetId?: string };
    if (!data.spreadsheetId) throw new Error("Sheets createSpreadsheet response missing spreadsheetId");
    return { spreadsheetId: data.spreadsheetId };
  }

  async ensureTab(title: string): Promise<void> {
    const metaUrl = `${BASE}/${this.spreadsheetId}?fields=sheets.properties.title`;
    const metaRes = await this.send("get metadata", metaUrl, { method: "GET", headers: await this.headers() });
    const meta = (await metaRes.json()) as { sheets?: { properties?: { title?: string } }[] };
    const exists = (meta.sheets ?? []).some((s) => s.properties?.title === title);
    if (exists) return;
    await this.send("addSheet", `${BASE}/${this.spreadsheetId}:batchUpdate`, {
      method: "POST",
      headers: await this.headers(),
      body: JSON.stringify({ requests: [{ addSheet: { properties: { title } } }] }),
    });
  }
}
