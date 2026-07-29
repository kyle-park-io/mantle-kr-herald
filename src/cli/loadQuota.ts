import { TypefullyQuota, type PublishingQuota } from "../adapters/send/TypefullyQuota";
import { loadTypefullyConfig } from "../config";
import type { DeliveryLedger } from "../ports/DeliveryLedger";
import { awaitingPublish } from "../domain/send/awaitingPublish";

/** A minute is long enough to spare the smallest rate-limit bucket, short enough to stay true. */
const QUOTA_TTL_MS = 60_000;

export interface QuotaView {
  quota?: PublishingQuota;
  /**
   * Rooms already sent to (a scheduled Typefully draft exists) but not yet confirmed published —
   * the same count `SendChannels` subtracts from `quota.remaining` before it gates a send. The
   * board's banner mirrors that arithmetic so it names the number the gate actually enforces
   * instead of the raw account total.
   */
  inFlight?: number;
  error?: string;
}

/**
 * Builds the board's `loadQuota` — the account-wide Typefully publishing quota, plus the in-flight
 * count that turns it into what the send gate will actually allow.
 *
 * Extracted out of `serve.ts` for the same reason `typefullyQuotaReader.ts` and
 * `reconcileScheduler.ts` were: a closure private to `serve.ts` cannot be unit-tested on its own.
 *
 * "Unknown" and "exhausted" are different states and only one of them means the operator should
 * stop, so a read that fails answers `error` rather than a zero quota — and is never cached, so a
 * transient blip does not blank the banner for a full minute.
 *
 * `inFlight` is recomputed on every call, unlike `quota`: it is a local file read (no API call, no
 * pressure on the 500/hr social-set bucket the caching exists for) and it has to be exact — a
 * minute-old count would let the banner and the gate name two different numbers again, which is
 * the whole defect this extraction exists to fix.
 */
export function makeLoadQuota(
  ledger: DeliveryLedger,
  deps: {
    loadConfig?: () => { apiKey: string; socialSetId: string };
    readQuota?: (apiKey: string, socialSetId: string) => Promise<PublishingQuota>;
    now?: () => number;
    ttlMs?: number;
  } = {},
): () => Promise<QuotaView> {
  const loadConfig = deps.loadConfig ?? loadTypefullyConfig;
  const readQuota = deps.readQuota ?? ((apiKey, socialSetId) => new TypefullyQuota(apiKey, socialSetId).read());
  const now = deps.now ?? Date.now;
  const ttlMs = deps.ttlMs ?? QUOTA_TTL_MS;
  let cache: { at: number; value: PublishingQuota } | undefined;

  return async (): Promise<QuotaView> => {
    const inFlight = (await ledger.loadAll()).filter(awaitingPublish).length;
    if (cache && now() - cache.at < ttlMs) return { quota: cache.value, inFlight };
    try {
      const t = loadConfig();
      const value = await readQuota(t.apiKey, t.socialSetId);
      cache = { at: now(), value };
      return { quota: value, inFlight };
    } catch (err) {
      // Not cached: a transient failure must not blank the banner for a full minute.
      return { error: (err as Error).message, inFlight };
    }
  };
}
