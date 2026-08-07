import type { TranslationStore } from "../ports/TranslationStore";
import { ARTICLE_IMAGE, toXArticleMarkdown } from "../domain/publish/articleMarkdown";
import { matchesItemId } from "../domain/itemId";
import type { Translation } from "../domain/translation/models";
import type { Headroom } from "../domain/send/headroom";

type ArticleMetaResult = { isArticle: boolean; coverImageUrl?: string };
type ArticleMeta = (itemId: string) => Promise<ArticleMetaResult>;
interface Media { upload(url: string): Promise<string> }
interface ArticleSender { send(req: { content_markdown: string; cover_media_id?: string }): Promise<{ postId?: string; url?: string }> }
interface Ledger { loadKeys(): Promise<Set<string>>; add(entry: { itemId: string; postId?: string; url?: string; sentAt: string }): Promise<void> }

// The upload pass and `toXArticleMarkdown`'s rewrite pass must read the same markers — a url
// uploaded but not embedded burns a `media/upload` call against a 20/hour ceiling, and one embedded
// but not uploaded posts a broken article. Shared rather than re-declared here; see ARTICLE_IMAGE.
const IMG = ARTICLE_IMAGE;

export class SendXArticle {
  constructor(
    private readonly translationStore: TranslationStore,
    private readonly articleMeta: ArticleMeta,
    private readonly media: Media,
    private readonly sender: ArticleSender,
    private readonly ledger: Ledger,
    private readonly now: () => string = () => new Date().toISOString(),
    /**
     * Reads how much Typefully publishing headroom is left — the same reader `SendChannels` gates X
     * room sends with (`publishHeadroom.ts`), so the board's banner and both gates can never use
     * different arithmetic to compute it. They can still show different numbers for up to a minute:
     * the banner's read is cached, both gates' are not (`headroomReader` forces `ttlMs: 0`).
     * Optional: an install with no Typefully credentials builds this class through `headroomReader`,
     * which answers `undefined` there, and every pre-headroom call site (all existing tests) stays
     * valid without it. When absent the gate does not run.
     */
    private readonly headroom?: () => Promise<Headroom>,
  ) {}

  async run(
    input: { ids?: Set<string> } = {},
  ): Promise<{ sent: number; skipped: number; failed: number; quotaBlocked?: { needed: number; available: number; resetsAt: string } }> {
    const all = await this.translationStore.loadAll();
    const already = await this.ledger.loadKeys();
    const { pending, skipped } = await this.selectPending(all, already, input);

    // Before a single draft is created: can the account still publish what this run needs? All or
    // nothing, like `SendChannels`' X gate — a partial run leaves an operator reconstructing how far
    // it got, and skipped entirely when there is nothing to send, so an idle run never reaches the
    // network for it.
    if (this.headroom && pending.length > 0) {
      try {
        const h = await this.headroom();
        if (pending.length > h.available) {
          console.warn(
            `[x-article] ⚠ withheld: this run needs ${pending.length} publish(es), ${h.available} left before ${h.resetsAt || "the next reset"}`,
          );
          return { sent: 0, skipped, failed: 0, quotaBlocked: { needed: pending.length, available: h.available, resetsAt: h.resetsAt } };
        }
      } catch (err) {
        // A monitoring call must not become a new way for delivery to fail.
        console.warn(`[x-article] could not read the Typefully publishing quota, sending anyway: ${(err as Error).message}`);
      }
    }

    let sent = 0, failed = 0;
    for (const { t, meta } of pending) {
      try {
        // Upload every image first (inline then cover) so a media failure throws before any live post.
        const inlineUrls = [...t.koreanText.matchAll(IMG)].map((m) => m[1]);
        const urls = [...new Set([...inlineUrls, ...(meta.coverImageUrl ? [meta.coverImageUrl] : [])])];
        const mediaIdByUrl = new Map<string, string>();
        for (const url of urls) mediaIdByUrl.set(url, await this.media.upload(url));

        const content_markdown = toXArticleMarkdown(t.koreanText, mediaIdByUrl);
        const cover_media_id = meta.coverImageUrl ? mediaIdByUrl.get(meta.coverImageUrl) : undefined;
        const res = await this.sender.send({ content_markdown, cover_media_id });
        const sentAt = this.now();
        try {
          await this.ledger.add({ itemId: t.itemId, postId: res.postId, url: res.url, sentAt });
        } catch (err) {
          console.warn(`[x-article] ⚠ ${t.itemId} POSTED but not ledgered: ${(err as Error).message} — a rerun will re-post; reconcile.`);
        }
        sent += 1;
      } catch (err) {
        console.warn(`[x-article] ${t.itemId} failed: ${(err as Error).message}`);
        failed += 1;
      }
    }
    return { sent, skipped, failed };
  }

  /**
   * The translations this run would actually post — approved, matching `--ids`, an article (per the
   * async `articleMeta` lookup), and not already in the ledger — alongside a count of how many were
   * skipped for being already sent.
   *
   * Extracted so the quota gate (which needs the count *before* anything is sent) and the send loop
   * below share one decision, for the same reason `SendChannels.roomsFor` exists: a second copy of
   * this filter would drift, and a drifted count either refuses a run that would have sent nothing or
   * lets an over-quota one through. Returning the already-fetched `meta` alongside each translation
   * means the send loop never calls `articleMeta` a second time for the same item.
   */
  private async selectPending(
    all: Translation[],
    already: Set<string>,
    input: { ids?: Set<string> },
  ): Promise<{ pending: { t: Translation; meta: ArticleMetaResult }[]; skipped: number }> {
    const pending: { t: Translation; meta: ArticleMetaResult }[] = [];
    let skipped = 0;
    for (const t of all) {
      if (t.status !== "approved") continue;
      if (input.ids && !matchesItemId(input.ids, t.itemId)) continue;
      const meta = await this.articleMeta(t.itemId);
      if (!meta.isArticle) continue;
      if (already.has(t.itemId)) { skipped += 1; continue; }
      pending.push({ t, meta });
    }
    return { pending, skipped };
  }
}
