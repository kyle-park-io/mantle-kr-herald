import { describe, it, expect } from "vitest";
import { TmePreviewGateway } from "../../../src/adapters/telegram/TmePreviewGateway";

/**
 * Minimal but structurally real message block, matching the markup the fixtures contain. Must
 * include the `tgme_widget_message_wrap` boundary div: `parseChannelPreview` (Task 2) splits the
 * page on that exact opening tag and treats anything before the first match as page chrome, so a
 * block without it is silently dropped rather than parsed.
 */
function block(handle: string, id: number, iso: string, views = "1.0K"): string {
  return `<div class="tgme_widget_message_wrap js-widget_message_wrap"><div class="tgme_widget_message" data-post="${handle}/${id}">
    <div class="tgme_widget_message_text js-message_text" dir="auto">post ${id}</div>
    <time datetime="${iso}"></time>
    <span class="tgme_widget_message_views">${views}</span>
  </div></div>`;
}

function pageServer(pages: Record<string, string>) {
  const asked: string[] = [];
  const fetchText = async (url: string) => {
    asked.push(url);
    return pages[url] ?? "<html></html>";
  };
  return { fetchText, asked };
}

const JULY = ["2026-07-01T00:00:00.000Z", "2026-08-01T00:00:00.000Z"] as const;

describe("TmePreviewGateway", () => {
  it("returns only posts inside the window, excluding the exclusive end", async () => {
    const { fetchText } = pageServer({
      "https://t.me/s/kolx":
        block("kolx", 10, "2026-06-30T23:59:59+00:00") +
        block("kolx", 11, "2026-07-01T00:00:00+00:00") +
        block("kolx", 12, "2026-07-31T23:59:59+00:00") +
        block("kolx", 13, "2026-08-01T00:00:00+00:00"),
    });
    const { posts } = await new TmePreviewGateway(fetchText).fetchPostsInWindow("kolx", ...JULY);
    expect(posts.map((p) => p.messageId)).toEqual([11, 12]);
  });

  it("pages backwards with ?before until it passes the window start, and reports that as not truncated", async () => {
    const { fetchText, asked } = pageServer({
      "https://t.me/s/kolx": block("kolx", 30, "2026-07-20T00:00:00+00:00"),
      "https://t.me/s/kolx?before=30": block("kolx", 20, "2026-07-05T00:00:00+00:00"),
      "https://t.me/s/kolx?before=20": block("kolx", 10, "2026-06-15T00:00:00+00:00"),
    });
    const { posts, truncated } = await new TmePreviewGateway(fetchText).fetchPostsInWindow("kolx", ...JULY);

    expect(posts.map((p) => p.messageId)).toEqual([20, 30]);
    expect(asked).toEqual([
      "https://t.me/s/kolx",
      "https://t.me/s/kolx?before=30",
      "https://t.me/s/kolx?before=20",
    ]);
    // Normal exit #1: paged past the window start on its own — the cap was never in play.
    expect(truncated).toBe(false);
  });

  it("stops at an empty page instead of paging forever, and reports that as not truncated", async () => {
    const { fetchText, asked } = pageServer({
      "https://t.me/s/kolx": block("kolx", 30, "2026-07-20T00:00:00+00:00"),
    });
    const { posts, truncated } = await new TmePreviewGateway(fetchText).fetchPostsInWindow("kolx", ...JULY);
    expect(posts.map((p) => p.messageId)).toEqual([30]);
    expect(asked).toEqual(["https://t.me/s/kolx", "https://t.me/s/kolx?before=30"]);
    // Normal exit #2: ran out of pages on its own — the cap was never in play.
    expect(truncated).toBe(false);
  });

  it("honours the page cap so one busy channel cannot hang a sweep, and reports that as truncated", async () => {
    // Every page is inside the window and hands back a lower id, so only the cap ends it.
    let next = 100000;
    const fetchText = async () => block("kolx", (next -= 10), "2026-07-15T00:00:00+00:00");
    const gw = new TmePreviewGateway(fetchText, 3);
    const { posts, truncated } = await gw.fetchPostsInWindow("kolx", ...JULY);
    expect(posts).toHaveLength(3);
    expect(truncated).toBe(true);
  });

  it("returns posts sorted oldest first, regardless of page order", async () => {
    const { fetchText } = pageServer({
      "https://t.me/s/kolx": block("kolx", 30, "2026-07-20T00:00:00+00:00"),
      "https://t.me/s/kolx?before=30": block("kolx", 20, "2026-07-05T00:00:00+00:00"),
      "https://t.me/s/kolx?before=20": "<html></html>",
    });
    const { posts } = await new TmePreviewGateway(fetchText).fetchPostsInWindow("kolx", ...JULY);
    expect(posts.map((p) => p.postedAt)).toEqual([
      "2026-07-05T00:00:00.000Z",
      "2026-07-20T00:00:00.000Z",
    ]);
  });

  it("propagates a fetch failure so the caller can isolate the channel", async () => {
    const fetchText = async () => { throw new Error("HTTP 404"); };
    await expect(
      new TmePreviewGateway(fetchText).fetchPostsInWindow("gone", ...JULY),
    ).rejects.toThrow("HTTP 404");
  });
});
