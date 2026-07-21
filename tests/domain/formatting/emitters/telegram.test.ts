import { describe, it, expect } from "vitest";
import { emitTelegramPaste, emitTelegramBot, TELEGRAM_MAX } from "../../../../src/domain/formatting/emitters/telegram";

describe("emitTelegramPaste", () => {
  it("emits plain text — a client is not documented to parse markdown on paste", () => {
    const r = emitTelegramPaste("**중요** [자세히](https://x.io)");
    expect(r.segments[0].text).toBe("중요 자세히 (https://x.io)");
    expect(r.segments[0].text).not.toContain("*");
  });

  it("warns past 4096 characters without splitting", () => {
    const r = emitTelegramPaste("가".repeat(TELEGRAM_MAX + 5));
    expect(r.segments).toHaveLength(1);
    expect(r.segments[0].overLimit).toBe(true);
    expect(r.warnings[0]).toContain("4101/4096");
  });

  it("treats exactly 4096 as within the limit and 4097 as over", () => {
    expect(emitTelegramPaste("가".repeat(TELEGRAM_MAX)).segments[0].overLimit).toBe(false);
    expect(emitTelegramPaste("가".repeat(TELEGRAM_MAX + 1)).segments[0].overLimit).toBe(true);
  });

  it("flattens a post boundary to a single blank line — post boundaries are an x-only concept", () => {
    const r = emitTelegramPaste("a\n\n\nb");
    expect(r.segments[0].text).toBe("a\n\nb");
  });
});

describe("emitTelegramBot", () => {
  it("converts bold and links to HTML entities", () => {
    const r = emitTelegramBot("**중요** [자세히](https://x.io)");
    expect(r.segments[0].text).toBe('<b>중요</b> <a href="https://x.io">자세히</a>');
  });

  it("escapes &, < and > before inserting tags", () => {
    const r = emitTelegramBot("a < b & c > d");
    expect(r.segments[0].text).toBe("a &lt; b &amp; c &gt; d");
  });

  it("escapes & inside a URL query string", () => {
    const r = emitTelegramBot("[링크](https://x.io/?a=1&b=2)");
    expect(r.segments[0].text).toBe('<a href="https://x.io/?a=1&amp;b=2">링크</a>');
  });

  it("leaves Korean full stops, parentheses and hyphens untouched — the MarkdownV2 trap", () => {
    // MarkdownV2 would require escaping every one of . ( ) - here; HTML mode requires none
    const r = emitTelegramBot("맨틀(Mantle)은 L2-체인입니다. 확인해 주세요!");
    expect(r.segments[0].text).toBe("맨틀(Mantle)은 L2-체인입니다. 확인해 주세요!");
  });

  it("measures visible length after entity parsing, not the raw HTML", () => {
    // visible text is "중요 자세히" = 6 characters; the tags and URL do not count
    const r = emitTelegramBot("**중요** [자세히](https://x.io)");
    expect(r.segments[0].length).toBe(6);
  });

  it("treats exactly 4096 as within the limit and 4097 as over", () => {
    expect(emitTelegramBot("가".repeat(TELEGRAM_MAX)).segments[0].overLimit).toBe(false);
    expect(emitTelegramBot("가".repeat(TELEGRAM_MAX + 1)).segments[0].overLimit).toBe(true);
  });

  it("counts an escaped character as one visible character, not as its entity", () => {
    const r = emitTelegramBot("a & b");
    expect(r.segments[0].text).toBe("a &amp; b");
    expect(r.segments[0].length).toBe(5);
  });

  it("handles bold wrapping a link and a link label containing bold", () => {
    const wrapping = emitTelegramBot("**[텍스트](https://x.io)**");
    expect(wrapping.segments[0].text).toBe('<b><a href="https://x.io">텍스트</a></b>');
    expect(wrapping.segments[0].length).toBe(3);

    const inner = emitTelegramBot("[**텍스트**](https://x.io)");
    expect(inner.segments[0].text).toBe('<a href="https://x.io"><b>텍스트</b></a>');
    expect(inner.segments[0].length).toBe(3);
  });

  it("flattens a post boundary to a single blank line, and measures length against the flattened text", () => {
    const r = emitTelegramBot("a\n\n\nb");
    expect(r.segments[0].text).toBe("a\n\nb");
    expect(r.segments[0].length).toBe([...("a\n\nb")].length);
  });
});
