import { describe, it, expect } from "vitest";
import { renderSent, sentFileName } from "../../../src/domain/publish/renderers";
import type { SentArchiveEntry } from "../../../src/domain/send/channels";

const base: SentArchiveEntry = {
  itemId: "x:2080608995371597892", type: "announcement", channel: "telegram", outletId: "tg-community",
  text: "📢 **맨틀 Q2**\n\n본문", postId: "10", url: undefined, sentAt: "2026-07-28T01:34:42.000Z",
};

describe("renderSent", () => {
  it("renders the metadata header + body, with — for a missing url", () => {
    expect(renderSent(base)).toBe(
      "# x:2080608995371597892 · telegram (announcement)\n\n" +
        "- sent: 2026-07-28T01:34:42.000Z\n" +
        "- outlet: tg-community\n" +
        "- postId: 10\n" +
        "- url: —\n\n" +
        "---\n\n" +
        "📢 **맨틀 Q2**\n\n본문\n",
    );
  });

  it("shows a present url and a — for a missing postId", () => {
    const doc = renderSent({ ...base, url: "https://t.me/c/1/10", postId: undefined });
    expect(doc).toContain("- postId: —\n");
    expect(doc).toContain("- url: https://t.me/c/1/10\n");
  });
});

describe("sentFileName", () => {
  it("is <sentDate>-<safeItemId>-<type>-<outletId>.md with the id sanitized", () => {
    expect(sentFileName(base)).toBe("2026-07-28-x-2080608995371597892-announcement-tg-community.md");
  });

  it("names the two auto telegram rooms apart — the archivers upload rather than replace", () => {
    // Same item, same channel, same day: a channel-named archive would put both in the Drive
    // `sent/` folder under one name, carrying different message ids and impossible to tell apart.
    expect(sentFileName({ ...base, outletId: "tg-dev" })).not.toBe(sentFileName(base));
  });

  it("names one room's 공지 and 해설 apart — 데브방 receives both, from the same board", () => {
    // The board's `n/m` badge exists for exactly this room, and each row is its own [발송]. Without
    // the type in the name the second archive overwrites the first in local mode, and lands beside
    // it indistinguishably in Drive — losing the only record of what one of the two rooms received.
    expect(sentFileName({ ...base, type: "explainer", outletId: "tg-dev" })).not.toBe(
      sentFileName({ ...base, type: "announcement", outletId: "tg-dev" }),
    );
  });
});
