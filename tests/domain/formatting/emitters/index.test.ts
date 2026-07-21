import { describe, it, expect } from "vitest";
import { emit, emitAll, DESTINATIONS_BY_CHANNEL } from "../../../../src/domain/formatting/emitters";
import { emitTelegramBot } from "../../../../src/domain/formatting/emitters/telegram";

describe("emit", () => {
  it("dispatches to the named destination", () => {
    expect(emit("**중요**", "telegram_bot")).toEqual(emitTelegramBot("**중요**"));
  });
});

describe("emitAll", () => {
  it("returns only the destinations that apply to the channel", () => {
    expect(Object.keys(emitAll("본문", "telegram"))).toEqual(["telegram_paste", "telegram_bot"]);
    expect(Object.keys(emitAll("본문", "kakao"))).toEqual(["kakao_paste"]);
    expect(Object.keys(emitAll("본문", "x"))).toEqual(["x_paste", "x_typefully"]);
  });
});

describe("DESTINATIONS_BY_CHANNEL", () => {
  it("covers every channel", () => {
    expect(Object.keys(DESTINATIONS_BY_CHANNEL)).toEqual(["x", "telegram", "kakao", "pr_mail"]);
  });
});
