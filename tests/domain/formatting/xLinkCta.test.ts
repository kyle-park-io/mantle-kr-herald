import { describe, expect, it } from "vitest";
import {
  needsXLinkCta,
  xLinkCta,
  appendXLinkCta,
  resolveXPostUrl,
  X_URL_PENDING,
} from "../../../src/domain/formatting/xLinkCta";
import type { DeliveryEntry } from "../../../src/domain/delivery/models";

const URL = "https://x.com/0xMantleKR/status/2087418810458382585";

function delivery(over: Partial<DeliveryEntry> = {}): DeliveryEntry {
  return { itemId: "x:1", type: "x", outletId: "x-post", status: "sent", at: "2026-08-12T00:00:00.000Z", by: "auto", ...over };
}

describe("needsXLinkCta", () => {
  /** The two 공지 types, each on the channel its fan-out actually sends it to. */
  it("is true for both 공지 types on their own channel", () => {
    expect(needsXLinkCta("announcement", "telegram")).toBe(true);
    expect(needsXLinkCta("kakao_notice", "kakao")).toBe(true);
  });

  /**
   * `(announcement, kakao)` — a pair the fan-out stopped producing when `kakao_notice` split off,
   * and this still has to answer `true`.
   *
   * Not a leftover assertion. The predicate is never asked about the fan-out; it is asked about a
   * **stored** rendering, by the board, `xUrlBlock`, the [복사] preview and the send path. The
   * renderings written before the split are deliberately not migrated, so those four keep meeting
   * this pair — and an answer of `false` would strip both the 👉 CTA and the "post to X first" gate
   * off copy a human is about to paste into a live room. Nothing rewrites it back on later.
   */
  it("is still true for a kakao rendering written before the 공지 split", () => {
    expect(needsXLinkCta("announcement", "kakao")).toBe(true);
  });

  it("is false for every other type on those channels", () => {
    for (const type of ["explainer", "casual", "kol", "pr", "x"]) {
      expect(needsXLinkCta(type, "telegram")).toBe(false);
      expect(needsXLinkCta(type, "kakao")).toBe(false);
    }
  });

  it("is false for either 공지 type on x and pr_mail", () => {
    for (const type of ["announcement", "kakao_notice"]) {
      expect(needsXLinkCta(type, "x")).toBe(false);
      expect(needsXLinkCta(type, "pr_mail")).toBe(false);
    }
  });
});

describe("xLinkCta", () => {
  it("uses ➡ on telegram", () => {
    expect(xLinkCta("telegram", URL)).toBe(`➡ 자세한 내용은 X에서 확인하세요 (${URL})`);
  });

  it("uses 👉 on kakao", () => {
    expect(xLinkCta("kakao", URL)).toBe(`👉 자세한 내용은 X에서 확인하세요 (${URL})`);
  });

  it("is not a markdown link — the url has to stay visible after emit", () => {
    expect(xLinkCta("telegram", URL)).not.toContain("](");
  });
});

describe("appendXLinkCta", () => {
  it("separates the cta from the body with one blank line", () => {
    expect(appendXLinkCta("본문", "➡ cta")).toBe("본문\n\n➡ cta");
  });
});

describe("resolveXPostUrl", () => {
  it("prefers the translation's posted url", () => {
    expect(resolveXPostUrl({ postedUrl: URL }, [])).toBe(URL);
  });

  it("falls back to the x-post delivery row", () => {
    expect(resolveXPostUrl(undefined, [delivery({ url: URL })])).toBe(URL);
  });

  it("ignores a typefully share url on the delivery row", () => {
    expect(resolveXPostUrl(undefined, [delivery({ url: "https://typefully.com/t/abc123" })])).toBeUndefined();
  });

  it("ignores a typefully share url on the translation and falls through", () => {
    expect(resolveXPostUrl({ postedUrl: "https://typefully.com/t/abc" }, [delivery({ url: URL })])).toBe(URL);
  });

  it("ignores a dropped delivery row", () => {
    expect(resolveXPostUrl(undefined, [delivery({ url: URL, status: "dropped" })])).toBeUndefined();
  });

  it("ignores a delivery row for another room", () => {
    expect(resolveXPostUrl(undefined, [delivery({ url: URL, outletId: "tg-community" })])).toBeUndefined();
  });

  it("is undefined when nothing carries a url", () => {
    expect(resolveXPostUrl(undefined, [])).toBeUndefined();
    expect(resolveXPostUrl({}, [delivery()])).toBeUndefined();
  });
});

describe("X_URL_PENDING", () => {
  it("is not a url, so a preview cannot be pasted as one", () => {
    expect(X_URL_PENDING).not.toContain("http");
  });
});
