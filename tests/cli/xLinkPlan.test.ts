import { describe, it, expect } from "vitest";
import { planXLink, parsePostArg } from "../../src/cli/xLinkPlan";
import type { AssembledThread, SourceTweet } from "../../src/domain/models";
import type { Translation } from "../../src/domain/translation/models";

const HANDLE = "0xMantleKR";

const thread = (rootId: string, texts: string[], authorUserName = HANDLE): AssembledThread => ({
  rootId,
  tweets: texts.map((text, i) => ({
    id: i === 0 ? rootId : `${rootId}${i}`,
    conversationId: rootId,
    text,
    createdAt: "2026-07-28T11:14:58.000Z",
    url: `https://x.com/${authorUserName}/status/${i === 0 ? rootId : `${rootId}${i}`}`,
    authorUserName,
    isReply: i > 0,
    isQuote: false,
  })) satisfies SourceTweet[],
});

const tr = (over: Partial<Translation> = {}): Translation => ({
  itemId: "x:1",
  source: "x",
  sourceText: "en",
  koreanText: "토큰화 주식의 온체인 거래량이 지난 1년간 170배 늘었습니다.",
  status: "approved",
  translatedAt: "2026-07-27T00:00:00.000Z",
  ...over,
});

const plan = (over: Partial<Parameters<typeof planXLink>[0]> = {}) =>
  planXLink({
    translation: tr(),
    itemId: "x:1",
    rootId: "999",
    thread: thread("999", ["토큰화 주식의 온체인 거래량이 1년 만에 170배 늘었습니다."]),
    handle: HANDLE,
    ...over,
  });

describe("parsePostArg", () => {
  it("takes a bare post id", () => {
    expect(parsePostArg("2082062251876561175")).toBe("2082062251876561175");
  });

  it("takes a full post url", () => {
    expect(parsePostArg("https://x.com/0xMantleKR/status/2082062251876561175")).toBe("2082062251876561175");
  });

  it("takes a url with a query string, which is what copying from X actually gives you", () => {
    expect(parsePostArg("https://x.com/0xMantleKR/status/2082062251876561175?s=20")).toBe("2082062251876561175");
  });

  it("refuses anything else rather than guessing", () => {
    expect(parsePostArg("not-a-post")).toBeUndefined();
    expect(parsePostArg("https://x.com/0xMantleKR")).toBeUndefined();
    expect(parsePostArg("")).toBeUndefined();
  });
});

describe("planXLink", () => {
  it("plans the link, carrying the thread body and the root's own timestamp", () => {
    const p = plan();
    expect(p.kind).toBe("link");
    if (p.kind !== "link") return;
    expect(p.itemId).toBe("x:1");
    expect(p.rootId).toBe("999");
    expect(p.url).toBe("https://x.com/0xMantleKR/status/999");
    expect(p.postedAt).toBe("2026-07-28T11:14:58.000Z");
    expect(p.text).toBe("토큰화 주식의 온체인 거래량이 1년 만에 170배 늘었습니다.");
    expect(p.score).toBeGreaterThan(0.5);
  });

  it("joins a multi-tweet thread with the pipeline separator, same as capture", () => {
    const p = plan({ thread: thread("999", ["첫 트윗", "둘째 트윗"]) });
    expect(p.kind === "link" && p.text).toBe("첫 트윗\n\n---\n\n둘째 트윗");
  });

  it("reports a low score without refusing — the human named this post", () => {
    // The whole reason this command exists is that the matcher could not find the post. Letting a
    // score veto the human would rebuild the wall it was written to get around.
    const p = plan({ translation: tr({ koreanText: "완전히 무관한 한국어 문장입니다." }) });
    expect(p.kind).toBe("link");
    if (p.kind !== "link") return;
    expect(p.score).toBeLessThan(0.25);
    expect(p.lowScore).toBe(true);
  });

  it("does not flag a healthy score as low", () => {
    expect(plan().kind === "link" && (plan() as { lowScore: boolean }).lowScore).toBe(false);
  });

  it("refuses when the translation row does not exist", () => {
    const p = plan({ translation: undefined });
    expect(p.kind).toBe("refuse");
    expect(p.kind === "refuse" && p.reason).toMatch(/x:1/);
  });

  it("refuses when the post could not be read back", () => {
    const p = plan({ thread: undefined });
    expect(p.kind).toBe("refuse");
    expect(p.kind === "refuse" && p.reason).toMatch(/999/);
  });

  it("refuses a post authored by another account", () => {
    // Linking someone else's post would write a publish-history row claiming we published it.
    const p = plan({ thread: thread("999", ["남의 글"], "SomeoneElse") });
    expect(p.kind).toBe("refuse");
    expect(p.kind === "refuse" && p.reason).toMatch(/SomeoneElse/);
  });

  it("refuses a Lark translation — this account never published it", () => {
    const p = plan({ translation: tr({ source: "lark" }) });
    expect(p.kind).toBe("refuse");
    expect(p.kind === "refuse" && p.reason).toMatch(/lark/i);
  });

  it("reports an already-linked item as a no-op rather than rewriting it", () => {
    const p = plan({ translation: tr({ status: "posted", postedUrl: "https://x.com/0xMantleKR/status/999" }) });
    expect(p.kind).toBe("already-linked");
  });

  it("refuses when the item is already linked to a DIFFERENT post", () => {
    // Silently repointing it would drop the evidence of the first match with nothing recording that
    // it changed. A human who really means it can 되돌리기 first.
    const p = plan({ translation: tr({ status: "posted", postedUrl: "https://x.com/0xMantleKR/status/111" }) });
    expect(p.kind).toBe("refuse");
    expect(p.kind === "refuse" && p.reason).toMatch(/111/);
    expect(p.kind === "refuse" && p.reason).toMatch(/되돌리기/);
  });
});
