import { describe, expect, it } from "vitest";
import { needsKrLinkRewrite, linkedSweptItemIds, rewriteGlobalLinks, krLinkNotice } from "../../../src/domain/formatting/krLinks";

const G = (id: string) => `https://x.com/Mantle_Official/status/${id}`;
const KR = "https://x.com/0xMantleKR/status/2087418810458382585";

describe("needsKrLinkRewrite", () => {
  it("is true only for the x type", () => {
    expect(needsKrLinkRewrite("x")).toBe(true);
    for (const t of ["announcement", "kakao_notice", "explainer", "casual", "kol", "pr"]) {
      expect(needsKrLinkRewrite(t)).toBe(false);
    }
  });
});

describe("linkedSweptItemIds", () => {
  it("finds a Mantle Global post link", () => {
    expect(linkedSweptItemIds(`본문\n${G("111")}`)).toEqual(["x:111"]);
  });

  it("ignores a link to any other account", () => {
    expect(linkedSweptItemIds("https://x.com/xStocksFi/status/222")).toEqual([]);
  });

  it("ignores a link to our own Korean account", () => {
    expect(linkedSweptItemIds(KR)).toEqual([]);
  });

  it("ignores a non-status x.com url", () => {
    expect(linkedSweptItemIds("https://x.com/Mantle_Official")).toEqual([]);
  });

  it("dedupes and keeps first-seen order", () => {
    expect(linkedSweptItemIds(`${G("222")} ${G("111")} ${G("222")}`)).toEqual(["x:222", "x:111"]);
  });

  it("finds nothing in text with no links", () => {
    expect(linkedSweptItemIds("링크 없는 본문")).toEqual([]);
  });
});

describe("rewriteGlobalLinks", () => {
  it("swaps a resolved link and reports nothing unresolved", () => {
    const r = rewriteGlobalLinks(`앞 ${G("111")} 뒤`, new Map([["x:111", KR]]));
    expect(r.text).toBe(`앞 ${KR} 뒤`);
    expect(r.unresolved).toBe(0);
  });

  it("leaves an unresolved link alone and counts it", () => {
    const r = rewriteGlobalLinks(G("111"), new Map());
    expect(r.text).toBe(G("111"));
    expect(r.unresolved).toBe(1);
  });

  it("judges each link independently", () => {
    const r = rewriteGlobalLinks(`${G("111")}\n${G("222")}`, new Map([["x:111", KR]]));
    expect(r.text).toBe(`${KR}\n${G("222")}`);
    expect(r.unresolved).toBe(1);
  });

  it("counts one unresolved link once even when it appears twice", () => {
    const r = rewriteGlobalLinks(`${G("111")} ${G("111")}`, new Map());
    expect(r.unresolved).toBe(1);
  });

  it("never touches another account's link", () => {
    const other = "https://x.com/xStocksFi/status/222";
    expect(rewriteGlobalLinks(other, new Map([["x:222", KR]])).text).toBe(other);
  });

  it("leaves surrounding punctuation intact", () => {
    const r = rewriteGlobalLinks(`(${G("111")})`, new Map([["x:111", KR]]));
    expect(r.text).toBe(`(${KR})`);
  });
});

describe("krLinkNotice", () => {
  it("says nothing when everything resolved", () => {
    expect(krLinkNotice(0)).toBeNull();
  });

  it("names the count and the remedy when something did not", () => {
    const n = krLinkNotice(2)!;
    expect(n).toContain("2건");
    expect(n).toContain("한국 글");
  });
});
