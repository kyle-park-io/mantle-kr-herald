import { describe, it, expect } from "vitest";
import { SendXArticle } from "../../src/app/SendXArticle";
import type { Translation } from "../../src/domain/translation/models";

const tr = (over: Partial<Translation> = {}): Translation =>
  ({ itemId: "x:1", source: "x", sourceText: "s", koreanText: "# 제목\n\n![](https://img/a.jpg)", status: "approved", translatedAt: "t", ...over });

function deps(over: any = {}) {
  const uploaded: string[] = [];
  const sent: any[] = [];
  const ledgerKeys = new Set<string>();
  return {
    uploaded, sent, ledgerKeys,
    d: {
      translationStore: { loadAll: async () => over.rows ?? [tr()], upsert: async () => {} },
      articleMeta: over.articleMeta ?? (async (id: string) => ({ isArticle: id === "x:1", coverImageUrl: "https://img/cover.jpg" })),
      media: { upload: async (url: string) => { uploaded.push(url); return `M_${url.split("/").pop()}`; } },
      sender: { send: async (req: any) => { sent.push(req); return { postId: "123", url: "https://x.com/i/article/123" }; } },
      ledger: { loadKeys: async () => ledgerKeys, add: async (e: any) => { ledgerKeys.add(e.itemId); } },
    },
  };
}

describe("SendXArticle", () => {
  it("uploads images, builds content_markdown with typ:media + cover, posts, and ledgers", async () => {
    const { d, uploaded, sent, ledgerKeys } = deps();
    const res = await new SendXArticle(d.translationStore as any, d.articleMeta, d.media, d.sender, d.ledger).run({});
    expect(res).toEqual({ sent: 1, skipped: 0, failed: 0 });
    expect(uploaded).toEqual(["https://img/a.jpg", "https://img/cover.jpg"]); // inline first, then cover
    expect(sent[0].content_markdown).toContain('<typ:media media_id="M_a.jpg" />');
    expect(sent[0].content_markdown).not.toContain("![](");
    expect(sent[0].cover_media_id).toBe("M_cover.jpg");
    expect(ledgerKeys.has("x:1")).toBe(true);
  });

  it("skips a non-article translation and one already in the ledger", async () => {
    const { d } = deps({ articleMeta: async () => ({ isArticle: false }) });
    expect((await new SendXArticle(d.translationStore as any, d.articleMeta, d.media, d.sender, d.ledger).run({})).sent).toBe(0);

    const p = deps(); p.ledgerKeys.add("x:1");
    const r = await new SendXArticle(p.d.translationStore as any, p.d.articleMeta, p.d.media, p.d.sender, p.d.ledger).run({});
    expect(r).toEqual({ sent: 0, skipped: 1, failed: 0 });
  });

  it("counts a media/send failure as failed and does not ledger it", async () => {
    const { d, ledgerKeys } = deps();
    d.media.upload = async () => { throw new Error("upload boom"); };
    const r = await new SendXArticle(d.translationStore as any, d.articleMeta, d.media, d.sender, d.ledger).run({});
    expect(r).toEqual({ sent: 0, skipped: 0, failed: 1 });
    expect(ledgerKeys.has("x:1")).toBe(false);
  });

  it("only approved translations are considered", async () => {
    const { d } = deps({ rows: [tr({ status: "translated" })] });
    expect((await new SendXArticle(d.translationStore as any, d.articleMeta, d.media, d.sender, d.ledger).run({})).sent).toBe(0);
  });

  it("respects the --ids filter (only the requested item is sent)", async () => {
    const { d, sent } = deps({
      rows: [tr({ itemId: "x:1" }), tr({ itemId: "x:2" })],
      articleMeta: async () => ({ isArticle: true }),
    });
    const res = await new SendXArticle(d.translationStore as any, d.articleMeta, d.media, d.sender, d.ledger).run({ ids: new Set(["x:2"]) });
    expect(res.sent).toBe(1);
    expect(sent).toHaveLength(1);
  });
});
