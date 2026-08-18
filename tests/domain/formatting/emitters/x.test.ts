import { describe, it, expect } from "vitest";
import { emitXPaste, emitXTypefully, stripLinkIcon } from "../../../../src/domain/formatting/emitters/x";

describe("emitXPaste", () => {
  it("strips bold to plain text — never unicode bold", () => {
    const r = emitXPaste("**메인넷** 출시");
    expect(r.segments[0].text).toBe("메인넷 출시");
    // U+1D5D4 is MATHEMATICAL SANS-SERIF BOLD CAPITAL A; nothing in that block may appear
    expect([...r.segments[0].text].every((c) => c.codePointAt(0)! < 0x1d400)).toBe(true);
  });

  it("leaves hashtags, mentions and t.co links untouched", () => {
    const r = emitXPaste("#Mantle @Mantle_Official https://t.co/x");
    expect(r.segments[0].text).toBe("#Mantle @Mantle_Official https://t.co/x");
  });

  it("rewrites markdown links as 'text (url)'", () => {
    expect(emitXPaste("공지 [자세히](https://x.io)").segments[0].text).toBe("공지 자세히 (https://x.io)");
  });

  it("turns post boundaries into segments and labels them", () => {
    const r = emitXPaste("하나\n\n\n둘\n\n\n셋");
    expect(r.segments.map((s) => s.text)).toEqual(["하나", "둘", "셋"]);
    expect(r.segments.map((s) => s.label)).toEqual(["트윗 1/3", "트윗 2/3", "트윗 3/3"]);
  });

  it("leaves a single post unlabelled", () => {
    expect(emitXPaste("혼자").segments[0].label).toBeUndefined();
  });

  it("measures each segment by weight, so 140 Hangul is at the limit and 141 is over", () => {
    const ok = emitXPaste("가".repeat(140));
    expect(ok.segments[0].length).toBe(280);
    expect(ok.segments[0].overLimit).toBe(false);
    expect(ok.warnings).toEqual([]);

    const over = emitXPaste("가".repeat(141));
    expect(over.segments[0].overLimit).toBe(true);
    expect(over.warnings).toEqual(["282/280 (2 초과)"]);
  });

  it("names the offending tweet when only one segment of a thread is over", () => {
    const r = emitXPaste(`짧음\n\n\n${"가".repeat(200)}`);
    expect(r.warnings).toEqual(["트윗 2/2: 400/280 (120 초과)"]);
  });

  it("never splits on its own — an over-limit post stays one segment", () => {
    expect(emitXPaste("가".repeat(500)).segments).toHaveLength(1);
  });

  it("warns when bold spans a post boundary, leaking an unbalanced ** into each half", () => {
    const r = emitXPaste("**가\n\n\n나**");
    expect(r.segments.map((s) => s.text)).toEqual(["**가", "나**"]);
    expect(r.warnings).toEqual([
      "트윗 1/2: 볼드(**)가 트윗 경계를 넘어가 있어 짝이 맞지 않습니다",
      "트윗 2/2: 볼드(**)가 트윗 경계를 넘어가 있어 짝이 맞지 않습니다",
    ]);
  });

  it("warns about an unpaired marker, not a boundary, when there is no post boundary at all", () => {
    const r = emitXPaste("2**3");
    expect(r.warnings).toHaveLength(1);
    expect(r.warnings[0]).not.toContain("경계");
    expect(r.warnings[0]).toContain("볼드(**)");
  });

  it("warns about an unpaired marker for a lone opening ** with no close", () => {
    const r = emitXPaste("**중요");
    expect(r.warnings).toHaveLength(1);
    expect(r.warnings[0]).not.toContain("경계");
    expect(r.warnings[0]).toContain("볼드(**)");
  });

  it("produces no warning at all for ordinary balanced bold", () => {
    const r = emitXPaste("**중요** 알림");
    expect(r.segments[0].text).toBe("중요 알림");
    expect(r.warnings).toEqual([]);
  });
});

describe("emitXTypefully", () => {
  // Asserts real output, not `toEqual(emitXPaste(...))` — the two are the same function today,
  // so comparing them would assert nothing and would keep passing if both broke together.
  it("emits plain-text segments split on post boundaries, measured against the 280 limit", () => {
    const r = emitXTypefully("**하나**\n\n\n[둘](https://x.io)");
    expect(r.segments.map((s) => s.text)).toEqual(["하나", "둘 (https://x.io)"]);
    expect(r.segments.map((s) => s.limit)).toEqual([280, 280]);
    expect(r.warnings).toEqual([]);
  });
});

describe("stripLinkIcon", () => {
  it("strips an icon from a line that is only an icon and a url", () => {
    expect(stripLinkIcon("🔗 https://fluxion.network/trade")).toBe("https://fluxion.network/trade");
  });

  it("leaves a bracketed media marker alone", () => {
    const line = "[영상] https://video.twimg.com/amplify_video/1/vid.mp4";
    expect(stripLinkIcon(line)).toBe(line);
  });

  it("leaves a url that follows words on the same line alone", () => {
    const line = "· 거래: https://fluxion.network/trade";
    expect(stripLinkIcon(line)).toBe(line);
  });

  it("leaves a url inside a sentence alone", () => {
    const line = "자세한 내용은 https://fluxion.network/trade 에서 확인하세요.";
    expect(stripLinkIcon(line)).toBe(line);
  });

  it("strips on every line of a multi-line text", () => {
    expect(stripLinkIcon("본문\n\n🔗 https://a.example\n▶ https://b.example")).toBe(
      "본문\n\nhttps://a.example\nhttps://b.example",
    );
  });

  it("leaves a bare url with no icon untouched", () => {
    expect(stripLinkIcon("https://fluxion.network/trade")).toBe("https://fluxion.network/trade");
  });
});

describe("emitXPaste link icons", () => {
  it("drops the icon before a trailing bare url", () => {
    const { segments } = emitXPaste("자세한 내용은 아래에서 확인하세요.\n🔗 https://fluxion.network/trade");
    expect(segments[0].text).toBe("자세한 내용은 아래에서 확인하세요.\nhttps://fluxion.network/trade");
  });

  it("applies to the typefully destination too", () => {
    const { segments } = emitXTypefully("🔗 https://fluxion.network/trade");
    expect(segments[0].text).toBe("https://fluxion.network/trade");
  });
});

/**
 * The rule is Telegram's, not every destination's. On X a bare `@handle` is already a link to the
 * profile, so spelling the url out beside it would be noise on the one channel that never needed it.
 */
describe("emitX and X handles", () => {
  it("leaves a bare handle exactly as written", () => {
    const text = "맨틀은 @OpenstockInc를 통해 제공합니다.";
    expect(emitXPaste(text).segments[0].text).toBe(text);
    expect(emitXTypefully(text).segments[0].text).toBe(text);
  });
});
