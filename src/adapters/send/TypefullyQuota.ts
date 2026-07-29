import { createTypefullyFetch, type TypefullyFetch } from "./typefullyFetch";

const API = "https://api.typefully.com/v2";

export interface PublishingQuota {
  used: number;
  remaining: number;
  /** ISO-8601 with offset, e.g. `2026-08-01T00:00:00+09:00`. Empty when the API omits it. */
  resetsAt: string;
}

/**
 * The social set's monthly publishing quota — the real ceiling on X delivery.
 *
 * Not to be confused with the hourly rate limits, which are orders of magnitude looser than
 * anything this pipeline does (5000/hr on `/me`, 2500/hr on drafts, 500/hr here). The quota is
 * fifteen published posts a month on the current plan, resetting on the 1st.
 */
export class TypefullyQuota {
  private readonly http: TypefullyFetch;
  constructor(
    private readonly apiKey: string,
    private readonly socialSetId: string,
    fetchFn: typeof fetch = fetch,
    sleep: (ms: number) => Promise<void> = (ms) => new Promise((r) => setTimeout(r, ms)),
  ) {
    this.http = createTypefullyFetch(fetchFn, sleep);
  }

  async read(): Promise<PublishingQuota> {
    // The trailing slash is required. Without it the API answers 301 with an empty body — which
    // would parse as a quota of nothing and block every X send. Confirmed live 2026-07-29.
    const res = await this.http(`${API}/social-sets/${this.socialSetId}/`, {
      headers: { Authorization: `Bearer ${this.apiKey}` },
    });
    if (!res.ok) throw new Error(`Typefully social-set read failed: HTTP ${res.status}`);
    const body = (await res.json()) as {
      publishing_quota?: { used?: number; remaining?: number; resets_at?: string };
    };
    const q = body.publishing_quota;
    // "Absent" and "zero" are different answers, and only one of them should stop a send.
    if (!q || typeof q.remaining !== "number") {
      throw new Error("Typefully social-set response carried no publishing_quota");
    }
    return { used: q.used ?? 0, remaining: q.remaining, resetsAt: q.resets_at ?? "" };
  }
}
