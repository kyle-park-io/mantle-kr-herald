import { describe, it, expect } from "vitest";
import { emit, emitAll, DESTINATIONS_BY_CHANNEL } from "../../../../src/domain/formatting/emitters";
import { emitKakaoPaste } from "../../../../src/domain/formatting/emitters/kakao";
import { emitPrMail } from "../../../../src/domain/formatting/emitters/prMail";
import { emitTelegramBot, emitTelegramPaste } from "../../../../src/domain/formatting/emitters/telegram";
import { emitXPaste, emitXTypefully } from "../../../../src/domain/formatting/emitters/x";

describe("emit", () => {
  it("dispatches to the named destination", () => {
    expect(emit("**중요**", "telegram_bot")).toEqual(emitTelegramBot("**중요**"));
  });

  it("dispatches every destination to its own emitter", () => {
    const t = "**중요** [자세히](https://x.io)";
    expect(emit(t, "x_paste")).toEqual(emitXPaste(t));
    expect(emit(t, "x_typefully")).toEqual(emitXTypefully(t));
    expect(emit(t, "telegram_paste")).toEqual(emitTelegramPaste(t));
    expect(emit(t, "telegram_bot")).toEqual(emitTelegramBot(t));
    expect(emit(t, "kakao_paste")).toEqual(emitKakaoPaste(t));
    expect(emit(t, "pr_mail")).toEqual(emitPrMail(t));
  });
});

describe("emitAll", () => {
  it("returns only the destinations that apply to the channel", () => {
    expect(Object.keys(emitAll("본문", "telegram"))).toEqual(["telegram_paste", "telegram_bot"]);
    expect(Object.keys(emitAll("본문", "kakao"))).toEqual(["kakao_paste"]);
    expect(Object.keys(emitAll("본문", "x"))).toEqual(["x_paste", "x_typefully"]);
  });

  it("wires each destination to the correct emitter", () => {
    const t = "테스트";
    const result = emitAll(t, "kakao");
    expect(result.kakao_paste).toEqual(emitKakaoPaste(t));

    const telegramResult = emitAll(t, "telegram");
    expect(telegramResult.telegram_paste).toEqual(emitTelegramPaste(t));
  });
});

describe("emit strips media markers", () => {
  it("removes a photo marker from the delivered text", () => {
    const joined = emit("맨틀 소식\n\n![](https://img/a.jpg)", "telegram_bot").segments.map((s) => s.text).join("");
    expect(joined).toContain("맨틀 소식");
    expect(joined).not.toContain("![](");
  });

  it("does not count a stripped photo marker toward the length limit", () => {
    const body = "가".repeat(135); // ~270 weighted, under X's 280
    const withMarker = `${body}\n\n![](https://pbs.twimg.com/media/HOO5ibObIAArZVJ.png)`; // raw length > 280
    expect(emit(withMarker, "x_typefully").segments.some((s) => s.overLimit)).toBe(false);
  });

  it("removes a [영상] marker from the delivered text", () => {
    const joined = emit("영상 트윗\n\n[영상]", "telegram_bot").segments.map((s) => s.text).join("");
    expect(joined).toContain("영상 트윗");
    expect(joined).not.toContain("[영상]");
  });
});

describe("DESTINATIONS_BY_CHANNEL", () => {
  it("covers every channel", () => {
    expect(Object.keys(DESTINATIONS_BY_CHANNEL)).toEqual(["x", "telegram", "kakao", "pr_mail"]);
  });
});

describe("x weighted limit is configurable", () => {
  const longKo = "가".repeat(150); // 300 weighted — over 280, under 25000

  it("flags an over-280 x post at the default limit", () => {
    const seg = emit(longKo, "x_typefully").segments[0];
    expect(seg.limit).toBe(280);
    expect(seg.overLimit).toBe(true);
  });

  it("does not flag it when xMaxWeighted is 25000 (Premium)", () => {
    const seg = emit(longKo, "x_typefully", 25000).segments[0];
    expect(seg.limit).toBe(25000);
    expect(seg.overLimit).toBe(false);
  });

  it("a non-x destination ignores xMaxWeighted", () => {
    // telegram uses its own limit; passing xMaxWeighted must not change its result
    const a = emit("짧은 공지", "telegram_bot").segments;
    const b = emit("짧은 공지", "telegram_bot", 25000).segments;
    expect(b).toEqual(a);
  });
});
