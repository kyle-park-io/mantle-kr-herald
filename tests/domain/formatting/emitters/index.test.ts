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
