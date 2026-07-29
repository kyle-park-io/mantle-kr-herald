import { TypefullyQuota, type PublishingQuota } from "../adapters/send/TypefullyQuota";
import { loadTypefullyConfig } from "../config";
import type { DeliveryLedger } from "../ports/DeliveryLedger";
import type { SendableChannel } from "../domain/send/channels";
import { awaitingPublish, awaitingArticlePublish } from "../domain/send/awaitingPublish";

/** A minute is long enough to spare the smallest rate-limit bucket, short enough to stay true. */
const QUOTA_TTL_MS = 60_000;

/** The subset of `JsonXArticleLedger` this module reads — any ledger shaped like it will do. */
interface ArticleLedger {
  loadAll(): Promise<{ postId?: string; url?: string }[]>;
}

interface ReadHeadroomDeps {
  loadConfig?: () => { apiKey: string; socialSetId: string };
  readQuota?: (apiKey: string, socialSetId: string) => Promise<PublishingQuota>;
  now?: () => number;
  ttlMs?: number;
}

export interface Headroom {
  /** The account's raw remaining publishes, for display. */
  remaining: number;
  /** Publishes already spent — the banner's denominator is `used + remaining`. */
  used: number;
  /** Scheduled but unconfirmed sends, across BOTH ledgers (x-post rooms and x-article). */
  inFlight: number;
  /**
   * `remaining − inFlight`. Deliberately NOT clamped at zero: a stale in-flight row can overcount and
   * drive this negative, and clamping here would silently turn "we are over-committed" into "we are
   * exactly at zero" for the gate that compares against it. Callers clamp only when they *display*
   * the number.
   */
  available: number;
  resetsAt: string;
}

export interface HeadroomView {
  headroom?: Headroom;
  error?: string;
}

/**
 * Builds the reader the send gate (`SendChannels`) and the board's banner both read "how much
 * headroom is left" from — one module, one arithmetic, so the two can never name two different
 * numbers. `makeLoadHeadroom` below wraps this same function for the board's always-200 contract, and
 * `headroomReader` wraps it for the gate's opt-in construction.
 *
 * "Unknown" and "exhausted" are different states, and only one of them means the operator should
 * stop — so a failed read THROWS rather than answering a zero headroom. The caller decides what that
 * means: the gate's own `catch` logs and sends anyway, `makeLoadHeadroom` turns it into `{ error }`.
 * Either way the failure is never cached: a transient blip must not blank the banner, or wrongly
 * refuse a send, for a full minute the way a real quota read would.
 *
 * `inFlight` is recomputed on every call, unlike the Typefully quota itself: it is two local file
 * reads (no API call, no pressure on the 500/hr social-set bucket the caching exists for), and it has
 * to be exact — a minute-old count would let the banner and the gate name two different numbers
 * again, which is the whole defect this module exists to fix.
 */
export function makeReadHeadroom(
  deliveryLedger: DeliveryLedger,
  articleLedger: ArticleLedger,
  deps: ReadHeadroomDeps = {},
): () => Promise<Headroom> {
  const loadConfig = deps.loadConfig ?? loadTypefullyConfig;
  const readQuota = deps.readQuota ?? ((apiKey, socialSetId) => new TypefullyQuota(apiKey, socialSetId).read());
  const now = deps.now ?? Date.now;
  const ttlMs = deps.ttlMs ?? QUOTA_TTL_MS;
  let cache: { at: number; value: PublishingQuota } | undefined;

  return async (): Promise<Headroom> => {
    const [deliveryRows, articleRows] = await Promise.all([deliveryLedger.loadAll(), articleLedger.loadAll()]);
    const inFlight = deliveryRows.filter(awaitingPublish).length + articleRows.filter(awaitingArticlePublish).length;

    let quota: PublishingQuota;
    if (cache && now() - cache.at < ttlMs) {
      quota = cache.value;
    } else {
      const t = loadConfig();
      quota = await readQuota(t.apiKey, t.socialSetId);
      cache = { at: now(), value: quota }; // only reached on success — a failure must never be cached
    }

    return { remaining: quota.remaining, used: quota.used, inFlight, available: quota.remaining - inFlight, resetsAt: quota.resetsAt };
  };
}

/**
 * The board's `loadQuota` dependency: the same headroom, wrapped so a failed read answers
 * `{ error }` instead of throwing. The board's route always answers HTTP 200 — an unreadable
 * headroom is information for the banner, not a client error — so this never throws; a missing
 * `headroom` means "show nothing". Never caches the failure, for the same reason `makeReadHeadroom`
 * doesn't: a transient blip must not blank the banner for a full minute.
 */
export function makeLoadHeadroom(
  deliveryLedger: DeliveryLedger,
  articleLedger: ArticleLedger,
  deps: ReadHeadroomDeps = {},
): () => Promise<HeadroomView> {
  const readHeadroom = makeReadHeadroom(deliveryLedger, articleLedger, deps);
  return async (): Promise<HeadroomView> => {
    try {
      return { headroom: await readHeadroom() };
    } catch (err) {
      return { error: (err as Error).message };
    }
  };
}

/**
 * The headroom reader `SendChannels` gates X sends with — or `undefined` when there is nothing to
 * gate.
 *
 * Mirrors how `createSenders` only builds the senders it was asked for: a Telegram-only install has
 * no Typefully credentials and must not fail to start over a guard it does not need.
 */
export function headroomReader(
  targets: SendableChannel[],
  deliveryLedger: DeliveryLedger,
  articleLedger: ArticleLedger,
): (() => Promise<Headroom>) | undefined {
  if (!targets.includes("x")) return undefined;
  try {
    loadTypefullyConfig();
  } catch {
    // Unconfigured — `createSenders` will not build an X sender either, so there is no send to gate.
    return undefined;
  }
  return makeReadHeadroom(deliveryLedger, articleLedger);
}
