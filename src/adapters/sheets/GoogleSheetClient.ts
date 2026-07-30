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

/**
 * Which failures a call may safely be retried on. The distinction is whether a failure tells us the
 * request was **not processed**, or leaves that open.
 *
 * - `ambiguous-ok` — retry 429, 5xx, and network-level throws. Correct for a read, and for an
 *   idempotent overwrite (`updateValues`, `batchUpdateValues`, `ensureTab`): repeating the request
 *   converges on the same state, so a repeat that turns out to have been unnecessary costs nothing.
 *
 * - `definitive-only` — retry **429 alone**. A 429 is a *rejection*: the server refused the request
 *   before processing it, so re-sending cannot double anything. A 5xx or a dropped connection is
 *   **ambiguous** — the request may well have been committed server-side and lost only on the way
 *   back — and `appendValues` is not idempotent, so retrying that ambiguity appends the same rows a
 *   second time.
 *
 * `appendValues` therefore uses `definitive-only` and lets an ambiguous failure propagate. The rows
 * it writes decide KOL payments, and up to 500 of them go in a single call, so one blip after a
 * ~200-row append would otherwise land ~200 duplicate rows while the run still reported a clean
 * summary — visible only on a *later* run, via the keep-first duplicate warning. A thrown error a
 * human re-runs is strictly safer than a silent duplicate in a tab that decides money. It is also
 * not a trade this client used to make: before retry existed an append landed once or threw once,
 * never ambiguously twice, and the same shared client backs `x-performance` (RecordMetrics) and
 * `history` (RecordPublish).
 */
type RetryOn = "ambiguous-ok" | "definitive-only";

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
  private async send(
    label: string,
    url: string,
    init: RequestInit,
    retryOn: RetryOn = "ambiguous-ok",
  ): Promise<Response> {
    let lastStatus = 0;
    let lastError: unknown;

    for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
      let res: Response;
      try {
        res = await this.fetchFn(url, init);
      } catch (err) {
        // Network-level failure (DNS, reset, timeout). Whether the server processed the request
        // before the connection dropped is unknowable from here, so a non-idempotent call must not
        // guess: it surfaces the failure and a human re-runs.
        if (retryOn === "definitive-only") {
          throw new Error(
            `Sheets ${label} failed (network error, not retried: the request is not idempotent and may already have been committed — re-run and check for duplicate rows)`,
            { cause: err },
          );
        }
        lastError = err;
        lastStatus = 0;
        if (attempt < MAX_ATTEMPTS - 1) await backoff(attempt);
        continue;
      }

      // A 429 is retried for every call: it means the request was refused, not processed. A 5xx is
      // retried only where a repeat is harmless, for the same reason as the network throw above —
      // it may have been committed.
      if (res.status === 429 || (retryOn === "ambiguous-ok" && res.status >= 500)) {
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
    // The one non-idempotent call on this client: a repeat adds rows rather than converging.
    await this.send(
      "appendValues",
      url,
      { method: "POST", headers: await this.headers(), body: JSON.stringify({ values: rows }) },
      "definitive-only",
    );
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
