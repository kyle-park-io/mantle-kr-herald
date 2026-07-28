import type { TranslationStore } from "../ports/TranslationStore";
import { toXArticleMarkdown } from "../domain/publish/articleMarkdown";

type ArticleMeta = (itemId: string) => Promise<{ isArticle: boolean; coverImageUrl?: string }>;
interface Media { upload(url: string): Promise<string> }
interface ArticleSender { send(req: { content_markdown: string; cover_media_id?: string }): Promise<{ postId?: string; url?: string }> }
interface Ledger { loadKeys(): Promise<Set<string>>; add(entry: { itemId: string; postId?: string; url?: string; sentAt: string }): Promise<void> }

const IMG = /!\[[^\]]*\]\(([^)]+)\)/g;

export class SendXArticle {
  constructor(
    private readonly translationStore: TranslationStore,
    private readonly articleMeta: ArticleMeta,
    private readonly media: Media,
    private readonly sender: ArticleSender,
    private readonly ledger: Ledger,
    private readonly now: () => string = () => new Date().toISOString(),
  ) {}

  async run(input: { ids?: Set<string> } = {}): Promise<{ sent: number; skipped: number; failed: number }> {
    const all = await this.translationStore.loadAll();
    const already = await this.ledger.loadKeys();
    let sent = 0, skipped = 0, failed = 0;
    for (const t of all) {
      if (t.status !== "approved") continue;
      if (input.ids && !input.ids.has(t.itemId)) continue;
      const meta = await this.articleMeta(t.itemId);
      if (!meta.isArticle) continue;
      if (already.has(t.itemId)) { skipped += 1; continue; }
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
}
