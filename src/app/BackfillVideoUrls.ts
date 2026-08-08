import type { CollectedThread, MediaItem, SourceTweet } from "../domain/models";
import type { CollectionRepository } from "../ports/CollectionRepository";
import type { SourceGateway } from "../ports/SourceGateway";

/**
 * What a run would do, computed before anything is written. `apply` writes exactly `patched` and
 * nothing else.
 */
export interface VideoBackfillPlan {
  /** Media entries (not tweets) of type video/animated_gif with no `videoUrl`. */
  candidates: number;
  /** How many stored threads those candidates live in. */
  candidateThreads: number;
  /** The tweet ids those candidates live on, in stored order — exactly what is asked of the API. */
  candidateTweetIds: string[];
  /** Candidate media entries the API could fill. */
  filled: number;
  /**
   * The stored threads that changed, each one the stored thread plus the filled `videoUrl`s.
   * A thread whose candidates all stayed unfilled is not here — see `apply`.
   */
  patched: CollectedThread[];
  /**
   * Candidate tweet ids that still have at least one video media with no `videoUrl` after the
   * patch: the API did not return the tweet at all, or returned it with no usable mp4. Reported,
   * not retried and not marked done — the next run will simply consider them again.
   */
  unfilledTweetIds: string[];
}

const isVideo = (m: MediaItem): boolean => m.type === "video" || m.type === "animated_gif";

/** A video/animated_gif entry with nothing playable stored. `""` counts as missing: an empty
 *  string is as unplayable as an absent one, and nothing should ever store it. */
const needsVideoUrl = (m: MediaItem): boolean => isVideo(m) && !m.videoUrl;

const missingCount = (t: SourceTweet): number => (t.media ?? []).filter(needsVideoUrl).length;

/**
 * The mp4 the API now has for each of a tweet's media entries, keyed by the thumbnail url — the one
 * field a stored entry and a freshly fetched one always share. Never by array position: a tweet with
 * two videos can come back in a different order, and position-matching would then staple the wrong
 * mp4 to each poster frame, which nothing downstream could detect.
 *
 * First occurrence wins on a duplicate url, which only matters for a post carrying the same video
 * twice — where either answer is the same file anyway.
 */
function videoUrlsByThumbnail(fetched: SourceTweet | undefined): Map<string, string> {
  const byUrl = new Map<string, string>();
  for (const m of fetched?.media ?? []) {
    if (m.videoUrl && !byUrl.has(m.url)) byUrl.set(m.url, m.videoUrl);
  }
  return byUrl;
}

/**
 * Fills `MediaItem.videoUrl` on already-stored video media, by tweet id.
 *
 * Why this exists rather than "just re-collect". A re-collect (`pnpm collect --since 70d`) does
 * backfill most of them — `advanced_search` returns the tweets again, now carrying `video_info`, and
 * `PgCollectionRepository.mergeTweet` lets incoming win — but it can only reach a tweet the listing
 * still returns. Measured 2026-08-08: 34 of 35 stored video media were filled that way, and the one
 * left over (tweet 2076703861872660873) is absent from `advanced_search` entirely, replies included,
 * so even `gapFillMissingRoots` never fires for it; a fetch by id returns it with a full variants
 * ladder immediately. That is the same "X listing is incomplete" class `x:link` was built for, and
 * no `--since` and no page cap can fix it. By id is the only path that reaches those posts.
 *
 * Writes through `CollectionRepository.upsert` rather than an `update` of its own. That is safe
 * precisely because incoming wins there: what this class hands back IS the stored thread — same
 * tweets in the same order, same text, same article blocks, same metrics, same `status`,
 * `firstSeenAt` and `deletedAt` — with one field added to the media entries it filled. "Incoming
 * wins" therefore overwrites each column with the value it already held. `mergeTweet`'s article
 * guard is a no-op here for the same reason (the incoming article is the stored article), and
 * `upsert`'s `on conflict` never touches `ordinal`, so thread order survives too. Hand-written SQL
 * would have to re-derive the merge rules this repository already owns, and would drift from them.
 */
export class BackfillVideoUrls {
  constructor(
    private readonly source: SourceGateway,
    private readonly repo: CollectionRepository,
    /**
     * `GET /twitter/tweets` takes comma-separated ids; kept well under 100 so one oversized batch
     * can never be silently truncated by the endpoint into a page of "missing" ids that this class
     * would then report as unfillable.
     */
    private readonly batchSize = 50,
  ) {}

  async plan(): Promise<VideoBackfillPlan> {
    const threads = await this.repo.loadAll();

    // Every status is in scope, on purpose: a deleted thread's stored text is still read by the
    // review screens, so its video is still worth having.
    const candidateTweetIds: string[] = [];
    let candidates = 0;
    let candidateThreads = 0;
    for (const thread of threads) {
      let inThisThread = 0;
      for (const tweet of thread.tweets) {
        const missing = missingCount(tweet);
        if (missing === 0) continue;
        candidates += missing;
        inThisThread += missing;
        candidateTweetIds.push(tweet.id);
      }
      if (inThisThread > 0) candidateThreads++;
    }

    const empty: VideoBackfillPlan = {
      candidates: 0,
      candidateThreads: 0,
      candidateTweetIds: [],
      filled: 0,
      patched: [],
      unfilledTweetIds: [],
    };
    // Nothing to ask about: no API call, and (via `apply`) no write. This is the steady state once
    // the backfill has run, so it is the shape every later run takes.
    if (candidateTweetIds.length === 0) return empty;

    const fetched = new Map<string, SourceTweet>();
    for (let i = 0; i < candidateTweetIds.length; i += this.batchSize) {
      const batch = candidateTweetIds.slice(i, i + this.batchSize);
      // A batch that comes back short is normal, not an error: `/twitter/tweets` returns only the
      // ids it still has. The absent ones simply never reach `fetched` and end up in
      // `unfilledTweetIds` below.
      for (const t of await this.source.fetchByIds(batch)) fetched.set(t.id, t);
    }

    const patched: CollectedThread[] = [];
    const unfilledTweetIds: string[] = [];
    let filled = 0;

    for (const thread of threads) {
      let threadChanged = false;
      const tweets = thread.tweets.map((tweet) => {
        if (missingCount(tweet) === 0) return tweet;

        const byUrl = videoUrlsByThumbnail(fetched.get(tweet.id));
        let stillMissing = 0;
        let tweetChanged = false;
        const media = (tweet.media ?? []).map((m) => {
          if (!needsVideoUrl(m)) return m;
          const videoUrl = byUrl.get(m.url);
          if (videoUrl === undefined) {
            // No mp4 came back for this entry. It stays a candidate — never stamped with a
            // placeholder, which would take it out of every future run's reach.
            stillMissing++;
            return m;
          }
          filled++;
          tweetChanged = true;
          // Spread, so `videoUrl` lands last exactly as `schemas.ts`'s `toMedia` writes it and
          // every other key keeps its stored position: `x_threads.tweets` is a `json` column and
          // `db:export` reproduces it byte for byte.
          return { ...m, videoUrl };
        });

        if (stillMissing > 0) unfilledTweetIds.push(tweet.id);
        if (!tweetChanged) return tweet;
        threadChanged = true;
        return { ...tweet, media };
      });

      // Only threads that actually changed are written. An unchanged thread in the write set would
      // be a no-op row today, but it would still be an `upsert` racing anything else editing it.
      if (threadChanged) patched.push({ ...thread, tweets });
    }

    return { candidates, candidateThreads, candidateTweetIds, filled, patched, unfilledTweetIds };
  }

  /** Writes the plan. Returns how many threads were written — zero writes nothing at all. */
  async apply(plan: VideoBackfillPlan): Promise<number> {
    if (plan.patched.length === 0) return 0;
    await this.repo.upsert(plan.patched);
    return plan.patched.length;
  }
}
