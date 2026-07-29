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
    /**
     * "Absent" and "zero" are different answers, and only one of them should stop a send.
     *
     * `used` is validated here rather than defaulted (`q.used ?? 0`), and that is not symmetry for
     * its own sake. The resend guard (`guardQueuedDraft`) proves "the original published while we
     * were cancelling it" by comparing `used` either side of the cancel; a defaulted `0` makes both
     * sides equal, so the guard reads a publish as "nothing moved", believes it verified, and sends
     * the duplicate it exists to prevent — silently, on a field nobody was watching.
     *
     * Chosen over the alternative of also treating a DROP in `remaining` as proof: that leaves the
     * defaulted field in place and compensates for it downstream, so the guard would carry two
     * comparisons and a reader would have to work out which one fires when. Validating at the edge
     * fixes it where the field enters the system, and an unusable payload then surfaces the way
     * every other unusable payload here does — as a thrown read, which each caller already handles
     * (the guard refuses, the banner shows the error, the send gate logs and proceeds).
     */
    if (!q || typeof q.remaining !== "number" || typeof q.used !== "number") {
      throw new Error("Typefully social-set response carried no usable publishing_quota (used/remaining)");
    }
    return { used: q.used, remaining: q.remaining, resetsAt: q.resets_at ?? "" };
  }
}
