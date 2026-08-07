import { describe, it, expect } from "vitest";
import { capturePublishedTexts } from "../../../src/domain/publish/publishedTextCapture";
import type { AssembledThread, SourceTweet } from "../../../src/domain/models";
import type { Translation } from "../../../src/domain/translation/models";

const thread = (rootId: string, text: string): AssembledThread => ({
  rootId,
  tweets: [{
    id: rootId, conversationId: rootId, text, createdAt: "2026-08-01T00:00:00.000Z",
    url: `https://x.com/0xMantleKR/status/${rootId}`, authorUserName: "0xMantleKR",
    isReply: false, isQuote: false,
  } satisfies SourceTweet],
});

const tr = (over: Partial<Translation> = {}): Translation => ({
  itemId: "x:1", source: "x", sourceText: "en", koreanText: "우리 초안",
  status: "posted", translatedAt: "2026-08-01T00:00:00.000Z", ...over,
});

const handle = "0xMantleKR";

describe("capturePublishedTexts", () => {
  it("captures a settled translation from its postedUrl", () => {
    const t = tr({ postedUrl: "https://x.com/0xMantleKR/status/999" });
    const out = capturePublishedTexts({ translations: [t], threads: [thread("999", "올라간 글")], posted: [], handle });
    expect(out).toEqual([{ itemId: "x:1", rootId: "999", text: "올라간 글" }]);
  });

  it("captures a translation this run just retired, which has no postedUrl yet", () => {
    const t = tr({ status: "translated" });
    const out = capturePublishedTexts({
      translations: [t], threads: [thread("999", "올라간 글")],
      posted: [{ itemId: "x:1", rootId: "999" }], handle,
    });
    expect(out).toEqual([{ itemId: "x:1", rootId: "999", text: "올라간 글" }]);
  });

  it("never overwrites a cell that already has a value", () => {
    const t = tr({ postedUrl: "https://x.com/0xMantleKR/status/999", publishedText: "이미 있음" });
    const out = capturePublishedTexts({ translations: [t], threads: [thread("999", "다른 글")], posted: [], handle });
    expect(out).toEqual([]);
  });

  it("skips a translation whose post is not in this run's pool", () => {
    // Aged out of the --since window. The cell stays empty; a later, wider run fills it.
    const t = tr({ postedUrl: "https://x.com/0xMantleKR/status/999" });
    const out = capturePublishedTexts({ translations: [t], threads: [thread("111", "다른 글")], posted: [], handle });
    expect(out).toEqual([]);
  });

  it("skips a translation with no post id at all", () => {
    const out = capturePublishedTexts({ translations: [tr({ status: "translated" })], threads: [thread("999", "x")], posted: [], handle });
    expect(out).toEqual([]);
  });

  it("skips a postedUrl pointing at another account", () => {
    // Mirrors settledTranslationDisposition's own foreign-account guard: a well-formed url for a
    // different handle is not this run's to read.
    const t = tr({ postedUrl: "https://x.com/SomeoneElse/status/999" });
    const out = capturePublishedTexts({ translations: [t], threads: [thread("999", "올라간 글")], posted: [], handle });
    expect(out).toEqual([]);
  });

  it("matches the handle case-insensitively", () => {
    // An X handle is case-insensitive; `--handle 0xmantlekr` names the same account.
    const t = tr({ postedUrl: "https://x.com/0xMantleKR/status/999" });
    const out = capturePublishedTexts({ translations: [t], threads: [thread("999", "올라간 글")], posted: [], handle: "0xmantlekr" });
    expect(out).toHaveLength(1);
  });

  it("skips a malformed postedUrl instead of guessing", () => {
    const t = tr({ postedUrl: "not a url" });
    const out = capturePublishedTexts({ translations: [t], threads: [thread("999", "올라간 글")], posted: [], handle });
    expect(out).toEqual([]);
  });

  it("treats an empty-string publishedText as empty and fills it", () => {
    const t = tr({ postedUrl: "https://x.com/0xMantleKR/status/999", publishedText: "" });
    const out = capturePublishedTexts({ translations: [t], threads: [thread("999", "올라간 글")], posted: [], handle });
    expect(out).toHaveLength(1);
  });

  it("prefers the posted entry's rootId over a stale postedUrl for the same item", () => {
    // A stored postedUrl is a *previous* run's value and can point at the wrong post (aged out,
    // hand-edited, or simply superseded); a `posted` entry is this run's own fresh match, made
    // moments ago against these same threads. When both name the same itemId, the fresh match wins
    // — both candidate threads are in the pool so a wrong-branch bug fails on content, not on a
    // missing thread.
    const t = tr({ postedUrl: "https://x.com/0xMantleKR/status/111" });
    const out = capturePublishedTexts({
      translations: [t],
      threads: [thread("111", "옛 글"), thread("999", "새 글")],
      posted: [{ itemId: "x:1", rootId: "999" }],
      handle,
    });
    expect(out).toEqual([{ itemId: "x:1", rootId: "999", text: "새 글" }]);
  });

  it("joins a multi-tweet thread the same way scoring does", () => {
    const multi: AssembledThread = {
      rootId: "999",
      tweets: [
        { ...thread("999", "첫 트윗").tweets[0] },
        { ...thread("999", "둘째 트윗").tweets[0], id: "1000", isReply: true },
      ],
    };
    const t = tr({ postedUrl: "https://x.com/0xMantleKR/status/999" });
    const [captured] = capturePublishedTexts({ translations: [t], threads: [multi], posted: [], handle });
    expect(captured.text).toContain("첫 트윗");
    expect(captured.text).toContain("둘째 트윗");
  });
});
