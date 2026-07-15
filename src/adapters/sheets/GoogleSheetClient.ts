import type { SheetClient } from "../../ports/SheetClient";

interface TokenSource {
  getToken(): Promise<string>;
}

const BASE = "https://sheets.googleapis.com/v4/spreadsheets";

export class GoogleSheetClient implements SheetClient {
  constructor(
    private readonly auth: TokenSource,
    private readonly spreadsheetId: string, // "" is fine for createSpreadsheet-only use (sheet:init)
    private readonly fetchFn: typeof fetch = fetch,
  ) {}

  private async headers(): Promise<Record<string, string>> {
    return { Authorization: `Bearer ${await this.auth.getToken()}`, "Content-Type": "application/json" };
  }

  async getValues(range: string): Promise<string[][]> {
    const url = `${BASE}/${this.spreadsheetId}/values/${encodeURIComponent(range)}`;
    const res = await this.fetchFn(url, { method: "GET", headers: await this.headers() });
    if (!res.ok) throw new Error(`Sheets getValues failed: HTTP ${res.status}`);
    const data = (await res.json()) as { values?: string[][] };
    return data.values ?? [];
  }

  async appendValues(range: string, rows: string[][]): Promise<void> {
    const url = `${BASE}/${this.spreadsheetId}/values/${encodeURIComponent(range)}:append?valueInputOption=RAW`;
    const res = await this.fetchFn(url, { method: "POST", headers: await this.headers(), body: JSON.stringify({ values: rows }) });
    if (!res.ok) throw new Error(`Sheets appendValues failed: HTTP ${res.status}`);
  }

  async updateValues(range: string, rows: string[][]): Promise<void> {
    const url = `${BASE}/${this.spreadsheetId}/values/${encodeURIComponent(range)}?valueInputOption=RAW`;
    const res = await this.fetchFn(url, { method: "PUT", headers: await this.headers(), body: JSON.stringify({ values: rows }) });
    if (!res.ok) throw new Error(`Sheets updateValues failed: HTTP ${res.status}`);
  }

  async createSpreadsheet(title: string, tabs: { title: string }[]): Promise<{ spreadsheetId: string }> {
    const body = { properties: { title }, sheets: tabs.map((t) => ({ properties: { title: t.title } })) };
    const res = await this.fetchFn(BASE, { method: "POST", headers: await this.headers(), body: JSON.stringify(body) });
    if (!res.ok) throw new Error(`Sheets createSpreadsheet failed: HTTP ${res.status}`);
    const data = (await res.json()) as { spreadsheetId?: string };
    if (!data.spreadsheetId) throw new Error("Sheets createSpreadsheet response missing spreadsheetId");
    return { spreadsheetId: data.spreadsheetId };
  }
}
